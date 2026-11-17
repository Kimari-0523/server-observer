import {readIdentity,identityLabel} from './identity.js';
const enc = new TextEncoder();

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function signature(secret, timestamp) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${timestamp}\n${secret}`), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array()));
  return btoa(String.fromCharCode(...bytes));
}

export function formatAlertTime(seconds){if(!Number.isFinite(seconds)||seconds<=0)return '尚未收到';return new Date((seconds+28800)*1000).toISOString().slice(0,19).replace('T',' ')+'（北京时间 UTC+8）';}
export function alertCard(agent,state,{test=false}={}){
  const saved=readIdentity(agent.identity_json),identity=Object.keys(saved).length?saved:readIdentity(agent.current_identity_json),id=agent.agent_id||agent.id||'',fallback=agent.current_label||agent.label;
  const label=Object.keys(identity).length?identityLabel(identity,id):fallback&&fallback!=='新接入服务器'?fallback:'服务器 '+String(id).slice(-8),offline=state==='offline';
  const title=(identity.tags?.[0]||identity.hostname||label).slice(0,50);
  const lines=[`服务器：${label}`,`主机名：${identity.hostname||'尚未登记'}`,`公网 IPv4：${identity.public_ipv4||'未检测到'}`,`内网 IPv4：${identity.private_ipv4||'未检测到'}`,`状态：${offline?'心跳超时（至少 3 分钟未收到）':'心跳已恢复'}`,`最后心跳：${formatAlertTime(agent.last_seen)}`,`触发时间：${formatAlertTime(agent.created_at||Math.floor(Date.now()/1000))}`,`服务器 ID：${id}`];
  if(test)lines.unshift('这是告警标识修复测试，不是新增故障。');
  return {config:{wide_screen_mode:true},header:{template:test?'blue':offline?'red':'green',title:{tag:'plain_text',content:test?'告警标识验证 · '+title:(offline?'服务器失联 · ':'服务器已恢复 · ')+title}},elements:[{tag:'div',text:{tag:'plain_text',content:lines.join('\n')}}]};
}
export async function sendAlert(env, agent, state, options) {
  if (!env.FEISHU_WEBHOOK) throw new Error('Feishu webhook is missing');
  const url = new URL(env.FEISHU_WEBHOOK);
  if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) throw new Error('Invalid Feishu webhook');
  const timestamp = String(Math.floor(Date.now()/1000));
  const body = {msg_type:'interactive', card:alertCard(agent,state,options)};
  if(env.FEISHU_SECRET){body.timestamp=timestamp;body.sign=await signature(env.FEISHU_SECRET,timestamp);}
  const response = await fetch(url, {method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`Feishu HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 0 && result.StatusCode !== 0) throw new Error(`Feishu rejected message: ${result.code ?? result.StatusCode}`);
}

export async function checkAgents(env, now = Math.floor(Date.now()/1000)) {
  const {results} = await env.DB.prepare('SELECT id,label,identity_json,last_seen,alert_state FROM agents WHERE last_seen IS NOT NULL').all();
  for (const agent of results) {
    const state = now - agent.last_seen >= 180 ? 'offline' : 'online';
    if (state === agent.alert_state || (agent.alert_state === 'unknown' && state === 'online')) {
      if (agent.alert_state === 'unknown' && state === 'online') await env.DB.prepare('UPDATE agents SET alert_state = ? WHERE id = ? AND alert_state = ?').bind('online',agent.id,'unknown').run();
      continue;
    }
    // Atomically record the observed transition before sending. A heartbeat
    // received while Feishu is responding cannot erase the recovery event.
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO alert_outbox (id,agent_id,label,identity_json,state,last_seen,created_at) SELECT ?,id,label,identity_json,?,last_seen,? FROM agents WHERE id=? AND last_seen=? AND alert_state=?').bind(id,state,now,agent.id,agent.last_seen,agent.alert_state),
      env.DB.prepare('UPDATE agents SET alert_state=? WHERE id=? AND last_seen=? AND alert_state=?').bind(state,agent.id,agent.last_seen,agent.alert_state)
    ]);
  }
  const pending = await env.DB.prepare('SELECT o.*,a.identity_json AS current_identity_json,a.label AS current_label FROM alert_outbox o LEFT JOIN agents a ON a.id=o.agent_id WHERE o.delivered_at IS NULL ORDER BY o.created_at,o.id LIMIT 20').all();
  const blocked = new Set();
  for (const item of pending.results) {
    if (blocked.has(item.agent_id)) continue;
    try {
      await sendAlert(env,item,item.state);
      await env.DB.prepare('UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1 WHERE id=?').bind(now,item.id).run();
    } catch (error) {
      blocked.add(item.agent_id);
      await env.DB.prepare('UPDATE alert_outbox SET attempts=attempts+1 WHERE id=?').bind(item.id).run();
      console.error('alert delivery failed',item.agent_id,String(error));
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/heartbeat') return new Response('Not found',{status:404});
    const auth = request.headers.get('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(auth);
    const id = request.headers.get('x-agent-id') || '';
    if (!match || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) return new Response('Unauthorized',{status:401});
    const tokenHash = await sha256(match[1]);
    const result = await env.DB.prepare('UPDATE agents SET last_seen = ?, last_ip = ? WHERE id = ? AND token_hash = ?').bind(Math.floor(Date.now()/1000),request.headers.get('cf-connecting-ip'),id,tokenHash).run();
    if (!result.meta.changes) return new Response('Unauthorized',{status:401});
    return new Response(null,{status:204,headers:{'cache-control':'no-store','x-observed-ip':request.headers.get('cf-connecting-ip')||''}});
  },
  async scheduled(_event,env,ctx) { ctx.waitUntil(checkAgents(env)); }
};

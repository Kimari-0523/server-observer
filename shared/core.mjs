import {isIP} from 'node:net';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {saveReport,compact} from './store.mjs';
import {normalizeTags} from '../backend/tags.mjs';
import {MaintenanceSessions} from '../backend/maintenance.mjs';
import {CommandService} from '../backend/commands.mjs';
import {AssistantService} from '../backend/assistant.mjs';
import {normalizeIPOverrides} from '../backend/ip-overrides.mjs';

import {Auth,Settings} from './auth.mjs';
import {callModel,approvalContext} from './model-client.js';
import watchdog,{checkAgents} from './index.js';
import {readAISettings,saveAISettings} from './ai-settings.js';
import {readNotifications,saveNotifications} from './notifications.js';
import {d1Adapter} from './d1-adapter.mjs';
import {initialIdentity,identityLabel,syncReportIdentity,syncIdentityEdit} from './identity.js';
import {mergeHeartbeats} from './server-view.js';
export function createCore({db,env,assets,transportFactory}){
const process={env};
const origin=env.PUBLIC_ORIGIN;
const settings=new Settings(db,env.APP_KEY);
const notificationEnv={...env,DB:d1Adapter(db)};
const asset=(path)=>{const value=assets[path];if(!value)throw Object.assign(Error('Asset not found'),{status:404});return value.encoding==='base64'?Buffer.from(value.body,'base64'):value.body.replaceAll('__PUBLIC_ORIGIN__',origin);};
const attempts=new Map();
const hash=s=>createHash('sha256').update(s).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const now=()=>Math.floor(Date.now()/1000);
const passwordHash=()=>process.env.MAINTENANCE_PASSWORD_HASH||db.prepare("SELECT value FROM settings WHERE key='maintenance_password_hash'").get()?.value;
function error(code,message){throw Object.assign(new Error(message),{status:code});}
async function body(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>262144)error(413,'请求过大');parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString());}catch{error(400,'无效 JSON');}}
function actor(req){return auth.actor(req);}
let remote,commands,assistant;
const maintenance=new MaintenanceSessions(key=>{remote?.revoke(key);commands?.revoke(key);assistant?.revoke(key);});
function maintain(req){const s=actor(req),key=maintenance.key(req.headers['x-maintenance-token'],s.id);if(!key)error(403,'请先输入维护密码');return {...s,maintenance_key:key};}
function audit(user,action,detail){db.prepare('INSERT INTO audit VALUES(?,?,?,?)').run(now(),user,action,JSON.stringify(detail));}

const handler=async(req,res)=>{
  const url=new URL(req.url,origin),p=url.pathname;
  function reply(code,value,headers={}){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...headers});res.end(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));return true;}
  try {
    if(!['GET','HEAD'].includes(req.method)&&!p.startsWith('/agent/')&&p!=='/heartbeat'&&!p.startsWith('/api/ai/v1/')&&req.headers.origin!==origin)error(403,'请求来源不符');
    if(p==='/heartbeat'){const response=await watchdog.fetch(new Request(origin+'/heartbeat',{method:req.method,headers:req.headers}),notificationEnv);return reply(response.status,await response.text());}
    if(p.startsWith('/auth/')){if(await auth.route(req,url,body,reply))return;}
    if(p==='/api/settings/auth'){maintain(req);auth.admin(req);if(req.method==='GET')return reply(200,auth.inspect());if(req.method==='POST')return reply(200,auth.save(await body(req)));error(405,'不支持的方法');}
    if(p==='/api/settings/ai'){maintain(req);const current=await readAISettings(notificationEnv);if(req.method==='GET')return reply(200,{base_url:current.base_url,model:current.model,api_key_configured:!!current.api_key});if(req.method==='POST'){const b=await body(req);await saveAISettings(notificationEnv,{base_url:b.base_url,model:b.model,api_key:b.clear_api_key?'':b.api_key||current.api_key});return reply(200,{ok:true});}error(405,'不支持的方法');}
    if(p==='/api/settings/notifications'){maintain(req);const current=await readNotifications(notificationEnv);if(req.method==='GET')return reply(200,{configured:!!current.webhook,webhook_masked:current.webhook?'已配置 · '+current.webhook.slice(-6):'',signature_configured:!!current.secret});if(req.method==='POST'){const b=await body(req);await saveNotifications(notificationEnv,{webhook:b.webhook||current.webhook,secret:b.clear_signature?'':b.secret||current.secret});return reply(200,{ok:true});}error(405,'不支持的方法');}
    if(p==='/api/assistant/chat'&&req.method==='POST'){const user=maintain(req),input=await body(req);let prepared;try{prepared=assistant.prepare(input.session_id,user,input);if(prepared.skip)return reply(200,prepared.state);const settings=await readAISettings(notificationEnv);const state=assistant.snapshot(assistant.get(input.session_id,user));prepared.messages=approvalContext(prepared.messages,state.jobs);const message=await callModel(settings,prepared);return reply(200,assistant.complete(input.session_id,user,{nonce:prepared.nonce,message}));}catch(e){if(prepared?.nonce){const state=assistant.get(input.session_id,user);assistant.abort(state,prepared.nonce,e.public_error||e.http_status?e.message:'模型请求失败，请检查设置');}throw Object.assign(Error(e.public_error||e.http_status?e.message:e.status?e.message:'模型请求失败，请检查设置'),{status:e.status||502});}}
    if(p==='/healthz')return reply(200,{status:'ok',database:db.prepare('SELECT 1 n').get().n});
    if(p==='/api/assistant/sessions'&&req.method==='POST')return reply(201,assistant.create(maintain(req),await body(req)));
    const assistantPublic=/^\/api\/assistant\/sessions\/([a-f0-9-]{36})(?:\/(stop|close))?$/.exec(p);
    if(assistantPublic){const user=maintain(req);if(!assistantPublic[2]&&req.method==='GET')return reply(200,assistant.snapshot(assistant.get(assistantPublic[1],user)));if(assistantPublic[2]&&req.method==='POST')return reply(200,assistant.stop(assistantPublic[1],user,assistantPublic[2]==='close'));}
    if(p.startsWith('/api/ai/v1/')){
      const g=commands.authenticate(req.headers.authorization);
      if(p==='/api/ai/v1/servers'&&req.method==='GET')return reply(200,commands.servers(g));
      if(p==='/api/ai/v1/commands'&&req.method==='POST')return reply(202,commands.submit(g,await body(req)));
      const command=/^\/api\/ai\/v1\/commands\/([a-f0-9-]{36})(\/cancel)?$/.exec(p);
      if(command&&!command[2]&&req.method==='GET')return reply(200,commands.result(command[1],g));
      if(command&&command[2]&&req.method==='POST')return reply(200,commands.cancel(command[1],g));
      return reply(404,{error:'未找到 AI 接口'});
    }
    if(p==='/api/ai/grants'){const user=maintain(req);if(req.method==='GET')return reply(200,commands.listGrants(user));if(req.method==='POST')return reply(201,commands.createGrant(user,await body(req)));}
    const revokeGrant=/^\/api\/ai\/grants\/([a-f0-9-]{36})\/revoke$/.exec(p);
    if(revokeGrant&&req.method==='POST'){commands.revokeGrant(revokeGrant[1],maintain(req));return reply(200,{ok:true});}
    if(p==='/api/commands'&&req.method==='GET')return reply(200,commands.list(maintain(req)));
    const commandAdmin=/^\/api\/commands\/([a-f0-9-]{36})(?:\/(approve|reject|cancel))?$/.exec(p);
    if(commandAdmin){const user=maintain(req);if(commandAdmin[2]&&req.method==='POST')return reply(200,commands.decide(commandAdmin[1],commandAdmin[2],user));if(!commandAdmin[2]&&req.method==='GET')return reply(200,commands.result(commandAdmin[1]));}
    if(p==='/agent/enroll'&&req.method==='POST'){
      const b=await body(req);if(typeof b.token!=='string'||typeof b.identity!=='string'||b.identity.length>256)error(400,'接入信息无效');
      const enrollment=db.prepare('DELETE FROM enrollment WHERE token_hash=? AND expires>? RETURNING token_hash').get(hash(b.token),now());
      if(!enrollment)error(401,'接入令牌无效或过期');
      const identity=hash(b.identity),existing=db.prepare('SELECT id FROM servers WHERE identity_hash=?').get(identity);if(existing)error(409,'该机器已经接入，请撤销旧凭据后重装');
      const id=secret(),token=secret();db.prepare('INSERT INTO servers(id,identity_hash,token_hash,name,platform) VALUES(?,?,?,?,?)').run(id,identity,hash(token),String(b.name||'未命名').slice(0,100),String(b.platform||'unknown').slice(0,40));
      const watchdogToken=secret(),identityInfo=initialIdentity(b.name);db.prepare('INSERT INTO agents(id,label,identity_json,token_hash,last_seen) VALUES(?,?,?,?,?)').run(id,identityLabel(identityInfo,id),JSON.stringify(identityInfo),hash(watchdogToken),now());
      return reply(201,{id,token,report_interval_seconds:Number(env.REPORT_INTERVAL_SECONDS)||60,watchdog:{url:origin+'/heartbeat',id,token:watchdogToken}});
    }
    if(p==='/agent/report'&&req.method==='POST'){
      const id=req.headers['x-agent-id'],token=req.headers.authorization?.replace(/^Bearer /,'');
      const agent=db.prepare('SELECT id FROM servers WHERE id=? AND token_hash=?').get(String(id||''),hash(token||''));if(!agent)error(401,'Agent 身份无效');
      const b=await body(req);if(!b.metrics||typeof b.metrics!=='object'||Array.isArray(b.metrics))error(400,'指标无效');
      if(Object.values(b.metrics).some(v=>typeof v!=='number'||!Number.isFinite(v)))error(400,'指标必须为有限数字');
      if(!Array.isArray(b.private_ips)||b.private_ips.length>1024||b.private_ips.some(v=>typeof v!=='string'||v.length>64))error(400,'IP 列表无效');
      const publicIp=isIP(b.public_ipv4||'')===4?b.public_ipv4:null;
      saveReport(db,agent.id,b,publicIp);await syncReportIdentity(notificationEnv,agent.id,b);return reply(200,{ok:true});
    }
    if(assets[p])return reply(200,asset(p),{'content-type':assets[p].type,'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"});
    if(p==='/api/me'){const s=actor(req);return reply(200,{name:s.name,admin:!!s.local,maintenance:!!maintenance.key(req.headers['x-maintenance-token'],s.id),password_configured:!!passwordHash()});}
    if(p==='/api/maintenance/authorize'){maintain(req);return reply(200,{ok:true});}
    if(p==='/api/lock'&&req.method==='POST'){const s=actor(req),b=await body(req);maintenance.revoke(req.headers['x-maintenance-token']||b.token,s.id);return reply(200,{ok:true});}
    if(p==='/api/unlock'&&req.method==='POST'){
      const s=actor(req),b=await body(req),a=attempts.get(s.id)||{count:0,until:now()+600};if(a.until<now()){a.count=0;a.until=now()+600;}if(a.count>=5)error(429,'请稍后重试');a.count++;attempts.set(s.id,a);
      const [salt,digest]=(passwordHash()||'').split(':');if(!salt||!digest)error(503,'维护密码尚未配置');
      if(typeof b.password!=='string'||b.password.length>256)error(400,'密码无效');
      const expected=Buffer.from(digest,'hex'),got=scryptSync(String(b.password||''),salt,64);if(expected.length!==got.length||!timingSafeEqual(expected,got))error(403,'维护密码错误');
      attempts.delete(s.id);maintenance.revoke(req.headers['x-maintenance-token'],s.id);const token=maintenance.create(s.id);audit(s.id,'unlock',{});return reply(200,{ok:true,token});
    }
    if(p==='/api/enrollment'&&req.method==='POST'){const s=maintain(req),token=secret();db.prepare('INSERT INTO enrollment VALUES(?,?)').run(hash(token),now()+600);audit(s.id,'enrollment',{});return reply(201,{token,expires:now()+600});}
    if(p==='/api/servers'){actor(req);return reply(200,mergeHeartbeats(db.prepare('SELECT id,name,platform,last_seen,public_ip,private_ips,latest,tags_json,ip_overrides FROM servers ORDER BY name').all().map(v=>({...v,ip_overrides:JSON.parse(v.ip_overrides),remote:remote.status(v.id),tags:JSON.parse(v.tags_json),tags_json:undefined,private_ips:JSON.parse(v.private_ips),latest:JSON.parse(v.latest||'null')})),db.prepare('SELECT id,last_seen FROM agents').all()));}
    const ipRoute=/^\/api\/servers\/([A-Za-z0-9_-]+)\/ip-overrides$/.exec(p);
    if(ipRoute&&req.method==='POST'){const user=maintain(req),ips=normalizeIPOverrides(await body(req));const result=db.prepare('UPDATE servers SET ip_overrides=? WHERE id=?').run(JSON.stringify(ips),ipRoute[1]);if(!result.changes)error(404,'服务器不存在');audit(user.id,'server_ip_override',{server:ipRoute[1],ips});await syncIdentityEdit(notificationEnv,ipRoute[1],'ip-overrides',ips);return reply(200,ips);}
    const terminal=/^\/api\/servers\/([A-Za-z0-9_-]+)\/terminal-ticket$/.exec(p);
    if(terminal&&req.method==='POST'){const s=maintain(req);return reply(201,remote.ticket(terminal[1],s));}
    const tagsRoute=/^\/api\/servers\/([A-Za-z0-9_-]+)\/tags$/.exec(p);
    if(tagsRoute&&req.method==='POST'){const s=maintain(req),b=await body(req),tags=normalizeTags(b.tags);const result=db.prepare('UPDATE servers SET tags_json=? WHERE id=?').run(JSON.stringify(tags),tagsRoute[1]);if(!result.changes)error(404,'服务器不存在');audit(s.id,'server_tags',{server:tagsRoute[1],tags});await syncIdentityEdit(notificationEnv,tagsRoute[1],'tags',{tags});return reply(200,{tags});}
    const history=/^\/api\/servers\/([A-Za-z0-9_-]+)\/history$/.exec(p);
    if(history){actor(req);const days=Math.min(365,Math.max(1,Number(url.searchParams.get('days'))||1));return reply(200,db.prepare('SELECT t,resolution,payload FROM samples WHERE server_id=? AND t>=? ORDER BY t').all(history[1],now()-days*86400).map(v=>({...v,metrics:JSON.parse(v.payload),payload:undefined})));}
    reply(404,{error:'未找到'});
  }catch(e){reply(e.status||500,{error:e.status?e.message:'服务内部错误'});if(!e.status)console.error(e);}
};
const auth=new Auth({db,env,settings,origin,onLogout:user=>{for(const [key,value]of maintenance.sessions)if(value.user===user){maintenance.sessions.delete(key);maintenance.onRevoke(key);}}});
remote=transportFactory({db,actor,maintenance,origin,audit,onCommand:(id,message)=>commands.message(id,message),onDisconnect:id=>commands.disconnected(id)});
commands=new CommandService({db,maintenance,transport:remote,audit});
assistant=new AssistantService({commands,db,maintenance,audit});
async function fetchRequest(request,clientIP='unknown'){
 const headers=Object.fromEntries(request.headers);const req={method:request.method,url:request.url,headers,socket:{remoteAddress:clientIP},async *[Symbol.asyncIterator](){if(request.body){const reader=request.body.getReader();try{for(;;){const part=await reader.read();if(part.done)break;yield Buffer.from(part.value);}}finally{reader.releaseLock();}}}};
 let response,status=200,outHeaders={};const res={writeHead(code,h){status=code;outHeaders=h;},end(value){response=new Response([204,205,304].includes(status)?null:value,{status,headers:outHeaders});}};await handler(req,res);return response;
}
let lastCompact=0,checking=false;async function cron(){if(checking)return;checking=true;try{auth.prune();if(Date.now()-lastCompact>3600000){compact(db);commands.prune();db.prepare('DELETE FROM audit WHERE t<?').run(now()-30*86400);db.prepare('DELETE FROM alert_outbox WHERE delivered_at IS NOT NULL AND created_at<?').run(now()-90*86400);lastCompact=Date.now();}const notifications=await readNotifications(notificationEnv);if(notifications.webhook)await checkAgents({...notificationEnv,FEISHU_WEBHOOK:notifications.webhook,FEISHU_SECRET:notifications.secret});}finally{checking=false;}}
return {fetch:fetchRequest,remote,actor,maintenance,commands,assistant,cron,auth,close(){remote.close?.();for(const [key]of maintenance.sessions){maintenance.sessions.delete(key);maintenance.onRevoke(key);}}};
}

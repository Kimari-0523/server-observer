import {createHash,randomBytes,randomUUID} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const now=()=>Math.floor(Date.now()/1000);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const activeStates=['pending','dispatching','running'];
export class CommandService{
  constructor({db,maintenance,transport,audit}){
    Object.assign(this,{db,maintenance,transport,audit});this.grants=new Map();this.running=new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,request_id TEXT NOT NULL,owner TEXT NOT NULL,server_id TEXT NOT NULL,shell TEXT NOT NULL,command TEXT NOT NULL,timeout_seconds INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,approved_by TEXT,stdout TEXT NOT NULL DEFAULT '',stderr TEXT NOT NULL DEFAULT '',exit_code INTEGER,error TEXT,output_truncated INTEGER NOT NULL DEFAULT 0,UNIQUE(grant_id,request_id)); CREATE INDEX IF NOT EXISTS command_status ON commands(status,created_at);`);
    db.prepare("UPDATE commands SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE 'unknown' END,finished_at=?,error='后端重新启动，授权已撤销；未自动重试' WHERE status IN ('pending','dispatching','running')").run(now());
    db.prepare('DELETE FROM commands WHERE created_at<?').run(now()-30*86400);
  }
  assertMaintenance(user){if(!user?.maintenance_key||!this.maintenance.active(user.maintenance_key,user.id))fail(403,'请先输入维护密码');}
  publicGrant(g){return {id:g.id,label:g.label,server_ids:g.servers,mode:g.mode,created_at:g.created_at};}
  createGrant(user,input){
    this.assertMaintenance(user);
    if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'授权参数必须为 JSON 对象');
    if(!['manual','auto'].includes(input.mode))fail(400,'请选择人工确认或自动执行');
    if(!Array.isArray(input.server_ids)||!input.server_ids.length||input.server_ids.length>50||input.server_ids.some(id=>typeof id!=='string'))fail(400,'请选择授权服务器');
    const servers=[...new Set(input.server_ids)];for(const id of servers){const server=this.db.prepare('SELECT platform FROM servers WHERE id=?').get(id);if(!server||!['linux','win32'].includes(server.platform))fail(400,'服务器不存在或不支持命令执行');}
    const label=typeof input.label==='string'?input.label.trim():'AI 操作';if(!label||[...label].length>60||/[\x00-\x1f]/.test(label))fail(400,'授权名称无效');
    if([...this.grants.values()].filter(g=>g.key===user.maintenance_key).length>=10)fail(429,'当前网页最多创建 10 个 AI 授权');
    const token='so_ai_'+randomBytes(32).toString('base64url'),g={id:randomUUID(),key:user.maintenance_key,owner:user.id,servers,mode:input.mode,label,created_at:now(),minute:now(),requests:0};this.grants.set(hash(token),g);this.audit(user.id,'ai_grant_created',{grant:g.id,mode:g.mode,servers});return {...this.publicGrant(g),token};
  }
  authenticate(authorization){const match=/^Bearer (so_ai_[A-Za-z0-9_-]{43})$/.exec(authorization||'');const g=match?this.grants.get(hash(match[1])):null;if(!g||!this.maintenance.active(g.key,g.owner))fail(401,'AI 授权无效，请先在网页完成维护验证并创建授权');return g;}
  listGrants(user){this.assertMaintenance(user);return [...this.grants.values()].filter(g=>g.key===user.maintenance_key).map(g=>this.publicGrant(g));}
  grantById(id){return [...this.grants.values()].find(g=>g.id===id);}
  revokeGrant(id,user){this.assertMaintenance(user);const g=this.grantById(id);if(!g||g.key!==user.maintenance_key)fail(404,'授权不存在');this.removeGrant(g);this.audit(user.id,'ai_grant_revoked',{grant:id});}
  removeGrant(g){for(const[k,v]of this.grants)if(v.id===g.id)this.grants.delete(k);for(const row of this.db.prepare("SELECT * FROM commands WHERE grant_id=? AND status IN ('pending','dispatching','running')").all(g.id))this.stop(row,'cancelled','维护授权已结束');}
  revoke(key){for(const g of [...this.grants.values()])if(g.key===key)this.removeGrant(g);}
  servers(g){return g.servers.map(id=>this.db.prepare('SELECT id,name,platform,public_ip,latest,ip_overrides FROM servers WHERE id=?').get(id)).filter(Boolean).map(s=>{const latest=JSON.parse(s.latest||'null'),ips=JSON.parse(s.ip_overrides);return {id:s.id,name:s.name,platform:s.platform,public_ipv4:ips.public_ipv4||(Object.hasOwn(latest||{},'public_ipv4')?latest.public_ipv4:s.public_ip),private_ipv4:ips.private_ipv4||latest?.private_ipv4||null,commands_available:this.transport.status(s.id).commands===true};});}
  row(id){const row=this.db.prepare('SELECT * FROM commands WHERE id=?').get(id);if(!row)fail(404,'命令不存在');return row;}
  result(id,g){const row=this.row(id);if(g&&row.grant_id!==g.id)fail(404,'命令不存在');const live=this.running.get(id);return {...row,...(live?{stdout:live.stdout,stderr:live.stderr,output_truncated:live.truncated?1:0}:{})};}
  list(user){this.assertMaintenance(user);return this.db.prepare('SELECT id,grant_id,owner,server_id,shell,command,timeout_seconds,mode,status,created_at,started_at,finished_at,approved_by,exit_code,error,output_truncated FROM commands ORDER BY created_at DESC,rowid DESC LIMIT 50').all();}
  submit(g,input){
    if(!this.maintenance.active(g.key,g.owner))fail(401,'维护授权已结束');
    if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'命令参数必须为 JSON 对象');
    if('mode' in input||'shell' in input)fail(400,'执行模式和 Shell 由授权与服务器系统决定');
    const {server_id,command,request_id}=input,timeout=input.timeout_seconds??60;
    if(!g.servers.includes(server_id))fail(403,'此令牌没有目标服务器的权限');
    if(typeof command!=='string'||!command.trim()||Buffer.byteLength(command)>16384||command.includes('\0'))fail(400,'命令必须为 1–16384 字节的非空文本');
    if(typeof request_id!=='string'||! /^[A-Za-z0-9_.:-]{1,80}$/.test(request_id))fail(400,'request_id 必填，须为最多 80 个英文、数字或 . _ : - 字符');
    if(!Number.isInteger(timeout)||timeout<1||timeout>300)fail(400,'超时时间须为 1–300 秒');
    const existing=this.db.prepare('SELECT * FROM commands WHERE grant_id=? AND request_id=?').get(g.id,request_id);if(existing){if(existing.server_id!==server_id||existing.command!==command||existing.timeout_seconds!==timeout)fail(409,'同一 request_id 不能用于不同命令');return this.result(existing.id,g);}
    if(now()-g.minute>=60){g.minute=now();g.requests=0;}if(++g.requests>60)fail(429,'每个授权每分钟最多提交 60 条命令');
    if(!this.transport.status(server_id).commands)fail(409,'目标 Agent 命令通道未连接，请更新 Agent');
    if(g.mode==='auto')this.checkCapacity(server_id);
    if(this.db.prepare("SELECT count(*) n FROM commands WHERE status='pending'").get().n>=200)fail(429,'待确认命令过多，请先处理');
    const server=this.db.prepare('SELECT platform FROM servers WHERE id=?').get(server_id),id=randomUUID();
    this.db.prepare("INSERT INTO commands(id,grant_id,request_id,owner,server_id,shell,command,timeout_seconds,mode,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)").run(id,g.id,request_id,g.owner,server_id,server.platform==='win32'?'powershell':'bash',command,timeout,g.mode,now());
    this.audit(g.owner,'ai_command_submitted',{command_id:id,server:server_id,mode:g.mode,command_hash:hash(command)});
    if(g.mode==='auto')this.dispatch(this.row(id),g.owner);return this.result(id,g);
  }
  checkCapacity(server){if([...this.running.values()].filter(v=>v.server===server).length>=2)fail(409,'此服务器已有两个命令正在执行，请稍后提交或确认');}
  dispatch(row,approver){
    const g=this.grantById(row.grant_id);if(!g||!this.maintenance.active(g.key,g.owner))fail(403,'原维护授权已结束，不能执行');
    if(!this.transport.status(row.server_id).commands)fail(409,'目标 Agent 命令通道未连接');this.checkCapacity(row.server_id);
    const changed=this.db.prepare("UPDATE commands SET status='dispatching',approved_by=?,started_at=? WHERE id=? AND status='pending'").run(approver,now(),row.id);if(!changed.changes)fail(409,'此命令已经处理，不能重复执行');
    const live={server:row.server_id,stdout:'',stderr:'',bytes:0,truncated:false};this.running.set(row.id,live);
    live.timer=setTimeout(()=>this.stop(this.row(row.id),'timed_out','命令超时，已请求终止'),(row.timeout_seconds+10)*1000);live.timer.unref?.();
    if(!this.transport.sendCommand(row.server_id,{type:'command-run',command_id:row.id,command:row.command,shell:row.shell,timeout_seconds:row.timeout_seconds}))this.finish(row.id,'unknown',null,'发送时连接中断，执行结果未知；未自动重试');
    this.audit(approver,'ai_command_dispatched',{command_id:row.id,server:row.server_id,mode:row.mode});
  }
  decide(id,action,user){this.assertMaintenance(user);const row=this.row(id);if(action==='approve'){if(row.status!=='pending')fail(409,'命令已经处理');this.dispatch(row,user.id);}else if(action==='reject'){if(row.status!=='pending')fail(409,'仅待确认命令可拒绝');this.stop(row,'rejected','维护人员拒绝执行');this.audit(user.id,'ai_command_rejected',{command_id:id});}else if(action==='cancel'){this.stop(row,'cancelled','维护人员取消命令');this.audit(user.id,'ai_command_cancelled',{command_id:id});}return this.result(id);}
  cancel(id,g){const row=this.row(id);if(row.grant_id!==g.id)fail(404,'命令不存在');this.stop(row,'cancelled','AI 客户端取消命令');this.audit(g.owner,'ai_command_cancelled',{command_id:id});return this.result(id,g);}
  stop(row,status,reason){if(!activeStates.includes(row.status))return;if(row.status!=='pending')this.transport.sendCommand(row.server_id,{type:'command-cancel',command_id:row.id});this.finish(row.id,status,null,reason);}
  finish(id,status,exitCode,error){const row=this.row(id);if(!activeStates.includes(row.status))return;const live=this.running.get(id);clearTimeout(live?.timer);this.db.prepare('UPDATE commands SET status=?,finished_at=?,stdout=?,stderr=?,exit_code=?,error=?,output_truncated=? WHERE id=?').run(status,now(),live?.stdout||row.stdout,live?.stderr||row.stderr,exitCode,error||null,live?.truncated?1:row.output_truncated,id);this.running.delete(id);this.audit(row.owner,'ai_command_finished',{command_id:id,status,exit_code:exitCode});}
  message(server,m){
    const live=this.running.get(m.command_id);if(!live||live.server!==server)return;
    if(m.type==='command-started')this.db.prepare("UPDATE commands SET status='running' WHERE id=? AND status='dispatching'").run(m.command_id);
    else if(m.type==='command-data'&&['stdout','stderr'].includes(m.stream)&&typeof m.data==='string'&&m.data.length<=16384){const raw=Buffer.from(m.data),room=Math.max(0,65536-live.bytes);live[m.stream]+=raw.subarray(0,room).toString('utf8');live.bytes+=Math.min(raw.length,room);if(raw.length>room)live.truncated=true;}
    else if(m.type==='command-result'&&['succeeded','failed','timed_out','cancelled'].includes(m.status)){if(m.output_truncated===true)live.truncated=true;const exit=Number.isInteger(m.exit_code)?m.exit_code:null;this.finish(m.command_id,m.status==='succeeded'&&exit!==0?'failed':m.status,exit,typeof m.error==='string'?m.error.slice(0,512):null);}
  }
  disconnected(server){for(const[id,live]of this.running)if(live.server===server)this.finish(id,'unknown',null,'Agent 通道断开，执行结果未知；未自动重试');}
  prune(){this.db.prepare("DELETE FROM commands WHERE created_at<? AND status NOT IN ('pending','dispatching','running')").run(now()-30*86400);}
}

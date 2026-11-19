import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {serverHealth} from '../web/health.js';
const hash=v=>createHash('sha256').update(v).digest('hex'),now=()=>Math.floor(Date.now()/1000);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const activeStates=['pending','dispatching','running'];
export class CommandService{
 constructor({db,maintenance,transport,audit}){
  Object.assign(this,{db,maintenance,transport,audit});this.grants=new Map();this.running=new Map();this.rates=new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,request_id TEXT NOT NULL,owner TEXT NOT NULL,server_id TEXT NOT NULL,shell TEXT NOT NULL,command TEXT NOT NULL,timeout_seconds INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,approved_by TEXT,stdout TEXT NOT NULL DEFAULT '',stderr TEXT NOT NULL DEFAULT '',exit_code INTEGER,error TEXT,output_truncated INTEGER NOT NULL DEFAULT 0,UNIQUE(grant_id,request_id)); CREATE INDEX IF NOT EXISTS command_status ON commands(status,created_at);
   CREATE TABLE IF NOT EXISTS ai_grants(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,owner_name TEXT NOT NULL,label TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'all',created_at INTEGER NOT NULL,last_used_at INTEGER,revoked_at INTEGER);
   CREATE TABLE IF NOT EXISTS ai_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,t INTEGER NOT NULL,actor TEXT NOT NULL,actor_name TEXT NOT NULL,action TEXT NOT NULL,server_id TEXT,command_id TEXT,grant_id TEXT,detail TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS ai_audit_server ON ai_audit(server_id,seq);`);
  const columns=db.prepare('PRAGMA table_info(commands)').all().map(c=>c.name);
  for(const name of ['created_name','approved_name','approved_source','approved_client','confirmation_detail'])if(!columns.includes(name))db.exec('ALTER TABLE commands ADD COLUMN '+name+' TEXT');
  if(!columns.includes('confirmation_channel'))db.exec("ALTER TABLE commands ADD COLUMN confirmation_channel TEXT NOT NULL DEFAULT 'web'");
  for(const row of db.prepare("SELECT * FROM commands WHERE status IN ('pending','dispatching','running')").all()){
   if(row.status==='pending'&&this.grantById(row.grant_id)?.persistent)continue;
   this.finish(row.id,row.status==='pending'?'cancelled':'unknown',null,'后端重新启动，未自动重试；执行结果须人工核对');
  }
 }
 assertMaintenance(user){if(!user?.maintenance_key||!this.maintenance.active(user.maintenance_key,user.id))fail(403,'请先输入维护密码');}
 event(actor,action,detail={}){
  const id=typeof actor==='string'?actor:actor.id,name=typeof actor==='string'?actor:actor.name||actor.id;
  const record=this.db.prepare('INSERT INTO ai_audit(t,actor,actor_name,action,server_id,command_id,grant_id,detail) VALUES(?,?,?,?,?,?,?,?)').run(now(),id,name,action,detail.server??null,detail.command_id??null,detail.grant??null,JSON.stringify(detail));
  this.audit(id,action,{audit_id:Number(record.lastInsertRowid),actor_name:name,...detail});
 }
 ids(g){return g.persistent?this.db.prepare('SELECT id FROM servers ORDER BY id').all().map(r=>r.id):g.servers;}
 publicGrant(g){return {id:g.id,label:g.label,server_ids:this.ids(g),scope:g.persistent?'all':'selected',mode:'manual',confirmation_channel:g.persistent?'client':'web',persistent:!!g.persistent,created_by:g.owner,created_by_name:g.owner_name||g.owner,created_at:g.created_at,last_used_at:g.last_used_at??null};}
 validateLabel(input){const label=typeof input?.label==='string'?input.label.trim():'';if(!label||[...label].length>60||/[\x00-\x1f]/.test(label))fail(400,'请填写 1–60 字的授权名称');return label;}
 createGrant(user,input){
  this.assertMaintenance(user);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['label','mode','scope'].includes(k)))fail(400,'请使用新版授权表单：全部服务器、人工确认');
  if(input.mode&&input.mode!=='manual'||input.scope&&input.scope!=='all')fail(400,'AI 命令必须人工确认，长期授权读取全部服务器');
  const label=this.validateLabel(input);
  if(this.db.prepare('SELECT count(*) n FROM ai_grants WHERE revoked_at IS NULL').get().n>=100)fail(429,'有效授权过多，请先撤销不再使用的授权');
  const token='so_ai_'+randomBytes(32).toString('base64url'),g={id:randomUUID(),owner:user.id,owner_name:user.name||user.id,label,created_at:now(),persistent:true,mode:'manual',scope:'all',servers:[]};
  this.transaction(()=>{this.db.prepare('INSERT INTO ai_grants(id,token_hash,owner,owner_name,label,created_at) VALUES(?,?,?,?,?,?)').run(g.id,hash(token),g.owner,g.owner_name,label,g.created_at);this.event(user,'ai_grant_created',{grant:g.id,label,scope:'all',mode:'manual',persistent:true});});return {...this.publicGrant(g),token};
 }
 transaction(fn){if(typeof this.db.transaction==='function')return this.db.transaction(fn);this.db.exec('BEGIN');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 createSessionGrant(user,input){
  this.assertMaintenance(user);if(input?.mode!=='manual')fail(400,'所有 AI 命令均需人工确认');
  if(!Array.isArray(input.server_ids)||!input.server_ids.length||input.server_ids.length>50||input.server_ids.some(id=>typeof id!=='string'))fail(400,'请选择授权服务器');
  const servers=[...new Set(input.server_ids)];for(const id of servers){const row=this.db.prepare('SELECT platform FROM servers WHERE id=?').get(id);if(!row||!['linux','win32'].includes(row.platform))fail(400,'服务器不存在或不支持命令执行');}
  if([...this.grants.values()].filter(g=>g.key===user.maintenance_key).length>=10)fail(429,'当前网页对话过多');
  const g={id:randomUUID(),key:user.maintenance_key,owner:user.id,owner_name:user.name||user.id,servers,mode:'manual',label:this.validateLabel(input),created_at:now(),persistent:false};this.grants.set(g.id,g);this.event(user,'ai_session_created',{grant:g.id,servers,mode:'manual'});return this.publicGrant(g);
 }
 authenticate(authorization){
  const match=/^Bearer (so_ai_[A-Za-z0-9_-]{43})$/.exec(authorization||''),g=match?this.fromRow(this.db.prepare('SELECT * FROM ai_grants WHERE token_hash=? AND revoked_at IS NULL').get(hash(match[1]))):null;
  if(!g)fail(401,'AI 授权无效或已撤销，请在网页创建长期授权');if(!g.last_used_at||now()-g.last_used_at>=60)this.db.prepare('UPDATE ai_grants SET last_used_at=? WHERE id=?').run(now(),g.id);return g;
 }
 fromRow(row){return row?{...row,persistent:true,mode:'manual',servers:[]}:null;}
 listGrants(user){this.assertMaintenance(user);return this.db.prepare('SELECT * FROM ai_grants WHERE revoked_at IS NULL ORDER BY created_at DESC,id').all().map(row=>this.publicGrant(this.fromRow(row)));}
 grantById(id){const session=this.grants.get(id);if(session)return this.maintenance.active(session.key,session.owner)?session:null;return this.fromRow(this.db.prepare('SELECT * FROM ai_grants WHERE id=? AND revoked_at IS NULL').get(id));}
 assertGrant(g){if(!g||!this.grantById(g.id))fail(401,'AI 授权已撤销或对话已结束');}
 revokeGrant(id,user){this.assertMaintenance(user);const g=this.grantById(id);if(!g)fail(404,'授权不存在');this.removeGrant(g);this.event(user,'ai_grant_revoked',{grant:id,label:g.label});}
 removeGrant(g){if(g.persistent)this.db.prepare('UPDATE ai_grants SET revoked_at=? WHERE id=?').run(now(),g.id);else this.grants.delete(g.id);this.rates.delete(g.id);for(const row of this.db.prepare("SELECT * FROM commands WHERE grant_id=? AND status IN ('pending','dispatching','running')").all(g.id))this.stop(row,'cancelled','AI 授权已撤销');}
 revoke(key){for(const g of [...this.grants.values()])if(g.key===key)this.removeGrant(g);}
 server(g,id){this.assertGrant(g);if(typeof id!=='string'||(!g.persistent&&!g.servers.includes(id)))fail(403,'此授权没有目标服务器的权限');const row=this.db.prepare('SELECT id,name,platform,last_seen,public_ip,latest,tags_json,ip_overrides FROM servers WHERE id=?').get(id);if(!row)fail(404,'服务器不存在');return row;}
 serverView(row,full=false){const latest=JSON.parse(row.latest||'null'),ips=JSON.parse(row.ip_overrides||'{}'),remote=this.transport.status(row.id),health=serverHealth({latest,last_seen:row.last_seen,remote},now());return {id:row.id,name:row.name,platform:row.platform,tags:JSON.parse(row.tags_json||'[]'),last_seen:row.last_seen,online:health.online,metrics_stale:!health.metricsFresh,public_ipv4:ips.public_ipv4||(Object.hasOwn(latest||{},'public_ipv4')?latest.public_ipv4:row.public_ip),private_ipv4:ips.private_ipv4||latest?.private_ipv4||null,commands_available:remote.commands===true,metrics:latest?.metrics||{},...(full?{volumes:latest?.volumes||[],disks:latest?.disks||[],services:latest?.services||[],containers:latest?.containers||[],docker_status:latest?.docker_status||'unavailable',collection_errors:latest?.collection_errors||[]}:{} )};}
 servers(g){this.assertGrant(g);return this.ids(g).map(id=>this.serverView(this.server(g,id)));}
 status(g,id){return this.serverView(this.server(g,id),true);}
 history(g,id,days=1){
  this.server(g,id);if(!Number.isInteger(days)||days<1||days>365)fail(400,'days 须为 1–365');
  const rows=this.db.prepare('SELECT t,resolution,payload FROM samples WHERE server_id=? AND t>=? ORDER BY t').all(id,now()-days*86400),stride=Math.max(1,Math.ceil(rows.length/720)),points=[];
  for(let i=0;i<rows.length;i+=stride){const part=rows.slice(i,i+stride),values=part.map(r=>JSON.parse(r.payload)),metrics={};for(const key of new Set(values.flatMap(v=>Object.keys(v)).filter(k=>!k.endsWith('_max')&&!k.endsWith('_count')))){const measured=values.filter(v=>Number.isFinite(v[key])),weight=measured.reduce((n,v)=>n+(v[key+'_count']||1),0);if(weight){metrics[key]=measured.reduce((n,v)=>n+v[key]*(v[key+'_count']||1),0)/weight;metrics[key+'_max']=Math.max(...measured.map(v=>v[key+'_max']??v[key]));}}points.push({from:part[0].t,to:part.at(-1).t,metrics});}return {server_id:id,days,samples:rows.length,points};
 }
 target(id){const row=this.db.prepare('SELECT id,name,platform,public_ip,latest,tags_json,ip_overrides FROM servers WHERE id=?').get(id);if(!row)return {id};const v=this.serverView(row);return {id:v.id,name:v.name,tags:v.tags,platform:v.platform,public_ipv4:v.public_ipv4,private_ipv4:v.private_ipv4};}
 auditList(user,{before=Number.MAX_SAFE_INTEGER,server_id=''}={}){this.assertMaintenance(user);if(!Number.isSafeInteger(before)||before<1||typeof server_id!=='string'||server_id.length>128)fail(400,'审计查询参数无效');const rows=this.db.prepare("SELECT seq,t,actor,actor_name,action,server_id,command_id,grant_id,detail FROM ai_audit WHERE seq<? AND (?='' OR server_id=?) ORDER BY seq DESC LIMIT 50").all(before,server_id,server_id);return {items:rows.map(({detail,...row})=>{const d=JSON.parse(detail);return {...row,label:d.label||null,target:d.target||null,status:d.status||null};}),next_before:rows.length===50?rows.at(-1).seq:null};}
 auditDetail(user,seq){this.assertMaintenance(user);if(!Number.isSafeInteger(seq)||seq<1)fail(400,'审计编号无效');const row=this.db.prepare('SELECT * FROM ai_audit WHERE seq=?').get(seq);if(!row)fail(404,'审计记录不存在');return {...row,detail:JSON.parse(row.detail)};}
 row(id){const row=this.db.prepare('SELECT * FROM commands WHERE id=?').get(id);if(!row)fail(404,'命令不存在');return row;}
 result(id,g){if(g)this.assertGrant(g);const row=this.row(id);if(g&&row.grant_id!==g.id)fail(404,'命令不存在');const live=this.running.get(id);return {...row,confirmation_detail:undefined,confirmation:row.confirmation_detail?JSON.parse(row.confirmation_detail):null,...(live?{stdout:live.stdout,stderr:live.stderr,output_truncated:live.truncated?1:0}:{})};}
 list(user){this.assertMaintenance(user);return this.db.prepare('SELECT id,grant_id,owner,created_name,server_id,shell,command,timeout_seconds,mode,status,confirmation_channel,confirmation_detail,created_at,started_at,finished_at,approved_by,approved_name,approved_source,approved_client,exit_code,error,output_truncated FROM commands ORDER BY created_at DESC,rowid DESC LIMIT 50').all().map(({confirmation_detail,...row})=>({...row,confirmation:confirmation_detail?JSON.parse(confirmation_detail):null}));}
 submit(g,input){
  this.assertGrant(g);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['server_id','command','request_id','timeout_seconds'].includes(k)))fail(400,'命令参数无效；不能指定模式、审批或 Shell');
  const {server_id,command,request_id}=input,timeout=input.timeout_seconds??60,server=this.server(g,server_id);
  if(!['linux','win32'].includes(server.platform))fail(400,'服务器暂不支持命令执行');
  if(typeof command!=='string'||!command.trim()||Buffer.byteLength(command)>16384||command.includes('\0'))fail(400,'命令必须为 1–16384 字节的非空文本');
  if(typeof request_id!=='string'||! /^[A-Za-z0-9_.:-]{1,80}$/.test(request_id))fail(400,'request_id 必填，最多 80 个英文、数字或 . _ : - 字符');
  if(!Number.isInteger(timeout)||timeout<1||timeout>300)fail(400,'超时时间须为 1–300 秒');
  const existing=this.db.prepare('SELECT * FROM commands WHERE grant_id=? AND request_id=?').get(g.id,request_id);if(existing){if(existing.server_id!==server_id||existing.command!==command||existing.timeout_seconds!==timeout)fail(409,'同一 request_id 不能用于不同命令');return this.result(existing.id,g);}
  let rate=this.rates.get(g.id);if(!rate||now()-rate.minute>=60){rate={minute:now(),requests:0};this.rates.set(g.id,rate);}if(++rate.requests>60)fail(429,'每个授权每分钟最多提交 60 条命令');
  if(!this.transport.status(server_id).commands)fail(409,'目标 Agent 命令通道未连接，请检查 Agent');if(this.db.prepare("SELECT count(*) n FROM commands WHERE status='pending'").get().n>=200)fail(429,'待确认命令过多，请先处理');
  const id=randomUUID();this.transaction(()=>{this.db.prepare("INSERT INTO commands(id,grant_id,request_id,owner,created_name,server_id,shell,command,timeout_seconds,mode,status,created_at,confirmation_channel) VALUES(?,?,?,?,?,?,?,?,?,'manual','pending',?,?)").run(id,g.id,request_id,g.owner,g.owner_name||g.owner,server_id,server.platform==='win32'?'powershell':'bash',command,timeout,now(),g.persistent?'client':'web');this.event({id:g.owner,name:g.owner_name},'ai_command_submitted',{grant:g.id,label:g.label,command_id:id,request_id,server:server_id,target:this.target(server_id),command,command_hash:hash(command),mode:'manual',confirmation_channel:g.persistent?'client':'web'});});return this.result(id,g);
 }
 checkCapacity(server){if([...this.running.values()].filter(v=>v.server===server).length>=2)fail(409,'此服务器已有两个命令正在执行，请稍后确认');}
 dispatch(row,user){
  this.assertMaintenance(user);return this.#dispatchConfirmed(row,user,{source:'web',client:null});
 }
 confirmClient(id,g,input){
  this.assertGrant(g);if(!g.persistent)fail(403,'网页对话不接受外部客户端确认');
  const row=this.row(id);if(row.grant_id!==g.id)fail(404,'命令不存在');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['decision','command_hash','client_name','client_version','confirmation'].includes(k))||!['approve','reject','defer'].includes(input.decision)||input.command_hash!==hash(row.command)||typeof input.client_name!=='string'||!input.client_name.trim()||input.client_name.length>100||/[\x00-\x1f]/.test(input.client_name)||typeof input.client_version!=='string'||input.client_version.length>60||/[\x00-\x1f]/.test(input.client_version))fail(400,'客户端确认必须绑定原始命令及客户端信息');
  if(row.status!=='pending')fail(409,'命令已处理，不接受重复确认');
  const actor={id:'client:'+g.id,name:g.label+'（AI客户端）'},context={source:'client',client:input.client_name,client_version:input.client_version,attestation:'client_reported',grant_created_by:g.owner,grant_created_by_name:g.owner_name};
  const ambiguousLegacyReject=input.confirmation==null&&input.decision==='reject',decision=ambiguousLegacyReject?'defer':input.decision;
  const confirmation=input.confirmation??{state:decision==='approve'?'approved':'deferred',source:'client',reason_code:ambiguousLegacyReject?'legacy_negative_ambiguous':'legacy_client_report',message:ambiguousLegacyReject?'旧版客户端未提供可区分的人员答复，任务保留待确认；请重载连接器。':'客户端报告确认状态。'};
  if(!confirmation||typeof confirmation!=='object'||Array.isArray(confirmation)||Object.keys(confirmation).some(k=>!['state','source','reason_code','message','details'].includes(k))||!['approved','rejected','deferred','cancelled','timeout','unavailable','error','native_declined'].includes(confirmation.state)||Object.entries(confirmation).some(([k,v])=>typeof v!=='string'||v.length>(k==='details'?600:500))||decision==='approve'&&confirmation.state!=='approved'||decision==='reject'&&confirmation.state!=='rejected'||decision==='defer'&&['approved','rejected'].includes(confirmation.state))fail(400,'确认状态与人员决定不一致');
  const detail={...confirmation,updated_at:now(),client:input.client_name};
  if(decision==='defer'){
   this.transaction(()=>{this.db.prepare("UPDATE commands SET confirmation_detail=? WHERE id=? AND status='pending'").run(JSON.stringify(detail),id);this.event(actor,'ai_command_confirmation_pending',{grant:g.id,command_id:id,server:row.server_id,status:'pending',confirmation:detail,...context});});
  }else if(decision==='reject'){
   this.db.prepare('UPDATE commands SET confirmation_detail=? WHERE id=?').run(JSON.stringify(detail),id);
   this.event(actor,'ai_command_rejected',{grant:g.id,command_id:id,server:row.server_id,confirmation:detail,...context});this.stop(row,'rejected','人员已明确选择不执行本次命令');
  }else{
   this.#dispatchConfirmed(row,actor,{...context,confirmation:detail});
  }
  return this.result(id,g);
 }
 #dispatchConfirmed(row,user,approval){
  const g=this.grantById(row.grant_id);if(!g)fail(403,'授权已撤销，不能执行');if(!this.transport.status(row.server_id).commands)fail(409,'目标 Agent 命令通道未连接');this.checkCapacity(row.server_id);
  this.transaction(()=>{const changed=this.db.prepare("UPDATE commands SET status='dispatching',approved_by=?,approved_name=?,approved_source=?,approved_client=?,confirmation_detail=?,started_at=? WHERE id=? AND status='pending'").run(user.id,user.name||user.id,approval.source,approval.client,approval.confirmation?JSON.stringify(approval.confirmation):null,now(),row.id);if(!changed.changes)fail(409,'此命令已经处理，不能重复执行');this.event(user,'ai_command_approved',{grant:g.id,label:g.label,command_id:row.id,server:row.server_id,target:this.target(row.server_id),command:row.command,command_hash:hash(row.command),...approval});});
    const live={server:row.server_id,stdout:'',stderr:'',bytes:0,truncated:false};this.running.set(row.id,live);live.timer=setTimeout(()=>this.stop(this.row(row.id),'timed_out','命令超时，已请求终止'),(row.timeout_seconds+10)*1000);live.timer.unref?.();
  this.event(user,'ai_command_dispatched',{grant:g.id,command_id:row.id,server:row.server_id});if(!this.transport.sendCommand(row.server_id,{type:'command-run',command_id:row.id,command:row.command,shell:row.shell,timeout_seconds:row.timeout_seconds}))this.finish(row.id,'unknown',null,'发送时连接中断，执行结果未知；未自动重试');
 }
 decide(id,action,user){this.assertMaintenance(user);const row=this.row(id);if(action==='approve'){if(row.status!=='pending')fail(409,'命令已经处理');this.dispatch(row,user);}else if(action==='reject'){if(row.status!=='pending')fail(409,'仅待确认命令可拒绝');this.event(user,'ai_command_rejected',{command_id:id,grant:row.grant_id,server:row.server_id});this.stop(row,'rejected','维护人员拒绝执行');}else if(action==='cancel'){this.event(user,'ai_command_cancelled',{command_id:id,grant:row.grant_id,server:row.server_id});this.stop(row,'cancelled','维护人员取消命令');}return this.result(id);}
 cancel(id,g){this.assertGrant(g);const row=this.row(id);if(row.grant_id!==g.id)fail(404,'命令不存在');this.event({id:g.owner,name:g.owner_name},'ai_command_cancelled',{command_id:id,grant:g.id,server:row.server_id});this.stop(row,'cancelled','AI 客户端取消命令');return this.result(id,g);}
 stop(row,status,reason){if(!activeStates.includes(row.status))return;if(row.status!=='pending')this.transport.sendCommand(row.server_id,{type:'command-cancel',command_id:row.id});this.finish(row.id,status,null,reason);}
 finish(id,status,exitCode,error){const row=this.row(id);if(!activeStates.includes(row.status))return;const live=this.running.get(id);clearTimeout(live?.timer);this.transaction(()=>{this.db.prepare('UPDATE commands SET status=?,finished_at=?,stdout=?,stderr=?,exit_code=?,error=?,output_truncated=? WHERE id=?').run(status,now(),live?.stdout||row.stdout,live?.stderr||row.stderr,exitCode,error||null,live?.truncated?1:row.output_truncated,id);this.event({id:row.owner,name:row.created_name||row.owner},'ai_command_finished',{grant:row.grant_id,command_id:id,server:row.server_id,status,exit_code:exitCode,stdout:live?.stdout||row.stdout,stderr:live?.stderr||row.stderr,error:error||null,output_truncated:!!live?.truncated||!!row.output_truncated,approved_by:row.approved_by,approved_name:row.approved_name,approved_source:row.approved_source,approved_client:row.approved_client});});this.running.delete(id);}
 message(server,m){const live=this.running.get(m.command_id);if(!live||live.server!==server)return;
  if(m.type==='command-started'){this.db.prepare("UPDATE commands SET status='running' WHERE id=? AND status='dispatching'").run(m.command_id);const row=this.row(m.command_id);this.event({id:row.owner,name:row.created_name||row.owner},'ai_command_started',{command_id:row.id,grant:row.grant_id,server});}
  else if(m.type==='command-data'&&['stdout','stderr'].includes(m.stream)&&typeof m.data==='string'&&m.data.length<=16384){const raw=Buffer.from(m.data),room=Math.max(0,65536-live.bytes);live[m.stream]+=raw.subarray(0,room).toString('utf8');live.bytes+=Math.min(raw.length,room);if(raw.length>room)live.truncated=true;}
  else if(m.type==='command-result'&&['succeeded','failed','timed_out','cancelled'].includes(m.status)){if(m.output_truncated===true)live.truncated=true;const exit=Number.isInteger(m.exit_code)?m.exit_code:null;this.finish(m.command_id,m.status==='succeeded'&&exit!==0?'failed':m.status,exit,typeof m.error==='string'?m.error.slice(0,512):null);}
 }
 disconnected(server){for(const[id,live]of this.running)if(live.server===server)this.finish(id,'unknown',null,'Agent 通道断开，执行结果未知；未自动重试');}
 prune(){/* Persistent grants, request idempotency and audit evidence are not automatically deleted. */}
}

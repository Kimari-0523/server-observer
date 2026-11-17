import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';
import {passwordHash} from '../shared/auth.mjs';
test('self-hosted HTTP and reverse WebSocket enforce account login, maintenance, manual approval and automatic Bash/PowerShell dispatch',{timeout:20000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'observer-http-')),origin='https://monitor.example.com',password='http-local-account-password',maintenance='http-maintenance-password',child=spawn(process.execPath,[fileURLToPath(new URL('../self-hosted/server.mjs',import.meta.url))],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,PORT:'0',DATA_DIR:dir,LISTEN_HOST:'127.0.0.1',PUBLIC_ORIGIN:origin,APP_KEY:'synthetic-http-key-'.repeat(3),BOOTSTRAP_ADMIN_USER:'admin',BOOTSTRAP_ADMIN_HASH:passwordHash(password),MAINTENANCE_PASSWORD_HASH:passwordHash(maintenance)},windowsHide:true,stdio:['ignore','pipe','pipe']}),sockets=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}if(resolve(dir).startsWith(resolve(tmpdir())+sep))rmSync(dir,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server did not start')),5000);child.stdout.on('data',data=>{const match=/listening on (\d+)/.exec(String(data));if(match){clearTimeout(timer);resolve(match[1]);}});child.once('error',reject);child.stderr.on('data',data=>{if(String(data).includes('Error:')){clearTimeout(timer);reject(Error(String(data)));}});});
  const call=(path,input,headers={})=>fetch('http://127.0.0.1:'+port+path,{method:input===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...headers},redirect:'manual',...(input===undefined?{}:{body:JSON.stringify(input)})});
  assert.equal((await call('/api/servers')).status,401);const logged=await call('/auth/password',{username:'admin',password});assert.equal(logged.status,302);const cookie=logged.headers.get('set-cookie').split(';')[0],{token}=await(await call('/api/unlock',{password:maintenance},{cookie})).json(),headers={cookie,'x-maintenance-token':token};
  for(const [platform,mode,command]of [['linux','manual','hostname'],['win32','auto','$env:COMPUTERNAME']]){
    const enrollment=await(await call('/api/enrollment',{},headers)).json(),agent=await(await call('/agent/enroll',{identity:'machine-'+platform,name:platform,platform,token:enrollment.token})).json(),socket=new WebSocket('ws://127.0.0.1:'+port+'/agent/connect');sockets.push(socket);await once(socket,'open');const received=[];socket.on('message',raw=>received.push(JSON.parse(String(raw))));socket.send(JSON.stringify({type:'auth',id:agent.id,token:agent.token,capabilities:{commands:true,terminal:true}}));
    async function message(type){const until=Date.now()+3000;while(Date.now()<until){const index=received.findIndex(m=>m.type===type);if(index>=0)return received.splice(index,1)[0];await new Promise(r=>setTimeout(r,10));}throw Error('Missing '+type);}
    await message('authenticated');const grant=await(await call('/api/ai/grants',{mode,server_ids:[agent.id],label:'HTTP verification'},headers)).json(),apiHeaders={authorization:'Bearer '+grant.token};const result=await call('/api/ai/v1/commands',{server_id:agent.id,command,request_id:'http-'+platform,timeout_seconds:10},apiHeaders);assert.equal(result.status,202);const job=await result.json();if(mode==='manual'){assert.equal(job.status,'pending');assert.equal(received.length,0);assert.equal((await call('/api/commands/'+job.id+'/approve',{},headers)).status,200);}const dispatched=await message('command-run');assert.equal(dispatched.shell,platform==='linux'?'bash':'powershell');socket.send(JSON.stringify({type:'command-result',command_id:job.id,status:'succeeded',exit_code:0}));assert.equal((await call('/api/ai/grants/'+grant.id+'/revoke',{},headers)).status,200);assert.equal((await call('/api/ai/v1/servers',undefined,apiHeaders)).status,401);
  }
  await call('/api/lock',{},headers);assert.equal((await call('/api/enrollment',{},headers)).status,403);
});

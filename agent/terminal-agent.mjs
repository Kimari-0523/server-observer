import pty from 'node-pty';
import {execFile} from 'node:child_process';
import {createCommandRunner} from './command-agent.mjs';
export function startRemote(config){
  const endpoint=new URL('/agent/connect',config.backend);endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
  const sessions=new Map();let socket,retry=1000,stopped=false;
  function send(value){if(socket?.readyState===1&&socket.bufferedAmount<1048576)socket.send(JSON.stringify(value));else if(socket?.bufferedAmount>=1048576)socket.close();}
  function close(id){const session=sessions.get(id);if(!session)return;sessions.delete(id);if(session.unit)execFile('systemctl',['stop',session.unit],{timeout:10000},()=>{});try{session.pty.kill();}catch{}}
  const commands=createCommandRunner({send});
  function connect(){if(stopped)return;socket=new WebSocket(endpoint);socket.addEventListener('open',()=>{retry=1000;send({type:'auth',id:config.id,token:config.token,capabilities:{terminal:true,commands:true}});});
    socket.addEventListener('message',event=>{try{const m=JSON.parse(String(event.data)),id=m.session_id;
      if(m.type==='ping'){send({type:'pong'});return;}if(m.type==='authenticated')return;
      if(m.type==='command-run'||m.type==='command-cancel'){commands.handle(m);return;}
      if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id))return;
      if(m.type==='terminal-open'){
        if(sessions.size>=2||sessions.has(id)){send({type:'terminal-error',session_id:id,error:'Terminal limit reached'});return;}
        const unit=process.platform==='linux'?'observer-terminal-'+id+'.service':null;
        const command=unit?'systemd-run':'powershell.exe';
        const args=unit?['--quiet','--pty','--wait','--collect','--unit='+unit,'--property=MemoryMax=512M','--property=TasksMax=128','--property=RuntimeMaxSec=infinity','--setenv=TERM=xterm-256color','/bin/bash','--login']:['-NoLogo','-NoProfile'];
        const env=unit?{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/root',SHELL:'/bin/bash',TERM:'xterm-256color',LANG:'C.UTF-8'}:{...process.env,TERM:'xterm-256color'};
        const terminal=pty.spawn(command,args,{name:'xterm-256color',cols:100,rows:28,cwd:unit?'/':'C:\\',env});sessions.set(id,{pty:terminal,unit});
        terminal.onData(data=>{for(let i=0;i<data.length;i+=4096)send({type:'terminal-data',session_id:id,data:data.slice(i,i+4096)});});
        terminal.onExit(()=>{sessions.delete(id);send({type:'terminal-exit',session_id:id});});send({type:'terminal-opened',session_id:id});
      }else if(m.type==='terminal-input'&&typeof m.data==='string'&&m.data.length<=4096)sessions.get(id)?.pty.write(m.data);
      else if(m.type==='terminal-resize'&&Number.isInteger(m.cols)&&Number.isInteger(m.rows)&&m.cols>=20&&m.cols<=300&&m.rows>=5&&m.rows<=150)sessions.get(id)?.pty.resize(m.cols,m.rows);
      else if(m.type==='terminal-close')close(id);
    }catch(e){let id;try{id=JSON.parse(String(event.data))?.session_id;}catch{}send({type:'terminal-error',session_id:id,error:'Unable to start terminal'});console.error('Terminal startup failed:',e.message);}});
    socket.addEventListener('error',()=>{});
    socket.addEventListener('close',()=>{commands.close();for(const id of sessions.keys())close(id);if(!stopped)setTimeout(connect,retry);retry=Math.min(30000,retry*2);});
  }
  connect();return {close(){stopped=true;commands.close();socket?.close();for(const id of sessions.keys())close(id);}};
}

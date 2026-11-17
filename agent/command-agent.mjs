import {spawn,execFile} from 'node:child_process';
export function commandSpec(platform,message){
  if(platform==='linux')return {command:'systemd-run',unit:'observer-command-'+message.command_id+'.service',args:['--quiet','--pipe','--wait','--collect','--unit=observer-command-'+message.command_id+'.service','--property=MemoryMax=256M','--property=TasksMax=64','--property=KillMode=control-group','--property=TimeoutStopSec=3s','--property=RuntimeMaxSec='+message.timeout_seconds+'s','/bin/bash','--noprofile','--norc','-c',message.command]};
  if(platform==='win32'){
    const script='$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; try { & {\n'+message.command+'\n}; if (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; exit 0 } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }';
    return {command:'powershell.exe',args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]};
  }
  throw new Error('Unsupported command platform');
}
export function createCommandRunner({send,platform=process.platform}){
  const jobs=new Map(),seen=new Set();
  function kill(job){if(job.spec.unit){execFile('systemctl',['stop',job.spec.unit],{timeout:7000},()=>{try{job.child.kill('SIGTERM');}catch{}});const retry=setTimeout(()=>execFile('systemctl',['stop',job.spec.unit],{timeout:7000},()=>{}),500);retry.unref();}else if(job.child.pid)execFile('taskkill.exe',['/PID',String(job.child.pid),'/T','/F'],{windowsHide:true,timeout:7000},()=>{try{job.child.kill();}catch{}});}
  function finish(id,status,exit,error){const job=jobs.get(id);if(!job)return;clearTimeout(job.timer);jobs.delete(id);send({type:'command-result',command_id:id,status,exit_code:exit,error,output_truncated:job.truncated});}
  function handle(m){
    const id=m.command_id;if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id))return;
    if(m.type==='command-cancel'){const job=jobs.get(id);if(job){job.cancelled=true;kill(job);}return;}
    if(m.type!=='command-run'||seen.has(id))return;
    if(jobs.size>=2){send({type:'command-result',command_id:id,status:'failed',exit_code:null,error:'Agent command limit reached'});return;}
    if(typeof m.command!=='string'||!m.command.trim()||Buffer.byteLength(m.command)>16384||m.command.includes('\0')||!Number.isInteger(m.timeout_seconds)||m.timeout_seconds<1||m.timeout_seconds>300||m.shell!==(platform==='win32'?'powershell':'bash')){send({type:'command-result',command_id:id,status:'failed',exit_code:null,error:'Invalid command request'});return;}
    seen.add(id);if(seen.size>1000)seen.delete(seen.values().next().value);
    try{
      const spec=commandSpec(platform,m),env=platform==='linux'?{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/root',LANG:'C.UTF-8'}:{...process.env};
      const child=spawn(spec.command,spec.args,{cwd:platform==='win32'?'C:\\':'/',env,windowsHide:true,stdio:['ignore','pipe','pipe']});const job={child,spec,bytes:0,truncated:false,started:Date.now()};jobs.set(id,job);
      job.timer=setTimeout(()=>{job.timedOut=true;kill(job);const fallback=setTimeout(()=>finish(id,'timed_out',null,'Command timeout; termination requested'),8000);fallback.unref();},m.timeout_seconds*1000);job.timer.unref();
      child.once('spawn',()=>send({type:'command-started',command_id:id}));
      for(const stream of ['stdout','stderr']){child[stream].setEncoding('utf8');child[stream].on('data',data=>{if(job.bytes>=65536){job.truncated=true;return;}const bytes=Buffer.from(data),remaining=65536-job.bytes,text=bytes.subarray(0,remaining).toString('utf8');job.bytes+=Math.min(bytes.length,remaining);if(bytes.length>remaining)job.truncated=true;for(let i=0;i<text.length;i+=4096)send({type:'command-data',command_id:id,stream,data:text.slice(i,i+4096)});});}
      child.once('error',error=>finish(id,'failed',null,error.message));
      child.once('close',(code,signal)=>finish(id,job.cancelled?'cancelled':job.timedOut?'timed_out':code===0?'succeeded':'failed',Number.isInteger(code)?code:null,signal?'Process signal: '+signal:undefined));
    }catch(error){send({type:'command-result',command_id:id,status:'failed',exit_code:null,error:error.message});}
  }
  return {handle,close(){for(const job of jobs.values()){job.cancelled=true;kill(job);}}};
}

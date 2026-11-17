import {spawn} from 'node:child_process';
import {openSync,closeSync,existsSync,statSync,renameSync,appendFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const directory=fileURLToPath(new URL('.',import.meta.url)),log=join(directory,'agent.log');
// Keep startup/enrollment errors visible when Task Scheduler runs without a console.
if(existsSync(log)&&statSync(log).size>5*1024*1024){rmSync(log+'.1',{force:true});renameSync(log,log+'.1');}
appendFileSync(log,new Date().toISOString()+' Starting Windows Agent\n');
const output=openSync(log,'a');
const child=spawn(process.execPath,[join(directory,'agent.mjs')],{cwd:directory,windowsHide:true,stdio:['ignore',output,output]});
closeSync(output);
child.once('error',error=>{appendFileSync(log,new Date().toISOString()+' Agent startup failed: '+error.message+'\n');process.exitCode=1;});
child.once('exit',(code,signal)=>{appendFileSync(log,new Date().toISOString()+` Agent stopped (exit=${code}, signal=${signal})\n`);process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill());

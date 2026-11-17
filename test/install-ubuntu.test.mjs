import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('Ubuntu retry replaces only an incomplete enrollment token and preserves an enrolled identity',async()=>{
  const source=readFileSync(new URL('../agent/install-ubuntu.sh',import.meta.url),'utf8'),marker='  MONITOR_SETUP_TOKEN="$token" node --input-type=module <<\'JS\'\n',start=source.indexOf(marker)+marker.length,end=source.indexOf('\nJS',start);
  assert(start>=marker.length&&end>start);const script=source.slice(start,end),base=mkdtempSync(join(tmpdir(),'observer-ubuntu-enrollment-'));
  try{
    const path=join(base,'agent.json');
    async function apply(){const file=join(base,'repair.mjs');writeFileSync(file,script);await exec(process.execPath,[file],{cwd:base,env:{...process.env,MONITOR_SETUP_TOKEN:'new-valid-token'},windowsHide:true});}
    writeFileSync(path,JSON.stringify({backend:'https://monitor.example',enrollment_token:'expired-token',services:['docker']}));await apply();const retry=JSON.parse(readFileSync(path,'utf8'));assert.equal(retry.enrollment_token,'new-valid-token');assert.deepEqual(retry.services,['docker']);
    const enrolled={id:'existing-id',token:'existing-agent-token',watchdog:{token:'existing-watchdog-token'},services:[]};writeFileSync(path,JSON.stringify(enrolled));await apply();assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),enrolled);
  }finally{rmSync(base,{recursive:true,force:true});}
});

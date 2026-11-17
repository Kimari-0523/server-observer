import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {installationCommands} from '../web/install-commands.js';
const exec=promisify(execFile),run=async source=>(await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{windowsHide:true,timeout:15000})).stdout.trim();
test('Windows installation wrapper handles both string and byte-array HTTP bodies',{skip:process.platform!=='win32'},async()=>{const script="param([string]$Token) Write-Output ('OK:'+$Token.Length)",literal="'"+script.replaceAll("'","''")+"'",command=installationCommands('A'.repeat(43),'https://monitor.example.com').windows;for(const asBytes of [false,true]){const fixture='function Invoke-WebRequest { param([switch]$UseBasicParsing,[string]$Uri) $s='+literal+'; [pscustomobject]@{Content='+(asBytes?'[Text.Encoding]::UTF8.GetBytes($s)':'$s')+'} }; '+command;assert.equal(await run(fixture),'OK:43');}});
test('Windows wrapper reports empty/HTML downloads explicitly without invoking them',{skip:process.platform!=='win32'},async()=>{const command=installationCommands('A'.repeat(43),'https://monitor.example.com').windows;for(const body of ["''","'<html>error</html>'"]){const output=await run('function Invoke-WebRequest { param([switch]$UseBasicParsing,[string]$Uri) [pscustomobject]@{Content='+body+'} }; try { '+command+" } catch {Write-Output $_.Exception.Message}");assert.match(output,/Installer download was empty or invalid/);}});
test('official checksum parser handles whitespace and missing entries without null method calls',{skip:process.platform!=='win32'},async()=>{const source=readFileSync(new URL('../agent/install-windows.ps1',import.meta.url),'utf8'),start=source.indexOf('function Get-OfficialChecksum'),end=source.indexOf('\n}',start)+2,definition=source.slice(start,end),checksum='a'.repeat(64);assert.equal(await run(definition+"\nGet-OfficialChecksum -Text '"+checksum+"  node-test.zip' -FileName 'node-test.zip'"),checksum);const missing=await run(definition+"\ntry { Get-OfficialChecksum -Text 'invalid checksum response' -FileName 'node-test.zip' } catch {Write-Output $_.Exception.Message}");assert.match(missing,/checksum entry was not found/);});

test('installer dependency verification runs through real Windows PowerShell 5.1 without native argument quote loss',{skip:process.platform!=='win32'},async()=>{
  const base=mkdtempSync(join(tmpdir(),'observer-installer-')),quote=value=>"'"+value.replaceAll("'","''")+"'";
  try{
    mkdirSync(join(base,'node_modules','node-pty'),{recursive:true});writeFileSync(join(base,'node_modules','node-pty','index.js'),'module.exports={};');
    const source=readFileSync(new URL('../agent/install-windows.ps1',import.meta.url),'utf8'),start=source.indexOf('  $verify='),end=source.indexOf("  if($LASTEXITCODE -ne 0){throw 'Terminal dependency verification failed'}",start);
    assert(start>0&&end>start);
    const result=await run('$ErrorActionPreference=\'Stop\'; $base='+quote(base)+'; $nodeDir='+quote(dirname(process.execPath))+'; '+source.slice(start,end)+"\nif($LASTEXITCODE -ne 0){throw 'Dependency probe failed'}; Write-Output 'DEPENDENCY_OK'");
    assert.equal(result,'DEPENDENCY_OK');
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('Windows task launcher captures agent diagnostics and preserves failure status',async()=>{
  const base=mkdtempSync(join(tmpdir(),'observer-launcher-'));
  try{
    copyFileSync(new URL('../agent/windows-launcher.mjs',import.meta.url),join(base,'windows-launcher.mjs'));
    writeFileSync(join(base,'agent.mjs'),"console.log('startup-check');console.error('enrollment-check');process.exit(7);");
    await assert.rejects(exec(process.execPath,[join(base,'windows-launcher.mjs')],{windowsHide:true,timeout:10000}),error=>error.code===7);
    const log=readFileSync(join(base,'agent.log'),'utf8');assert.match(log,/startup-check/);assert.match(log,/enrollment-check/);assert.match(log,/Agent stopped \(exit=7/);
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('agent npm lifecycle approval is limited to the pinned terminal dependency',()=>{
  const pkg=JSON.parse(readFileSync(new URL('../agent/package.json',import.meta.url),'utf8'));
  assert.deepEqual(pkg.allowScripts,{['node-pty@'+pkg.dependencies['node-pty']]:true});
});

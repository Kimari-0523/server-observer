import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),assets={};
const mime=name=>name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.js')||name.endsWith('.mjs')?'application/javascript':'text/plain; charset=utf-8';
function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const path=resolve(dir,item.name);if(item.isDirectory())walk(path);else{const name=relative(resolve(root,'web'),path).replaceAll('\\','/');assets[name==='index.html'?'/':name==='login.html'?'/login':'/'+name]={body:readFileSync(path,'utf8'),type:mime(name)};}}}
walk(resolve(root,'web'));
const hash=name=>createHash('sha256').update(readFileSync(resolve(root,'agent',name))).digest('hex');
for(const name of ['agent.mjs','addresses.mjs','public-ip.mjs','terminal-agent.mjs','command-agent.mjs','windows-launcher.mjs','package.json','package-lock.json'])assets['/downloads/'+name]={body:readFileSync(resolve(root,'agent',name),'utf8'),type:mime(name)};
for(const name of ['install-ubuntu.sh','install-windows.ps1','update-windows-agent.ps1'])assets['/install/'+name]={body:readFileSync(resolve(root,'agent',name),'utf8').replaceAll('__AGENT_SHA256__',hash('agent.mjs')).replaceAll('__PUBLIC_IP_SHA256__',hash('public-ip.mjs')).replaceAll('__ADDRESSES_SHA256__',hash('addresses.mjs')),type:'text/plain; charset=utf-8'};
mkdirSync(resolve(root,'generated'),{recursive:true});writeFileSync(resolve(root,'generated/assets.mjs'),'export const assets='+JSON.stringify(assets)+';\n');console.log('Built '+Object.keys(assets).length+' neutral assets with current Agent checksums.');

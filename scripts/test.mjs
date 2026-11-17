import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
function run(args){const result=spawnSync(process.execPath,args,{stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});if(result.status!==0)process.exit(result.status||1);}
if(existsSync('cloudflare/worker.mjs'))run(['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','cloudflare/wrangler.jsonc','--outdir','.runtime/cloudflare-build']);
run(['--test','test/*.test.mjs']);

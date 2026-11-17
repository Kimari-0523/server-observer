const clean=(value,max=100)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
function ip(value,privateOnly=false){
  if(typeof value!=='string'||!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))return null;
  const parts=value.split('.').map(Number);if(parts.some(n=>n>255))return null;const[a,b]=parts,privateIP=a===10||a===192&&b===168||a===172&&b>=16&&b<=31||a===100&&b>=64&&b<=127;
  return privateOnly?(privateIP?value:null):(!privateIP&&a>0&&a<224&&a!==127&&!(a===169&&b===254)&&!(a===198&&(b===18||b===19))?value:null);
}
export function readIdentity(value){try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}}
function normalize(value){
  const tags=[...new Set((Array.isArray(value.tags)?value.tags:[]).map(v=>clean(v,32)).filter(Boolean))].slice(0,8),manual=value.ip_overrides||{};
  const reported_public_ipv4=ip(value.reported_public_ipv4),reported_private_ipv4=ip(value.reported_private_ipv4,true),ip_overrides={public_ipv4:ip(manual.public_ipv4),private_ipv4:ip(manual.private_ipv4,true)};
  return {hostname:clean(value.hostname),tags,reported_public_ipv4,reported_private_ipv4,ip_overrides,public_ipv4:ip_overrides.public_ipv4||reported_public_ipv4,private_ipv4:ip_overrides.private_ipv4||reported_private_ipv4,...(value.component==='backend'?{component:'backend'}:{})};
}
export function identityFromServer(server){return normalize({hostname:server.host_name||server.name,tags:server.tags,reported_public_ipv4:server.latest?.public_ipv4,reported_private_ipv4:server.latest?.private_ipv4,ip_overrides:server.ip_overrides,component:server.component});}
export function identityLabel(identity,id){return clean(identity.tags?.join(' · '),280)||clean(identity.hostname)||identity.public_ipv4||identity.private_ipv4||'服务器 '+String(id).slice(-8);}
async function update(env,id,mutate){
  for(let attempt=0;attempt<3;attempt++){
    const {results}=await env.DB.prepare('SELECT id,label,identity_json FROM agents WHERE id=?').bind(id).all(),row=results[0];if(!row)return;
    const next=normalize(mutate(readIdentity(row.identity_json))),encoded=JSON.stringify(next),label=identityLabel(next,id);
    if(encoded===row.identity_json&&label===row.label)return;
    const result=await env.DB.prepare('UPDATE agents SET label=?,identity_json=? WHERE id=? AND identity_json=?').bind(label,encoded,id,row.identity_json).run();
    if(result.meta.changes)return;
  }
}
export async function syncServerIdentities(env,servers){
  const {results}=await env.DB.prepare('SELECT id,label,identity_json FROM agents').all(),byId=new Map(results.map(row=>[row.id,row]));
  for(const server of servers){const row=byId.get(server.id);if(!row)continue;const next=identityFromServer(server),encoded=JSON.stringify(next),label=identityLabel(next,server.id);if(encoded===row.identity_json&&label===row.label)continue;
    // A stale dashboard response must not overwrite a concurrent tag/IP edit.
    await env.DB.prepare('UPDATE agents SET label=?,identity_json=? WHERE id=? AND identity_json=?').bind(label,encoded,server.id,row.identity_json).run();
  }
}
export async function syncReportIdentity(env,id,report){await update(env,id,current=>({...current,...(Object.hasOwn(report||{},'public_ipv4')?{reported_public_ipv4:report.public_ipv4}:{}),...(Object.hasOwn(report||{},'private_ipv4')?{reported_private_ipv4:report.private_ipv4}:{})}));}
export async function syncIdentityEdit(env,id,kind,value){await update(env,id,current=>({...current,...(kind==='tags'?{tags:value.tags}:{ip_overrides:value})}));}
export function initialIdentity(name){return normalize({hostname:name});}

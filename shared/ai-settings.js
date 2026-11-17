const enc=new TextEncoder(),decode=new TextDecoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))),bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function key(env){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode('observer-ai-settings-v1:'+env.APP_KEY)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export function validateAISettings(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置必须为 JSON 对象');
  const base_url=String(value.base_url||'').trim().replace(/\/+$/,''),model=String(value.model||'').trim(),api_key=String(value.api_key||'');
  if(base_url){const url=new URL(base_url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||base_url.length>500)throw new Error('接口地址须为 HTTPS 地址，不能包含凭据或查询参数');}
  if(model.length>200||/[\x00-\x1f]/.test(model)||api_key.length>4096||/[\r\n\0]/.test(api_key))throw new Error('模型名称或 API Key 格式无效');
  return {base_url,model,api_key};
}
export async function readAISettings(env){const saved=await env.DB.prepare("SELECT value FROM settings WHERE key='ai_model'").first();if(!saved)return {base_url:'',model:'',api_key:''};const v=JSON.parse(saved.value),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(v.iv)},await key(env),bytes(v.data));return JSON.parse(decode.decode(plain));}
export async function saveAISettings(env,value){const valid=validateAISettings(value),iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),enc.encode(JSON.stringify(valid)));await env.DB.prepare("INSERT INTO settings(key,value) VALUES('ai_model',?) ON CONFLICT DO UPDATE SET value=excluded.value").bind(JSON.stringify({iv:b64(iv),data:b64(cipher)})).run();}

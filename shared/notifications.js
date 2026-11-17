const enc=new TextEncoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function key(env){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode(env.APP_KEY)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function readNotifications(env){
  const saved=await env.DB.prepare("SELECT value FROM settings WHERE key='notifications'").first();
  if(!saved)return {webhook:env.FEISHU_WEBHOOK||'',secret:env.FEISHU_SECRET||''};
  const v=JSON.parse(saved.value);const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(v.iv)},await key(env),bytes(v.data));return JSON.parse(new TextDecoder().decode(raw));
}
export async function saveNotifications(env,value){
  const url=new URL(value.webhook);if(url.protocol!=='https:'||url.hostname!=='open.feishu.cn'||!url.pathname.startsWith('/open-apis/bot/v2/hook/'))throw new Error('仅支持飞书群机器人 Webhook');
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),enc.encode(JSON.stringify(value)));
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('notifications',?) ON CONFLICT DO UPDATE SET value=excluded.value").bind(JSON.stringify({iv:b64(iv),data:b64(cipher)})).run();
}

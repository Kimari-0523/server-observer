import {get,Agent} from 'node:https';
import {isIP} from 'node:net';
import {isVirtualInterface} from './addresses.mjs';
export const defaultProbeUrls=['https://myip.ipip.net','https://whois.pconline.com.cn/ipJson.jsp?json=true'];

export function publicIPv4(value){
  if(typeof value!=='string'||isIP(value)!==4)return false;
  const [a,b]=value.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===198&&(b===18||b===19)));
}
export function parseProbeIPv4(text){
  const body=text.trim();let value=body;
  if(body.startsWith('{')){try{value=JSON.parse(body).ip;}catch{return null;}}
  else if(/^当前\s*IP\s*[:：]/u.test(body))value=/^当前\s*IP\s*[:：]\s*(\d+(?:\.\d+){3})(?:\s|$)/u.exec(body)?.[1];
  return publicIPv4(value)?value:null;
}
export async function probeIPv4(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('IP probe requires HTTPS without credentials');
  // Never inherit HTTP(S)_PROXY, NODE_USE_ENV_PROXY or the global HTTPS agent.
  // A router/TUN proxy still needs a direct route for this probe's domain.
  const agent=new Agent({keepAlive:false,proxyEnv:{}});
  try{return await new Promise((resolve,reject)=>{
    const request=get(url,{family:4,agent,headers:{accept:'text/plain, application/json'}},response=>{
      if(response.statusCode!==200){response.resume();reject(new Error('IP probe HTTP '+response.statusCode));return;}
      let text='';response.setEncoding('utf8');
      response.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>4096)request.destroy(new Error('IP probe response too large'));});
      response.on('error',reject);response.on('end',()=>{const ip=parseProbeIPv4(text);ip?resolve(ip):reject(new Error('IP probe returned no public IPv4'));});
    });
    const timer=setTimeout(()=>request.destroy(new Error('IP probe timed out')),6000);
    request.once('error',reject);request.once('close',()=>clearTimeout(timer));
  });}finally{agent.destroy();}
}
export function validCachedAddress(value,now=Date.now()){return !!value&&publicIPv4(value.address)&&typeof value.source==='string'&&/^(probe|interface):/.test(value.source)&&Number.isFinite(value.checked_at)&&now-value.checked_at>=-60000&&now-value.checked_at<86400000;}
export function probeRetryInterval(address){return address?600000:30000;}
export async function discoverPublicIPv4({interfaces,probeUrls=defaultProbeUrls,probe=probeIPv4}){
  for(const [name,values] of Object.entries(interfaces)){
    if(isVirtualInterface(name)||/^(tun\d|tap\d|utun|clash|mihomo|sing-box|tailscale|warp)/i.test(name))continue;
    const found=values.find(item=>!item.internal&&publicIPv4(item.address));
    if(found)return {address:found.address,source:'interface:'+name};
  }
  if(Array.isArray(probeUrls))for(const value of probeUrls.slice(0,3)){
    try{const address=await probe(value);if(publicIPv4(address))return {address,source:'probe:'+new URL(value).hostname};}catch{}
  }
  // Transport/Cloudflare observed addresses can be proxy exits, so never fall back to them.
  return {address:null,source:'unavailable'};
}

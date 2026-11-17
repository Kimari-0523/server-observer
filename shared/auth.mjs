import {createHash,randomBytes,scryptSync,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';
const hash=s=>createHash('sha256').update(s).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const epoch=()=>Math.floor(Date.now()/1000);
const cookie=(req,name)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';
export function passwordHash(password){if(typeof password!=='string'||password.length<12||password.length>256)fail(400,'密码需要 12–256 个字符');const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');}
export function verifyPassword(password,encoded){const [salt,digest]=String(encoded||'').split(':');if(typeof password!=='string'||password.length>256||!salt||! /^[a-f0-9]{128}$/.test(digest||''))return false;const got=scryptSync(password,salt,64),want=Buffer.from(digest,'hex');return timingSafeEqual(got,want);}
export class Settings{
  constructor(db,key){if(typeof key!=='string'||key.length<32)throw Error('APP_KEY must be a new random secret of at least 32 characters');this.db=db;this.key=createHash('sha256').update(key).digest();}
  read(name,fallback={}){const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(name);if(!row)return fallback;const v=JSON.parse(row.value),dec=createDecipheriv('aes-256-gcm',this.key,Buffer.from(v.iv,'base64'));dec.setAuthTag(Buffer.from(v.tag,'base64'));return JSON.parse(Buffer.concat([dec.update(Buffer.from(v.data,'base64')),dec.final()]).toString());}
  save(name,value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv),data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name,JSON.stringify({iv:iv.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')}));}
}
function https(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)fail(400,'认证接口必须是无内嵌凭据的 HTTPS 地址');return url;}
async function jsonFetch(url,options={}){const response=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(15000)});if(!response.ok)fail(502,'登录供应方暂时不可用');return response.json();}
export class Auth{
  constructor({db,env,settings,origin,onLogout=()=>{}}){Object.assign(this,{db,env,settings,origin,onLogout});this.sessions=new Map();this.states=new Map();this.attempts=new Map();this.jwks=new Map();
    db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL)');
    if(!db.prepare('SELECT id FROM users LIMIT 1').get()){
      if(!/^[A-Za-z0-9_.@-]{3,80}$/.test(env.BOOTSTRAP_ADMIN_USER||'')||! /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(env.BOOTSTRAP_ADMIN_HASH||''))throw Error('Provision BOOTSTRAP_ADMIN_USER and BOOTSTRAP_ADMIN_HASH before first startup');
      db.prepare('INSERT INTO users VALUES(?,?,?)').run('local:'+secret(),env.BOOTSTRAP_ADMIN_USER,env.BOOTSTRAP_ADMIN_HASH);
    }
    const site=new URL(origin);if(site.origin!==origin||!(/^[A-Za-z0-9.-]+$/.test(site.hostname)||/^\[[0-9A-Fa-f:.]+\]$/.test(site.hostname))||site.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(site.hostname))throw Error('PUBLIC_ORIGIN requires an HTTPS origin except loopback development');
  }
  config(){return this.settings.read('login',{feishu:{enabled:false},oidc:{enabled:false}});}
  actor(req){const session=this.sessions.get(hash(cookie(req,'session')));if(!session||session.expires<epoch())fail(401,'请先登录');if(session.local&&!this.db.prepare('SELECT id FROM users WHERE id=?').get(session.id))fail(401,'账号已失效');return session;}
  admin(req){const user=this.actor(req);if(!user.local)fail(403,'请使用本地管理员账号修改登录配置');return user;}
  rate(key){this.prune();const value=this.attempts.get(key)||{count:0,expires:epoch()+600};if(value.count>=5)fail(429,'登录失败过多，请十分钟后再试');value.count++;this.attempts.set(key,value);}
  prune(){for(const map of [this.sessions,this.states,this.attempts])for(const [key,value]of map)if(value.expires<epoch())map.delete(key);}
  session(user,reply){if(this.sessions.size>=10000)fail(503,'当前登录会话过多');const token=secret();this.sessions.set(hash(token),{...user,expires:epoch()+28800});return reply(302,'',{location:'/', 'set-cookie':this.sessionCookie(token)});}
  sessionCookie(token){return `session=${token}; HttpOnly; ${this.origin.startsWith('https:')?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=${token?28800:0}`;}
  publicConfig(){const c=this.config();return {local:true,feishu:!!c.feishu?.enabled,oidc:!!c.oidc?.enabled,oidc_name:c.oidc?.name||'统一登录'};}
  inspect(){const c=this.config();return {...c,feishu:{...c.feishu,client_secret:undefined,secret_configured:!!c.feishu?.client_secret},oidc:{...c.oidc,client_secret:undefined,secret_configured:!!c.oidc?.client_secret}};}
  save(input){const old=this.config(),next={};for(const name of ['feishu','oidc']){const value=input[name]||{},previous=old[name]||{},client_id=String(value.client_id||'').trim(),client_secret=value.clear_secret?'':String(value.client_secret||previous.client_secret||'');if(client_id.length>300||client_secret.length>4096||/[\r\n\0]/.test(client_secret))fail(400,'登录配置过长或格式无效');next[name]={enabled:value.enabled===true,client_id,client_secret};if(name==='oidc'){next[name].issuer=String(value.issuer||'').replace(/\/$/,'');next[name].name=String(value.name||'统一登录').slice(0,40);if(next[name].issuer)https(next[name].issuer);next[name].token_auth_method=value.token_auth_method==='client_secret_post'?'client_secret_post':'client_secret_basic';}if(next[name].enabled&&(!client_id||!client_secret||name==='oidc'&&!next[name].issuer))fail(400,'启用登录前请填写完整配置');}this.settings.save('login',next);this.states.clear();return {ok:true};}
  async route(req,url,body,reply){const p=url.pathname;
    if(p==='/auth/options'&&req.method==='GET')return reply(200,this.publicConfig());
    if(p==='/auth/password'&&req.method==='POST'){
      const input=await body(req),key='password:'+(req.socket?.remoteAddress||'unknown');this.rate(key);const row=this.db.prepare('SELECT * FROM users WHERE username=?').get(String(input.username||'').slice(0,80));
      // Unknown users take the same expensive hash path.
      const fallback=this.db.prepare('SELECT password_hash FROM users LIMIT 1').get().password_hash,ok=verifyPassword(input.password,row?.password_hash||fallback);if(!row||!ok)fail(403,'账号或密码错误');this.attempts.delete(key);return this.session({id:row.id,name:row.username,local:true},reply);
    }
    if(p==='/auth/logout'&&req.method==='POST'){const user=this.actor(req);this.onLogout(user.id);this.sessions.delete(hash(cookie(req,'session')));return reply(200,{ok:true},{'set-cookie':this.sessionCookie('')});}
    const login=/^\/auth\/login\/(feishu|oidc)$/.exec(p);
    if(login&&req.method==='GET'){
      this.prune();if(this.states.size>=1000)fail(429,'登录请求过多');const provider=login[1],c=this.config()[provider];if(!c?.enabled)fail(404,'该登录方式未启用');const state=secret(),nonce=secret(),verifier=secret(),redirect=this.origin+'/auth/callback/'+provider;
      let target,discovery;
      if(provider==='feishu')target=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
      else{discovery=await jsonFetch(https(c.issuer+'/.well-known/openid-configuration'));if(discovery.issuer!==c.issuer||!discovery.code_challenge_methods_supported?.includes('S256'))fail(502,'OIDC issuer 或 PKCE S256 不兼容');target=https(discovery.authorization_endpoint);https(discovery.token_endpoint);https(discovery.jwks_uri);}
      for(const [key,value]of Object.entries({client_id:c.client_id,redirect_uri:redirect,response_type:'code',state,...(provider==='oidc'?{scope:'openid profile email',nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}:{})}))target.searchParams.set(key,value);
      this.states.set(hash(state),{provider,nonce,verifier,discovery,expires:epoch()+300});return reply(302,'',{location:target.href,'set-cookie':`oauth=${state}; HttpOnly; ${this.origin.startsWith('https:')?'Secure; ':''}SameSite=Lax; Path=/auth; Max-Age=300`});
    }
    const callback=/^\/auth\/callback\/(feishu|oidc)$/.exec(p);
    if(callback&&req.method==='GET'){
      const state=url.searchParams.get('state')||'',entry=this.states.get(hash(state));this.states.delete(hash(state));if(!entry||cookie(req,'oauth')!==state||entry.provider!==callback[1]||entry.expires<epoch())fail(403,'登录校验失败或已过期');const provider=entry.provider,c=this.config()[provider];if(!c?.enabled)fail(403,'登录方式已停用');const code=url.searchParams.get('code');if(!code||code.length>4096)fail(403,'无效授权码');const redirect_uri=this.origin+'/auth/callback/'+provider;
      if(provider==='feishu'){const token=await jsonFetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',client_id:c.client_id,client_secret:c.client_secret,code,redirect_uri})});if(!token.access_token)fail(403,'飞书授权失败');const info=await jsonFetch('https://open.feishu.cn/open-apis/authen/v1/user_info',{headers:{authorization:'Bearer '+token.access_token}});if(info.code!==0||!info.data?.open_id)fail(403,'飞书身份验证失败');return this.session({id:'feishu:'+info.data.open_id,name:String(info.data.name||'飞书用户').slice(0,100),local:false},reply);}
      const params=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri,code_verifier:entry.verifier}),headers={'content-type':'application/x-www-form-urlencoded'};
      if(c.token_auth_method==='client_secret_post'){params.set('client_id',c.client_id);params.set('client_secret',c.client_secret);}else headers.authorization='Basic '+Buffer.from(encodeURIComponent(c.client_id)+':'+encodeURIComponent(c.client_secret)).toString('base64');
      const tokens=await jsonFetch(https(entry.discovery.token_endpoint),{method:'POST',headers,body:params.toString()});if(!tokens.id_token)fail(403,'OIDC 缺少 ID Token');const jwksURL=https(entry.discovery.jwks_uri).href;let jwks=this.jwks.get(jwksURL);if(!jwks){jwks=createRemoteJWKSet(new URL(jwksURL),{timeoutDuration:10000});this.jwks.set(jwksURL,jwks);}
      let claims;try{({payload:claims}=await jwtVerify(tokens.id_token,jwks,{issuer:c.issuer,audience:c.client_id,algorithms:['RS256','RS384','RS512','ES256','ES384','PS256','EdDSA'],requiredClaims:['sub','exp','iat','nonce']}));}catch{fail(403,'OIDC 签名或身份校验失败');}
      if(claims.nonce!==entry.nonce||claims.azp&&claims.azp!==c.client_id||Array.isArray(claims.aud)&&claims.aud.length>1&&!claims.azp)fail(403,'OIDC nonce 或授权方不符');return this.session({id:'oidc:'+hash(c.issuer+'|'+claims.sub),name:String(claims.name||claims.preferred_username||claims.sub).slice(0,100),local:false},reply);
    }
    return false;
  }
}

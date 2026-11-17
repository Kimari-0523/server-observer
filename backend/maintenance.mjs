import {randomBytes,createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
export class MaintenanceSessions{
  constructor(onRevoke=()=>{}){this.sessions=new Map();this.onRevoke=onRevoke;}
  create(user){const token=randomBytes(32).toString('base64url');this.sessions.set(hash(token),{user});return token;}
  key(token,user){if(typeof token!=='string'||token.length>128)return null;const key=hash(token);return this.sessions.get(key)?.user===user?key:null;}
  active(key,user){return this.sessions.get(key)?.user===user;}
  revoke(token,user){const key=this.key(token,user);if(!key)return false;this.sessions.delete(key);this.onRevoke(key);return true;}
}

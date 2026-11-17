import {DurableObject} from 'cloudflare:workers';
import {initStore} from '../shared/store.mjs';
import {createCore} from '../shared/core.mjs';
import {createRemoteHub} from '../shared/remote.mjs';
import {assets} from '../generated/assets.mjs';
import schema from '../shared/heartbeat-schema.sql';
function sqliteAdapter(storage){return {exec(sql){storage.sql.exec(sql);},prepare(sql){return {all(...values){return [...storage.sql.exec(sql,...values)];},get(...values){return [...storage.sql.exec(sql,...values)][0];},run(...values){const result=storage.sql.exec(sql,...values);return {changes:result.rowsWritten};}};},transaction(fn){return storage.transactionSync(fn);}};}
function wrapSocket(socket){return {get readyState(){return socket.readyState;},get bufferedAmount(){return socket.bufferedAmount||0;},send(value){socket.send(value);},close(code,reason){socket.close(code,reason);},on(type,listener){socket.addEventListener(type,event=>listener(type==='message'?event.data:event));}};}
export class MonitorHub extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.env=env;const db=sqliteAdapter(ctx.storage);initStore(db);db.exec(schema);this.core=createCore({db,env,assets,transportFactory:createRemoteHub});}
  async fetch(request){if(request.headers.get('upgrade')?.toLowerCase()==='websocket'){let authorization;try{authorization=this.core.remote.authorize({url:request.url,headers:Object.fromEntries(request.headers)});}catch{return new Response('Forbidden',{status:403});}const pair=new WebSocketPair(),[client,server]=Object.values(pair);server.accept();this.core.remote.accept(wrapSocket(server),authorization);return new Response(null,{status:101,webSocket:client});}return this.core.fetch(request,request.headers.get('cf-connecting-ip')||'unknown');}
  async alarm(){try{await this.core.cron();}finally{await this.ctx.storage.setAlarm(Date.now()+60000);}}
  async runChecks(){await this.core.cron();await this.ctx.storage.setAlarm(Date.now()+60000);return {ok:true};}
}
export default {
  async fetch(request,env){return env.HUB.get(env.HUB.idFromName('platform')).fetch(request);},
  async scheduled(_event,env,ctx){ctx.waitUntil(env.HUB.get(env.HUB.idFromName('platform')).runChecks());}
};

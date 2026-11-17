import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,saveReport,compact} from './support-store.mjs';
test('old samples retain hourly averages and peaks; expired data is removed',()=>{
  const db=openStore(':memory:'),now=1800000000;
  db.prepare('INSERT INTO servers(id,identity_hash,token_hash,name,platform) VALUES(?,?,?,?,?)').run('server','identity','token','test','linux');
  const t=Math.floor((now-40*86400)/3600)*3600;
  for(const [dt,v]of [[0,10],[60,90]])saveReport(db,'server',{private_ips:[],metrics:{cpu_percent:v}},'127.0.0.1',t+dt);
  saveReport(db,'server',{private_ips:[],metrics:{cpu_percent:20}},'127.0.0.1',now-370*86400);
  compact(db,now);
  const rows=db.prepare('SELECT * FROM samples').all();assert.equal(rows.length,1);assert.equal(rows[0].resolution,3600);const m=JSON.parse(rows[0].payload);assert.equal(m.cpu_percent,50);assert.equal(m.cpu_percent_max,90);compact(db,now);assert.equal(db.prepare('SELECT count(*) n FROM samples').get().n,1);db.close();
});

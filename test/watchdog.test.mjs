import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker, {sha256, checkAgents} from '../shared/index.js';

test('SHA-256 produces the expected token digest', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../shared/heartbeat-schema.sql',import.meta.url),'utf8'));
  const DB = {prepare(sql){const statement={args:[],bind(...v){this.args=v;return this;},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return {meta:db.prepare(sql).run(...this.args)};}};return statement;},async batch(statements){db.exec('BEGIN');try {const r=[];for(const s of statements)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
  return {db,env:{DB,FEISHU_WEBHOOK:'https://open.feishu.cn/open-apis/bot/v2/hook/test',FEISHU_SECRET:'test'}};
}
test('failed delivery remains queued; retry and recovery each produce one event', async () => {
  const {db,env}=database();
  db.prepare('INSERT INTO agents(id,label,token_hash,last_seen,alert_state) VALUES(?,?,?,?,?)').run('agent1234','test','hash',1,'online');
  const prior=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:500});
  try {
    await checkAgents(env,1000);
    assert.equal(db.prepare('SELECT count(*) n FROM alert_outbox WHERE delivered_at IS NULL').get().n,1);
    globalThis.fetch=async()=>Response.json({code:0});
    await checkAgents(env,1010);
    assert.equal(db.prepare('SELECT count(*) n FROM alert_outbox WHERE delivered_at IS NULL').get().n,0);
    db.prepare('UPDATE agents SET last_seen=?').run(1020);
    await checkAgents(env,1021);await checkAgents(env,1022);
    assert.equal(db.prepare('SELECT count(*) n FROM alert_outbox').get().n,2);
  } finally {globalThis.fetch=prior;db.close();}
});
test('heartbeat arriving during delivery still generates recovery next check',async()=>{
  const {db,env}=database();
  db.prepare('INSERT INTO agents(id,label,token_hash,last_seen,alert_state) VALUES(?,?,?,?,?)').run('agent1234','test','hash',1,'online');
  const prior=globalThis.fetch;
  globalThis.fetch=async()=>{db.prepare('UPDATE agents SET last_seen=?').run(1000);return Response.json({code:0});};
  try{await checkAgents(env,1000);await checkAgents(env,1001);assert.deepEqual(db.prepare('SELECT state FROM alert_outbox ORDER BY created_at').all().map(x=>x.state),['offline','online']);}finally{globalThis.fetch=prior;db.close();}
});
test('heartbeat rejects requests lacking valid credentials before querying DB', async () => {
  const r = await worker.fetch(new Request('https://example.test/heartbeat',{method:'POST'}),{});
  assert.equal(r.status,401);
});
test('heartbeat updates only matching agent and digest', async () => {
  const token = 'a'.repeat(32); let args;
  const env = {DB: {prepare(sql) {
    assert.match(sql, /WHERE id = \? AND token_hash = \?/);
    return {bind(...v) { args = v; return {async run() { return {meta:{changes:1}}; }}; }};
  }}};
  const r = await worker.fetch(new Request('https://example.test/heartbeat',{method:'POST',headers:{authorization:`Bearer ${token}`,'x-agent-id':'agent1234'}}),env);
  assert.equal(r.status,204); assert.equal(args[2],'agent1234'); assert.equal(args[3],await sha256(token));
});

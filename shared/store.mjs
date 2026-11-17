export function initStore(db) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,identity_hash TEXT UNIQUE NOT NULL,token_hash TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,last_seen INTEGER,public_ip TEXT,private_ips TEXT NOT NULL DEFAULT '[]',latest TEXT);
    CREATE TABLE IF NOT EXISTS enrollment(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS samples(server_id TEXT NOT NULL,t INTEGER NOT NULL,resolution INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(server_id,resolution,t),FOREIGN KEY(server_id) REFERENCES servers(id));
    CREATE TABLE IF NOT EXISTS audit(t INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `);
  if(!db.prepare('PRAGMA table_info(servers)').all().some(c=>c.name==='tags_json'))db.exec("ALTER TABLE servers ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  if(!db.prepare('PRAGMA table_info(servers)').all().some(c=>c.name==='ip_overrides'))db.exec("ALTER TABLE servers ADD COLUMN ip_overrides TEXT NOT NULL DEFAULT '{}'");
  return db;
}
export function saveReport(db,id,report,ip,now=Math.floor(Date.now()/1000)) {
  return db.transaction(()=>{
    db.prepare('UPDATE servers SET last_seen=?,public_ip=?,private_ips=?,latest=? WHERE id=?').run(now,ip,JSON.stringify(report.private_ips||[]),JSON.stringify(report),id);
    db.prepare('INSERT INTO samples(server_id,t,resolution,payload) VALUES(?,?,60,?) ON CONFLICT DO UPDATE SET payload=excluded.payload').run(id,Math.floor(now/60)*60,JSON.stringify(report.metrics));
  });
}
export function compact(db,now=Math.floor(Date.now()/1000)) {
  // Scalar charts preserve averages and peaks; detailed device snapshots live
  // in latest. Older scalar history remains bounded to 365 days.
  return db.transaction(()=>{
    for(const [source,target,age] of [[60,300,7*86400],[300,3600,30*86400]]) {
      const cutoff=Math.floor((now-age)/target)*target;
      const rows=db.prepare('SELECT server_id,t,payload FROM samples WHERE resolution=? AND t<? ORDER BY server_id,t').all(source,cutoff);
      const groups=new Map();
      for(const row of rows){const t=Math.floor(row.t/target)*target,key=`${row.server_id}:${t}`;if(!groups.has(key))groups.set(key,{id:row.server_id,t,values:[]});groups.get(key).values.push(JSON.parse(row.payload));}
      for(const group of groups.values()){
        const payload={};
        for(const key of new Set(group.values.flatMap(v=>Object.keys(v)).filter(k=>!k.endsWith('_max')&&!k.endsWith('_count')))){
          const values=group.values.filter(v=>Number.isFinite(v[key]));
          const weight=values.reduce((sum,v)=>sum+(v[key+'_count']||1),0);
          if(weight){payload[key]=values.reduce((sum,v)=>sum+v[key]*(v[key+'_count']||1),0)/weight;payload[key+'_count']=weight;payload[key+'_max']=Math.max(...values.map(v=>v[key+'_max']??v[key]));}
        }
        db.prepare('INSERT INTO samples(server_id,t,resolution,payload) VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET payload=excluded.payload').run(group.id,group.t,target,JSON.stringify(payload));
      }
      db.prepare('DELETE FROM samples WHERE resolution=? AND t<?').run(source,cutoff);
    }
    db.prepare('DELETE FROM samples WHERE t<?').run(now-365*86400);
    db.prepare('DELETE FROM enrollment WHERE expires<?').run(now);
  });
}

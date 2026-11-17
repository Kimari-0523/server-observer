export function mergeHeartbeats(servers,heartbeats){
  const byId=new Map(heartbeats.map(row=>[row.id,row]));
  return servers.map(server=>({...server,watchdog_last_seen:byId.get(server.id)?.last_seen??null}));
}

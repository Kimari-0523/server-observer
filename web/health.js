export function serverHealth(server,now=Date.now()/1000){
  const fresh=value=>Number.isFinite(value)&&value>0&&now-value<180;
  const metricsFresh=!!server.latest&&fresh(server.last_seen),heartbeat=server.watchdog_last_seen??(server.watchdog_only?server.last_seen:null);
  const online=metricsFresh||fresh(heartbeat)||server.remote?.connected===true;
  const partial=metricsFresh&&Array.isArray(server.latest?.collection_errors)&&server.latest.collection_errors.length>0;
  const degraded=online&&(!metricsFresh||partial);
  return {online,degraded,metricsFresh,label:!online?'● 失联 / 待上报':server.watchdog_only?'● 心跳在线 · 详细监测暂不可达':!metricsFresh?'● 在线 · 指标采集异常':partial?'● 在线 · 部分指标暂不可用':'● 在线',note:!online||!degraded?'':!metricsFresh?'连接正常，最后指标更新：'+(server.last_seen?new Date(server.last_seen*1000).toLocaleString():'尚未收到')+'；下方为缓存数据。':'基础指标正常，部分网络或磁盘计数器暂不可用。'};
}

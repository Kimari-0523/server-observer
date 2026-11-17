export function localVolumes(server){
  const rows=Array.isArray(server.latest?.volumes)?server.latest.volumes:[];
  if(rows.length)return rows.filter(row=>Number.isFinite(row.total_bytes)&&row.total_bytes>0).slice(0,64);
  const m=server.latest?.metrics||{};
  return Number.isFinite(m.disk_total_bytes)?[{name:'系统盘',mount:server.platform==='win32'?'C:\\':'/',total_bytes:m.disk_total_bytes,used_bytes:m.disk_used_bytes,used_percent:m.disk_percent,legacy:true}]:[];
}
export function capacitySummary(server){const rows=localVolumes(server);return {count:rows.length,complete:rows.length>0&&!rows.some(row=>row.legacy),total:rows.reduce((sum,row)=>sum+row.total_bytes,0),used:rows.reduce((sum,row)=>sum+(Number.isFinite(row.used_bytes)?row.used_bytes:0),0)};}
const gib=value=>Number.isFinite(value)?(value/1073741824).toFixed(1)+' GiB':'—';
const rate=value=>{if(!Number.isFinite(value))return '等待区间采样';const units=['B/s','KiB/s','MiB/s','GiB/s'];let i=0;while(value>=1024&&i<units.length-1){value/=1024;i++;}return value.toFixed(i?1:0)+' '+units[i];};
export function renderDiskDetails(server,target,element){
  target.replaceChildren();target.append(element('h3','磁盘与分区'));
  const volumes=localVolumes(server),disks=Array.isArray(server.latest?.disks)?server.latest.disks.slice(0,64):[];
  if(server.latest?.device_inventory_cached)target.append(element('p','本轮磁盘采集暂不可用。容量为 '+new Date(server.latest.device_inventory_collected_at).toLocaleString()+' 的缓存；本轮读写速率不显示为 0。','collection-note'));
  function table(headers,rows){const wrap=element('div',undefined,'table-scroll disk-table'),node=element('table'),head=element('thead'),header=element('tr'),body=element('tbody');for(const name of headers)header.append(element('th',name));head.append(header);for(const values of rows){const row=element('tr');for(const value of values)row.append(element('td',value));body.append(row);}node.append(head,body);wrap.append(node);target.append(wrap);}
  if(volumes.length){table(['本地卷 / 挂载点','名称 / 文件系统','关联磁盘','已用 / 总容量','使用率'],volumes.map(volume=>[volume.mount||volume.name,[volume.label,volume.filesystem].filter(Boolean).join(' · ')||'—',Number.isInteger(volume.disk_number)?'磁盘 '+volume.disk_number:volume.name,gib(volume.used_bytes)+' / '+gib(volume.total_bytes),Number.isFinite(volume.used_percent)?volume.used_percent.toFixed(1)+'%':'—']));if(volumes.some(row=>row.legacy))target.append(element('p','此 Agent 尚未上报本地卷列表，当前仅有系统盘容量。','metric-note'));}
  else target.append(element('p','等待磁盘容量采集。','empty-note'));
  if(disks.length){table(['物理磁盘','容量 / 关联卷','读取 / 写入','读 / 写 IOPS','队列深度'],disks.map(disk=>{const linked=volumes.filter(volume=>Number.isInteger(disk.number)&&volume.disk_number===disk.number).map(volume=>volume.name||volume.mount).join('、');return [Number.isInteger(disk.number)?'磁盘 '+disk.number+' · '+disk.name:disk.name,[Number.isFinite(disk.total_bytes)?gib(disk.total_bytes):'',linked].filter(Boolean).join(' · ')||'—',rate(disk.read_bps)+' / '+rate(disk.write_bps),[disk.read_iops,disk.write_iops].map(value=>Number.isFinite(value)?value.toFixed(1):'—').join(' / '),Number.isFinite(disk.queue_depth)?String(disk.queue_depth):'—'];}));target.append(element('p','每块磁盘的吞吐与 IOPS 使用连续两轮采样计算；新接入或重启后等待下一个采样周期。','metric-note'));}
}

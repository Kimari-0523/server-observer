import os from 'node:os';
import {readFileSync,writeFileSync,existsSync,chmodSync,statfsSync,renameSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {hostAddresses,isVirtualInterface} from './addresses.mjs';
import {discoverPublicIPv4,validCachedAddress,probeRetryInterval} from './public-ip.mjs';
const exec=promisify(execFile),path=process.env.MONITOR_CONFIG||'agent.json';
let config=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const backend=new URL(config.backend);if(backend.protocol!=='https:'&&!(backend.protocol==='http:'&&backend.hostname==='127.0.0.1'))throw new Error('Agent requires HTTPS, except for local loopback');
async function post(path,body,headers={}){const r=await fetch(new URL(path,backend),{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!r.ok){let detail='';try{const value=await r.json();if(typeof value.error==='string')detail=': '+value.error.slice(0,180);}catch{}throw new Error(`Monitor HTTP ${r.status}${detail}`);}return r.json();}
if(!config.id){const identity=config.identity||(process.platform==='linux'&&existsSync('/etc/machine-id')?readFileSync('/etc/machine-id','utf8').trim():randomUUID());const result=await post('/agent/enroll',{identity,token:config.enrollment_token,name:os.hostname(),platform:process.platform});config={...config,id:result.id,token:result.token,identity,watchdog:result.watchdog,report_interval_seconds:result.report_interval_seconds};delete config.enrollment_token;writeFileSync(path,JSON.stringify(config,null,2),{mode:0o600});if(process.platform!=='win32')chmodSync(path,0o600);}
function cpus(){return os.cpus().reduce((a,c)=>{a.idle+=c.times.idle;a.total+=Object.values(c.times).reduce((x,y)=>x+y,0);return a;},{idle:0,total:0});}
function privateIPv4(ip){if(isIP(ip)!==4)return false;const[a,b]=ip.split('.').map(Number);return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127);}
function pressure(name){try{const text=readFileSync('/proc/pressure/'+name,'utf8'),match=/^some\s+.*?\bavg10=(\d+(?:\.\d+)?)/m.exec(text);return match?Number(match[1]):undefined;}catch{return undefined;}}
function retainDeviceInventory(devices,cached,now,available){
  if(available){const metadata=(devices.disks||[]).map(({name,number,total_bytes})=>({name,number,total_bytes}));return {devices:{...devices,device_inventory_cached:false,device_inventory_collected_at:now},cache:{volumes:devices.volumes,disks:metadata,collected_at:now}};}
  if(cached&&now-cached.collected_at<86400000)return {devices:{...devices,volumes:cached.volumes,disks:cached.disks,device_inventory_cached:true,device_inventory_collected_at:cached.collected_at},cache:cached};
  return {devices,cache:undefined};
}
function parseLinuxVolumes(text){
  const volumes=[],seen=new Set();
  for(const line of text.trim().split('\n').slice(1)){
    const [name,filesystem,total,used,free,percent,...paths]=line.trim().split(/\s+/),mount=paths.join(' ').replaceAll('\\040',' ');
    if(!/^(ext[234]|xfs|btrfs|zfs|f2fs|ntfs|vfat|exfat|bcachefs|fuseblk)$/.test(filesystem||'')||!mount||/^\/(proc|sys|dev|run)(\/|$)/.test(mount)||seen.has(name)||!Number.isFinite(+total)||+total<=0)continue;
    seen.add(name);volumes.push({name,mount,filesystem,total_bytes:+total,used_bytes:+used,free_bytes:+free,used_percent:parseFloat(percent)});
  }
  return volumes;
}
function diskSnapshots(disks,previousDisks,seconds){
  return (disks||[]).map(disk=>{const value={...disk},old=(previousDisks||[]).find(item=>item.name===disk.name);
    if(old&&seconds>0)for(const [counter,key]of [['read_bytes','read_bps'],['write_bytes','write_bps'],['reads','read_iops'],['writes','write_iops']])if(Number.isFinite(disk[counter])&&Number.isFinite(old[counter]))value[key]=Math.max(0,disk[counter]-old[counter])/seconds;
    if(old&&seconds>0&&Number.isFinite(disk.io_ms)&&Number.isFinite(old.io_ms))value.utilization_percent=Math.min(100,Math.max(0,disk.io_ms-old.io_ms)/(seconds*10));
    return value;});
}
async function linux(){
  const net=readFileSync('/proc/net/dev','utf8').split('\n').slice(2).filter(v=>v.includes(':')).map(v=>{const [name,raw]=v.split(':'),a=raw.trim().split(/\s+/).map(Number);return {name:name.trim(),rx:a[0],tx:a[8]};}).filter(v=>v.name!=='lo');
  const disks=readFileSync('/proc/diskstats','utf8').trim().split('\n').map(l=>l.trim().split(/\s+/)).filter(a=>/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(a[2])).map(a=>({name:a[2],reads:+a[3],read_bytes:+a[5]*512,writes:+a[7],write_bytes:+a[9]*512,io_ms:+a[12]}));
  const raw=(await exec('df',['-P','-B1','/'],{timeout:5000})).stdout.trim().split('\n').at(-1).trim().split(/\s+/);
  let volumes=[],collection_errors=[];try{volumes=parseLinuxVolumes((await exec('df',['-P','-B1','-T','-l'],{timeout:5000,maxBuffer:262144})).stdout);}catch{collection_errors=['disk_volumes'];}
  const mem=Object.fromEntries(readFileSync('/proc/meminfo','utf8').split('\n').filter(v=>v.includes(':')).map(v=>{const [k,n]=v.split(':');return [k,Number(n.trim().split(/\s+/)[0])*1024];}));
  return {memory_percent:100*(1-mem.MemAvailable/mem.MemTotal),disk_percent:parseFloat(raw[4]),disk_total_bytes:Number(raw[1]),disk_used_bytes:Number(raw[2]),io_pressure_percent:pressure('io'),cpu_pressure_percent:pressure('cpu'),memory_pressure_percent:pressure('memory'),network_rx:net.reduce((a,v)=>a+v.rx,0),network_tx:net.reduce((a,v)=>a+v.tx,0),disk_read:disks.reduce((a,v)=>a+v.read_bytes,0),disk_write:disks.reduce((a,v)=>a+v.write_bytes,0),disks,volumes,collection_errors,interfaces:net};
}
async function windows(){
  // Basic host metrics must survive slow or broken WMI performance providers.
  const basic={memory_percent:100*(1-os.freemem()/os.totalmem())};
  try{const drive=(process.env.SystemDrive||'C:').replace(/[\\/]+$/,'')+'\\',disk=statfsSync(drive),total=disk.blocks*disk.bsize,free=disk.bavail*disk.bsize;if(total>0)Object.assign(basic,{disk_total_bytes:total,disk_used_bytes:total-free,disk_percent:100*(1-free/total)});}catch{}
  const script=String.raw`$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$result=@{windows_counter_errors=@()}
try {
  [double]$rx=0;[double]$tx=0
  foreach($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){
    if($adapter.OperationalStatus -ne [Net.NetworkInformation.OperationalStatus]::Up -or $adapter.NetworkInterfaceType -in @([Net.NetworkInformation.NetworkInterfaceType]::Loopback,[Net.NetworkInformation.NetworkInterfaceType]::Tunnel)){continue}
    $stats=$adapter.GetIPv4Statistics();$rx+=$stats.BytesReceived;$tx+=$stats.BytesSent
  }
  $result.network_rx=$rx;$result.network_tx=$tx
} catch {$result.windows_counter_errors+='network'}
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class ObserverDiskCounters {
  public sealed class DiskRecord { public int Number; public double TotalBytes; public bool Available; public long BytesRead,BytesWritten; public uint ReadCount,WriteCount,QueueDepth; }
  public sealed class VolumeRecord { public int Number=-1; public string Id=""; }
  [StructLayout(LayoutKind.Sequential)] public struct DeviceNumber { public uint Type,Number,Partition; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DiskPerformance {
    public long BytesRead, BytesWritten, ReadTime, WriteTime, IdleTime;
    public uint ReadCount, WriteCount, QueueDepth, SplitCount;
    public long QueryTime;
    public uint StorageDeviceNumber;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=8)] public string StorageManagerName;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle device, uint code, IntPtr input, uint inputLength, out DiskPerformance output, uint outputLength, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", EntryPoint="DeviceIoControl", SetLastError=true)]
  static extern bool DeviceNumberQuery(SafeFileHandle device, uint code, IntPtr input, uint inputLength, out DeviceNumber output, uint outputLength, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", EntryPoint="DeviceIoControl", SetLastError=true)]
  static extern bool GeometryQuery(SafeFileHandle device, uint code, IntPtr input, uint inputLength, [Out] byte[] output, uint outputLength, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeNameForVolumeMountPoint(string mount, StringBuilder name, uint length);
  public static VolumeRecord Volume(string mount) {
    VolumeRecord record=new VolumeRecord();StringBuilder name=new StringBuilder(1024);
    if(GetVolumeNameForVolumeMountPoint(mount,name,1024))record.Id=name.ToString();
    if(mount.Length<2||mount[1]!=':')return record;
    using(SafeFileHandle handle=CreateFile(@"\\.\"+mount.Substring(0,2),0,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
      if(!handle.IsInvalid){DeviceNumber device;uint returned;if(DeviceNumberQuery(handle,0x2d1080,IntPtr.Zero,0,out device,12,out returned,IntPtr.Zero)&&device.Number<int.MaxValue)record.Number=(int)device.Number;}
    }
    return record;
  }
  public static DiskRecord[] ReadDisks() {
    List<DiskRecord> records=new List<DiskRecord>();
    for(int i=0;i<32;i++) {
      using(SafeFileHandle handle=CreateFile(@"\\.\PhysicalDrive"+i,0,3,IntPtr.Zero,3,0,IntPtr.Zero)) {
        if(handle.IsInvalid)continue;
        DiskRecord record=new DiskRecord();record.Number=i;uint returned;byte[] geometry=new byte[1024];
        if(GeometryQuery(handle,0x700a0,IntPtr.Zero,0,geometry,(uint)geometry.Length,out returned,IntPtr.Zero)&&returned>=32)record.TotalBytes=BitConverter.ToInt64(geometry,24);
        DiskPerformance value;
        if(DeviceIoControl(handle,0x70020,IntPtr.Zero,0,out value,(uint)Marshal.SizeOf(typeof(DiskPerformance)),out returned,IntPtr.Zero)) {record.Available=true;record.BytesRead=value.BytesRead;record.BytesWritten=value.BytesWritten;record.ReadCount=value.ReadCount;record.WriteCount=value.WriteCount;record.QueueDepth=value.QueueDepth;}
        records.Add(record);
      }
    }
    return records.ToArray();
  }
}
'@
  $devices=@([ObserverDiskCounters]::ReadDisks());$rows=@();[double]$read=0;[double]$write=0;[double]$reads=0;[double]$writes=0;[double]$queue=0;$available=0
  foreach($disk in $devices){$row=@{name='PhysicalDrive'+$disk.Number;number=$disk.Number;total_bytes=$disk.TotalBytes;counters_available=$disk.Available};if($disk.Available){$available++;$row.read_bytes=[double]$disk.BytesRead;$row.write_bytes=[double]$disk.BytesWritten;$row.reads=[double]$disk.ReadCount;$row.writes=[double]$disk.WriteCount;$row.queue_depth=$disk.QueueDepth;$read+=$disk.BytesRead;$write+=$disk.BytesWritten;$reads+=$disk.ReadCount;$writes+=$disk.WriteCount;$queue+=$disk.QueueDepth};$rows+=$row}
  $result.disks=@($rows);$result.disk_device_count=$devices.Count
  if(-not $available){throw 'No disk performance handles'}
  $result.disk_read=$read;$result.disk_write=$write;$result.reads=$reads;$result.writes=$writes;$result.disk_queue_depth=$queue
} catch {$result.windows_counter_errors+='disk';$result.disk_error=$_.Exception.Message}
try {
  $volumes=@();$seen=@{}
  foreach($drive in [IO.DriveInfo]::GetDrives()){
    if($drive.DriveType -ne [IO.DriveType]::Fixed -or -not $drive.IsReady){continue}
    try {$map=[ObserverDiskCounters]::Volume($drive.Name);$key=if($map.Id){$map.Id}else{$drive.Name};if($seen.ContainsKey($key)){continue};$seen[$key]=$true;[double]$total=$drive.TotalSize;[double]$free=$drive.AvailableFreeSpace;$volumes+=@{name=$drive.Name.TrimEnd([char]92);mount=$drive.Name;label=$drive.VolumeLabel;filesystem=$drive.DriveFormat;total_bytes=$total;used_bytes=$total-$free;free_bytes=$free;used_percent=if($total -gt 0){100*(1-$free/$total)}else{0};disk_number=if($map.Number -ge 0){$map.Number}else{$null}}} catch {$result.windows_counter_errors+='disk_volumes'}
  }
  $result.volumes=@($volumes)
} catch {$result.windows_counter_errors+='disk_volumes'}
$result|ConvertTo-Json -Compress -Depth 4`;
  try{const encoded=Buffer.from(script,'utf16le').toString('base64'),result=await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{timeout:30000,windowsHide:true,maxBuffer:131072});return {...basic,...JSON.parse(result.stdout.replace(/^\uFEFF/,''))};}
  catch(e){console.error('Windows performance counters unavailable; reporting basic metrics:',e.killed?'timeout':e.code||'failed');return {...basic,windows_counter_errors:['performance_query_failed']};}
}
let previous,previousCpu=cpus(),observedPublicIP,publicAddress={address:null,source:'unavailable'},ipv4CheckedAt=0,deviceInventoryCache;
const addressCachePath=join(dirname(resolve(path)),'public-ip-cache.json');
try{const cached=JSON.parse(readFileSync(addressCachePath,'utf8'));if(validCachedAddress(cached))publicAddress=cached;}catch{}
async function discoverIPv4(){
  if(Date.now()-ipv4CheckedAt<probeRetryInterval(publicAddress.address))return;ipv4CheckedAt=Date.now();
  try{const found=await discoverPublicIPv4({interfaces:os.networkInterfaces(),probeUrls:config.public_ip_probe_urls});
    if(found.address){publicAddress={...found,checked_at:Date.now()};try{writeFileSync(addressCachePath+'.new',JSON.stringify(publicAddress),{mode:0o600});renameSync(addressCachePath+'.new',addressCachePath);}catch{}}
    else if(!validCachedAddress(publicAddress))publicAddress={...found,checked_at:Date.now()};
  }catch{}
}
async function collect(){const started=Date.now(),cpu=cpus(),delta=cpu.total-previousCpu.total;const metrics={cpu_percent:delta?100*(1-(cpu.idle-previousCpu.idle)/delta):0};previousCpu=cpu;
  const raw=process.platform==='linux'?await linux():await windows();let devices={};
  if(process.platform==='linux'){devices={disks:raw.disks,interfaces:raw.interfaces};metrics.memory_percent=raw.memory_percent;metrics.disk_percent=raw.disk_percent;if(previous){const seconds=(started-previous.started)/1000;for(const [name,key]of [['network_rx','network_rx_bps'],['network_tx','network_tx_bps'],['disk_read','disk_read_bps'],['disk_write','disk_write_bps']])metrics[key]=Math.max(0,raw[name]-previous.raw[name])/seconds;for(const name of ['reads','writes']){const diff=raw.disks.reduce((sum,d)=>{const old=previous.raw.disks.find(o=>o.name===d.name);return sum+(old?Math.max(0,d[name]-old[name]):0);},0);metrics[name==='reads'?'disk_read_iops':'disk_write_iops']=diff/seconds;}}}else {
    const counters=['network_rx','network_tx','disk_read','disk_write','reads','writes'];
    for(const [k,v]of Object.entries(raw))if(Number.isFinite(v)&&!counters.includes(k))metrics[k]=v;
    if(previous){const seconds=(started-previous.started)/1000;if(seconds>0)for(const [counter,key]of [['network_rx','network_rx_bps'],['network_tx','network_tx_bps'],['disk_read','disk_read_bps'],['disk_write','disk_write_bps'],['reads','disk_read_iops'],['writes','disk_write_iops']])if(Number.isFinite(raw[counter])&&Number.isFinite(previous.raw[counter]))metrics[key]=Math.max(0,raw[counter]-previous.raw[counter])/seconds;}
  }
  devices={...devices,disks:diskSnapshots(raw.disks,previous?.raw?.disks,previous?(started-previous.started)/1000:0),volumes:raw.volumes||[]};
  if(process.platform==='win32'){const inventory=retainDeviceInventory(devices,deviceInventoryCache,started,Array.isArray(raw.volumes)&&Array.isArray(raw.disks));devices=inventory.devices;deviceInventoryCache=inventory.cache;}
  previous={started,raw};const interfaces=Object.entries(os.networkInterfaces()).flatMap(([name,list])=>(list||[]).filter(v=>!v.internal).map(v=>({name,address:v.address})));
  const private_ips=hostAddresses(os.networkInterfaces()),hostIPv4=interfaces.filter(v=>isIP(v.address)===4&&!isVirtualInterface(v.name));
  const private_ipv4=hostIPv4.find(v=>privateIPv4(v.address))?.address||null;
  const public_ipv4=publicAddress.address;
  const services=[];for(const name of config.services||[]){if(!/^[a-zA-Z0-9_.@-]{1,100}$/.test(name))continue;try{if(process.platform==='linux'){const r=await exec('systemctl',['is-active',name],{timeout:5000});services.push({name,state:r.stdout.trim()});}else{const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Service -Name '${name}').Status.ToString()`],{timeout:5000});services.push({name,state:r.stdout.trim()});}}catch(e){services.push({name,state:e.stdout?.trim()||'unknown'});}}
  // JSON formatting touches the Size field; explicitly disable expensive writable-layer scans.
  let containers=[],docker_status='unavailable';try{const r=await exec('docker',['ps','-a','--size=false','--format','{{json .}}'],{timeout:10000,maxBuffer:262144});containers=r.stdout.trim().split('\n').filter(Boolean).map(v=>{const c=JSON.parse(v),labels=Object.fromEntries(String(c.Labels||'').split(',').map(s=>{const i=s.indexOf('=');return[s.slice(0,i).trim(),s.slice(i+1)];}));return {id:c.ID,name:c.Names,image:c.Image,state:c.State,status:c.Status,ports:c.Ports,compose_project:labels['com.docker.compose.project']||'',compose_service:labels['com.docker.compose.service']||''};});docker_status='ok';}catch{}
  for(const k of ['disk_total_bytes','disk_used_bytes','io_pressure_percent','cpu_pressure_percent','memory_pressure_percent'])if(Number.isFinite(raw[k]))metrics[k]=raw[k];
  return {private_ips,private_ipv4,public_ipv4,public_ipv4_source:publicAddress.source,public_ipv4_checked_at:publicAddress.checked_at||null,public_ip:observedPublicIP,metrics,collection_errors:[...(raw.windows_counter_errors||[]),...(raw.collection_errors||[])],pressure_supported:process.platform==='linux'&&Number.isFinite(metrics.cpu_pressure_percent),...devices,services,containers,docker_status};
}
async function tick(){try{const report=await collect();await post('/agent/report',report,{'x-agent-id':config.id,authorization:`Bearer ${config.token}`});}catch(e){console.error(new Date().toISOString(),e.message);}}
// The watchdog uses a separate timer and credentials, so failure of the
// detailed-metrics backend does not stop Cloudflare heartbeats.
async function heartbeat(){if(!config.watchdog)return;try{const target=new URL(config.watchdog.url);if(target.protocol!=='https:')throw new Error('Watchdog requires HTTPS');const r=await fetch(target,{method:'POST',headers:{'x-agent-id':config.watchdog.id,authorization:`Bearer ${config.watchdog.token}`},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`Watchdog HTTP ${r.status}`);observedPublicIP=r.headers.get('x-observed-ip')||observedPublicIP;}catch(e){console.error(new Date().toISOString(),e.message);}}
let busy=false;
try{const {startRemote}=await import('./terminal-agent.mjs');const remote=startRemote(config);for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{remote.close();setTimeout(()=>process.exit(0),1500);});}catch(e){console.error('Remote terminal unavailable:',e.message);}
async function guardedTick(){if(busy)return;busy=true;try{await tick();}finally{busy=false;}}
const firstIPv4Discovery=discoverIPv4();setInterval(discoverIPv4,30000);
heartbeat();setInterval(heartbeat,60000);
await new Promise(resolve=>setTimeout(resolve,1000));
await firstIPv4Discovery;
await guardedTick();setInterval(guardedTick,Math.min(3600,Math.max(30,Number(config.report_interval_seconds)||60))*1000);

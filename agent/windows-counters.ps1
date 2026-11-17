$ProgressPreference='SilentlyContinue'
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
$result|ConvertTo-Json -Compress -Depth 4

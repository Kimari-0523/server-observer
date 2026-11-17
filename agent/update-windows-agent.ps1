param([Parameter(Mandatory=$true)][string]$ExpectedComputerName)
$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -ine $ExpectedComputerName){throw 'Computer name mismatch; no changes made'}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator privileges required'}
[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$base=Join-Path $env:ProgramFiles 'ServerObserverAgent'
$task=Get-ScheduledTask -TaskName 'ServerObserverAgent'
$node=$task.Actions[0].Execute
if(-not [IO.Path]::GetFullPath($node).StartsWith([IO.Path]::GetFullPath($base)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected Agent runtime path'}
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')
$backup=Join-Path $base ('backup-ip-'+$stamp)
$staging=Join-Path $base ('downloads/ip-update-'+$stamp)
New-Item -ItemType Directory -Force -Path $backup,$staging | Out-Null
$hashes=@{'agent.mjs'='__AGENT_SHA256__';'public-ip.mjs'='__PUBLIC_IP_SHA256__';'addresses.mjs'='__ADDRESSES_SHA256__'}
foreach($name in $hashes.Keys){
  $path=Join-Path $staging $name
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri ('__PUBLIC_ORIGIN__/downloads/'+$name) -OutFile $path
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash -ne $hashes[$name]){throw ('Checksum mismatch: '+$name)}
  & $node --check $path
  if($LASTEXITCODE -ne 0){throw ('Invalid module: '+$name)}
  $old=Join-Path $base $name
  if(Test-Path -LiteralPath $old){Copy-Item -LiteralPath $old -Destination (Join-Path $backup $name)}
}
$taskName='ServerObserverAgent-ApplyUpdate-'+$stamp
$helper=Join-Path $base ('apply-ip-update-'+$stamp+'.ps1')
$code=@'
$ErrorActionPreference='Stop'
$base='__BASE__'
$backup='__BACKUP__'
$taskName='__TASK__'
$log=Join-Path $base 'ip-update.log'
try {
  Stop-ScheduledTask -TaskName 'ServerObserverAgent'
  Start-Sleep -Seconds 3
  Start-ScheduledTask -TaskName 'ServerObserverAgent'
  Start-Sleep -Seconds 8
  if((Get-ScheduledTask -TaskName 'ServerObserverAgent').State -ne 'Running'){throw 'Agent task did not remain running'}
  Add-Content -LiteralPath $log -Value ((Get-Date -Format o)+' Agent update restart completed')
} catch {
  foreach($name in @('agent.mjs','public-ip.mjs','addresses.mjs')){if(Test-Path -LiteralPath (Join-Path $backup $name)){Copy-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $base $name) -Force}}
  Start-ScheduledTask -TaskName 'ServerObserverAgent'
  Add-Content -LiteralPath $log -Value ((Get-Date -Format o)+' Rolled back: '+$_.Exception.Message)
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
'@
$code=$code.Replace('__BASE__',$base.Replace("'","''")).Replace('__BACKUP__',$backup.Replace("'","''")).Replace('__TASK__',$taskName)
[IO.File]::WriteAllText($helper,$code,[Text.UTF8Encoding]::new($false))
$action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$helper+'"')
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30)
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
try {
  foreach($name in @('addresses.mjs','public-ip.mjs','agent.mjs')){Copy-Item -LiteralPath (Join-Path $staging $name) -Destination (Join-Path $base $name) -Force}
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User SYSTEM -RunLevel Highest | Out-Null
} catch {
  foreach($name in $hashes.Keys){if(Test-Path -LiteralPath (Join-Path $backup $name)){Copy-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $base $name) -Force}}
  throw
}
Write-Output ('Agent files verified and backed up at '+$backup)
Write-Output ('Agent restart scheduled in 30 seconds; temporary task '+$taskName+' removes itself on completion. Windows and business services are not restarted.')

param([Parameter(Mandatory=$true)][string]$Token)
$ErrorActionPreference='Stop'
trap { Write-Host ('Installation failed at script line '+$_.InvocationInfo.ScriptLineNumber+': '+$_.Exception.Message) -ForegroundColor Red; if($installLog){Write-Host ('Installation log: '+$installLog); try { Stop-Transcript | Out-Null } catch {}}; throw }
if($PSVersionTable.PSVersion -lt [version]'5.1'){throw 'PowerShell 5.1 or newer is required'}
[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Get-OfficialChecksum([string]$Text,[string]$FileName){
  foreach($line in ($Text -split '\r?\n')){if($line -match '^(?<hash>[a-fA-F0-9]{64})\s+\*?(?<file>\S+)\s*$' -and $Matches['file'] -ceq $FileName){return $Matches['hash']}}
  throw ('Official Node.js checksum entry was not found for '+$FileName)
}
if($Token -notmatch '^[A-Za-z0-9_-]{32,128}$'){throw 'Invalid enrollment token'}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this command in an Administrator PowerShell window'}
$nativeArch=$env:PROCESSOR_ARCHITEW6432
if([string]::IsNullOrEmpty($nativeArch)){$nativeArch=$env:PROCESSOR_ARCHITECTURE}
switch($nativeArch.ToUpperInvariant()){'AMD64'{$arch='x64'} 'ARM64'{$arch='arm64'} default {throw ('Unsupported CPU architecture: '+$nativeArch)}}
$base=Join-Path $env:ProgramFiles 'ServerObserverAgent'
$downloads=Join-Path $base 'downloads'
New-Item -ItemType Directory -Force -Path $base,$downloads | Out-Null
$installLog=Join-Path $base 'install.log'
Start-Transcript -Path $installLog -Append | Out-Null
$archive="node-v24.22.3-win-$arch.zip"
$nodeDir=Join-Path $base "node-v24.22.3-win-$arch"
if(-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))){
  Write-Host '[1/4] Downloading and verifying official Node.js runtime...'
  $shaPath=Join-Path $downloads 'SHASUMS256.txt'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.22.3/SHASUMS256.txt' -OutFile $shaPath
  $sha=[IO.File]::ReadAllText($shaPath,[Text.Encoding]::UTF8)
  $expected=Get-OfficialChecksum -Text $sha -FileName $archive
  if(-not (Test-Path -LiteralPath (Join-Path $downloads $archive)) -or (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $downloads $archive)).Hash -ne $expected){Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v24.22.3/$archive" -OutFile (Join-Path $downloads $archive)}
  if((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $downloads $archive)).Hash -ne $expected){throw 'Node.js checksum mismatch'}
  Expand-Archive -LiteralPath (Join-Path $downloads $archive) -DestinationPath $base -Force
}
$agent=Join-Path $base 'agent.mjs'
Write-Host '[2/4] Downloading monitoring agent...'
Invoke-WebRequest -UseBasicParsing -Uri '__PUBLIC_ORIGIN__/downloads/agent.mjs' -OutFile "$agent.new"
if((Get-FileHash -Algorithm SHA256 -LiteralPath "$agent.new").Hash -ne '__AGENT_SHA256__'){throw 'Agent checksum mismatch'}
Copy-Item -LiteralPath "$agent.new" -Destination $agent -Force
foreach($file in @('addresses.mjs','public-ip.mjs','terminal-agent.mjs','command-agent.mjs','windows-launcher.mjs','package.json','package-lock.json')){
  Invoke-WebRequest -UseBasicParsing -Uri ('__PUBLIC_ORIGIN__/downloads/'+$file) -OutFile (Join-Path $base $file)
}
$env:PATH=$nodeDir+';'+$env:PATH
Push-Location -LiteralPath $base
try {
  Write-Host '[3/4] Installing terminal dependencies...'
  & (Join-Path $nodeDir 'node.exe') (Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js') ci --omit=dev --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw 'Terminal dependency installation failed'}
  # A file avoids Windows PowerShell 5.1 stripping quotes from native -e arguments.
  $verify=Join-Path $base 'verify-terminal.mjs'
  [IO.File]::WriteAllText($verify,"await import('node-pty');",[Text.UTF8Encoding]::new($false))
  & (Join-Path $nodeDir 'node.exe') $verify
  if($LASTEXITCODE -ne 0){throw 'Terminal dependency verification failed'}
} finally { Pop-Location }
$config=Join-Path $base 'agent.json'
if(Test-Path -LiteralPath $config){
  $existing=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
  if(-not $existing.id){
    $existing | Add-Member -NotePropertyName enrollment_token -NotePropertyValue $Token -Force
    $existing | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $config -Encoding UTF8
  }
} else {
  $identity=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
  @{backend='__PUBLIC_ORIGIN__';enrollment_token=$Token;identity=$identity;services=@()} | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
}
& icacls.exe $base /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Failed to secure agent configuration permissions'}
$launcher=Join-Path $base 'windows-launcher.mjs'
$action=New-ScheduledTaskAction -Execute (Join-Path $nodeDir 'node.exe') -Argument ('"'+$launcher+'"') -WorkingDirectory $base
Write-Host '[4/4] Registering startup task...'
$trigger=New-ScheduledTaskTrigger -AtStartup
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'ServerObserverAgent' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'ServerObserverAgent'
Write-Host 'Agent startup task started. Confirm first report in the monitoring dashboard.'
Write-Host ('Agent log: '+(Join-Path $base 'agent.log'))
Stop-Transcript | Out-Null

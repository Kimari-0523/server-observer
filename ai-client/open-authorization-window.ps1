[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PythonExecutable,
    [string]$PlatformUrl = 'https://monitor.example.com'
)

$ErrorActionPreference = 'Stop'
$ObserverPythonPath = (Resolve-Path -LiteralPath $PythonExecutable).ProviderPath
$ObserverScriptPath = Join-Path $PSScriptRoot 'monitorctl.py'
$ObserverDialogPath = Join-Path $PSScriptRoot 'authorization-dialog.ps1'
if (-not (Test-Path -LiteralPath $ObserverScriptPath -PathType Leaf)) {
    throw 'monitorctl.py must be in the same directory as this launcher.'
}
if (-not (Test-Path -LiteralPath $ObserverDialogPath -PathType Leaf)) {
    throw 'authorization-dialog.ps1 must be in the same directory as this launcher.'
}
$ObserverUri = [Uri]$PlatformUrl
if (-not $ObserverUri.IsAbsoluteUri -or $ObserverUri.Scheme -ne 'https' -or
    $ObserverUri.UserInfo -or $ObserverUri.Query -or $ObserverUri.Fragment -or
    $ObserverUri.AbsolutePath.TrimEnd('/') -notin @('', '/api/ai/v1')) {
    throw 'Use the final HTTPS platform origin or its /api/ai/v1 URL.'
}

# This command contains paths and the public URL only. Never pass a grant here.
$ObserverQuotedDialog = $ObserverDialogPath.Replace("'", "''")
$ObserverQuotedConfig = (Join-Path $PSScriptRoot '.secrets/client.json').Replace("'", "''")
$ObserverQuotedUrl = $PlatformUrl.Replace("'", "''")
$ObserverCommand = @"
& '$ObserverQuotedDialog' -ConfigPath '$ObserverQuotedConfig' -PlatformUrl '$ObserverQuotedUrl'
"@
$ObserverEncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ObserverCommand))
$ObserverShell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $ObserverShell -PathType Leaf)) {
    throw 'Windows PowerShell is unavailable. Use a supported visible interactive terminal instead.'
}
$ObserverProcess = Start-Process -FilePath $ObserverShell `
    -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', $ObserverEncodedCommand) `
    -WindowStyle Hidden -PassThru
[pscustomobject]@{
    authorization_window_pid = $ObserverProcess.Id
    configuration_directory = (Join-Path $PSScriptRoot '.secrets')
    note = 'User enters the grant only in the new interactive window. No token is returned here.'
}

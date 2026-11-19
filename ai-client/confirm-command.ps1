[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$RequestFile, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ObserverRequest = [IO.File]::ReadAllText($RequestFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $ObserverRequest.job.id -or -not $ObserverRequest.job.server_id -or
    -not ($ObserverRequest.job.command -is [string]) -or -not $ObserverRequest.job.command.Trim()) {
    throw 'Invalid command confirmation request.'
}
[Windows.Forms.Application]::EnableVisualStyles()
$ObserverForm = [Windows.Forms.Form]::new()
$ObserverForm.Text = 'Server Observer - 本次服务器命令确认'
$ObserverForm.ClientSize = [Drawing.Size]::new(780, 540)
$ObserverForm.MinimumSize = [Drawing.Size]::new(650, 450)
$ObserverForm.StartPosition = 'CenterScreen'
$ObserverForm.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10)
$ObserverTitle = [Windows.Forms.Label]::new()
$ObserverTitle.Text = '是否执行以下服务器命令？请核对目标与完整命令'
$ObserverTitle.Font = [Drawing.Font]::new('Microsoft YaHei UI', 13, [Drawing.FontStyle]::Bold)
$ObserverTitle.SetBounds(18,14,742,30)
$ObserverTarget = [Windows.Forms.Label]::new()
$ObserverTarget.Text = "主机：$($ObserverRequest.server.name)    系统：$($ObserverRequest.server.platform)`r`n公网：$($ObserverRequest.server.public_ipv4)    内网：$($ObserverRequest.server.private_ipv4)`r`n服务器 ID：$($ObserverRequest.job.server_id)"
$ObserverTarget.SetBounds(18,54,742,76)
$ObserverCommand = [Windows.Forms.TextBox]::new()
$ObserverCommand.Multiline = $true
$ObserverCommand.ReadOnly = $true
$ObserverCommand.ScrollBars = 'Both'
$ObserverCommand.WordWrap = $false
$ObserverCommand.Font = [Drawing.Font]::new('Consolas', 10)
$ObserverCommand.Text = $ObserverRequest.job.command
$ObserverCommand.SetBounds(18,138,742,282)
$ObserverCommand.Anchor = 'Top,Bottom,Left,Right'
$ObserverCheck = [Windows.Forms.CheckBox]::new()
$ObserverCheck.Text = '我已核对目标和完整命令，同意执行本次命令'
$ObserverCheck.SetBounds(18,432,742,30)
$ObserverCheck.Anchor = 'Bottom,Left,Right'
$ObserverApprove = [Windows.Forms.Button]::new()
$ObserverApprove.Text = '确认执行本次命令'
$ObserverApprove.Enabled = $false
$ObserverApprove.SetBounds(334,486,170,36)
$ObserverApprove.Anchor = 'Bottom,Right'
$ObserverReject = [Windows.Forms.Button]::new()
$ObserverReject.Text = '拒绝执行'
$ObserverReject.SetBounds(518,486,116,36)
$ObserverReject.Anchor = 'Bottom,Right'
$ObserverLater = [Windows.Forms.Button]::new()
$ObserverLater.Text = '稍后确认'
$ObserverLater.SetBounds(648,486,112,36)
$ObserverLater.Anchor = 'Bottom,Right'
$ObserverLater.DialogResult = [Windows.Forms.DialogResult]::Cancel
$ObserverForm.Tag = 'cancelled'
$ObserverCheck.Add_CheckedChanged({ $ObserverApprove.Enabled = $ObserverCheck.Checked })
$ObserverApprove.Add_Click({
    if (-not $ObserverCheck.Checked) { return }
    $ObserverForm.Tag = 'approved'
    $ObserverForm.DialogResult = [Windows.Forms.DialogResult]::OK
    $ObserverForm.Close()
})
$ObserverReject.Add_Click({
    $ObserverForm.Tag = 'rejected'
    $ObserverForm.DialogResult = [Windows.Forms.DialogResult]::No
    $ObserverForm.Close()
})
$ObserverForm.Controls.AddRange(@($ObserverTitle,$ObserverTarget,$ObserverCommand,$ObserverCheck,$ObserverApprove,$ObserverReject,$ObserverLater))
$ObserverForm.CancelButton = $ObserverLater
$ObserverForm.TopMost = $true
$ObserverForm.Add_Shown({ [void]$ObserverForm.Activate(); [void]$ObserverCheck.Focus() })
try {
    if ($ValidateOnly) {
        $ObserverInitiallyDisabled = -not $ObserverApprove.Enabled
        $ObserverCheck.Checked = $true
        [pscustomobject]@{initially_disabled=$ObserverInitiallyDisabled;enabled_after_check=$ObserverApprove.Enabled;command_read_only=$ObserverCommand.ReadOnly;command_matches=($ObserverCommand.Text -eq $ObserverRequest.job.command);closed_preserves_pending=($ObserverForm.Tag -eq 'cancelled');has_defer_choice=($ObserverForm.CancelButton -eq $ObserverLater)}
        return
    }
    [void]$ObserverForm.ShowDialog()
    [pscustomobject]@{approved=($ObserverForm.Tag -eq 'approved');state=[string]$ObserverForm.Tag} | ConvertTo-Json -Compress
} finally {
    $ObserverCommand.Clear()
    $ObserverForm.Dispose()
}

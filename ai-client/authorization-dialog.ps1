[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$PlatformUrl = 'https://monitor.example.com',
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security

function Get-ObserverApiBase([string]$Url) {
    $Parsed = [Uri]$Url
    if (-not $Parsed.IsAbsoluteUri -or $Parsed.Scheme -ne 'https' -or
        $Parsed.UserInfo -or $Parsed.Query -or $Parsed.Fragment -or
        $Parsed.AbsolutePath.TrimEnd('/') -notin @('', '/api/ai/v1')) {
        throw 'Use the final HTTPS platform origin or its /api/ai/v1 URL.'
    }
    return $Parsed.GetLeftPart([UriPartial]::Authority) + '/api/ai/v1'
}

function Save-ObserverGrant([string]$Path, [string]$BaseUrl, [string]$Grant) {
    if ($Grant -cnotmatch '^(?:cm_ai_|so_ai_)[A-Za-z0-9_-]{43}$') {
        throw 'Invalid AI grant format.'
    }
    $BaseUrl = Get-ObserverApiBase $BaseUrl
    $FullPath = [IO.Path]::GetFullPath($Path)
    $Directory = [IO.Path]::GetDirectoryName($FullPath)
    foreach ($Existing in @($Directory, $FullPath)) {
        if ((Test-Path -LiteralPath $Existing) -and
            ((Get-Item -LiteralPath $Existing -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing to save credentials through a symbolic link.'
        }
    }
    [void][IO.Directory]::CreateDirectory($Directory)
    $Bytes = [Text.Encoding]::UTF8.GetBytes($Grant)
    try {
        $Protected = [Security.Cryptography.ProtectedData]::Protect(
            $Bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } finally {
        [Array]::Clear($Bytes, 0, $Bytes.Length)
    }
    $Json = [ordered]@{
        version = 1
        base_url = $BaseUrl
        token_storage = 'windows-dpapi'
        token_data = [Convert]::ToBase64String($Protected)
    } | ConvertTo-Json
    $Temporary = $FullPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($Temporary, $Json, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($FullPath)) {
            [IO.File]::Replace($Temporary, $FullPath, [NullString]::Value)
        } else {
            [IO.File]::Move($Temporary, $FullPath)
        }
    } finally {
        if ([IO.File]::Exists($Temporary)) { [IO.File]::Delete($Temporary) }
    }
}

$ObserverApiBase = Get-ObserverApiBase $PlatformUrl
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

[Windows.Forms.Application]::EnableVisualStyles()
$ObserverForm = [Windows.Forms.Form]::new()
$ObserverForm.Text = 'Server Observer - 授权密钥'
$ObserverForm.ClientSize = [Drawing.Size]::new(590, 300)
$ObserverForm.StartPosition = 'CenterScreen'
$ObserverForm.FormBorderStyle = 'FixedDialog'
$ObserverForm.MaximizeBox = $false
$ObserverForm.MinimizeBox = $false
$ObserverForm.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10)
$ObserverForm.AutoScaleMode = 'Dpi'

$ObserverHeading = [Windows.Forms.Label]::new()
$ObserverHeading.Text = '粘贴 AI 授权密钥'
$ObserverHeading.Font = [Drawing.Font]::new('Microsoft YaHei UI', 14, [Drawing.FontStyle]::Bold)
$ObserverHeading.SetBounds(22, 18, 540, 30)

$ObserverDescription = [Windows.Forms.Label]::new()
$ObserverDescription.Text = "使用 Ctrl+V、右键或「粘贴密钥」按钮。输入显示为圆点。`r`n仅填写 AI 长期授权；不要填写维护密码或 SSH 私钥。"
$ObserverDescription.SetBounds(22, 58, 548, 52)

$ObserverInput = [Windows.Forms.TextBox]::new()
$ObserverInput.UseSystemPasswordChar = $true
$ObserverInput.ShortcutsEnabled = $true
$ObserverInput.SetBounds(22, 118, 430, 30)

$ObserverPaste = [Windows.Forms.Button]::new()
$ObserverPaste.Text = '粘贴密钥'
$ObserverPaste.SetBounds(464, 116, 104, 34)

$ObserverStatus = [Windows.Forms.Label]::new()
$ObserverStatus.Text = '尚未输入。粘贴成功后，这里会显示字符数量和格式检查结果。'
$ObserverStatus.SetBounds(22, 163, 548, 42)

$ObserverSave = [Windows.Forms.Button]::new()
$ObserverSave.Text = '保存授权'
$ObserverSave.Enabled = $false
$ObserverSave.SetBounds(344, 240, 108, 36)

$ObserverCancel = [Windows.Forms.Button]::new()
$ObserverCancel.Text = '取消'
$ObserverCancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
$ObserverCancel.SetBounds(464, 240, 104, 36)

$ObserverContext = [Windows.Forms.ContextMenuStrip]::new()
$ObserverPasteItem = $ObserverContext.Items.Add('粘贴密钥')
$ObserverClearItem = $ObserverContext.Items.Add('清空')
$ObserverInput.ContextMenuStrip = $ObserverContext
$ObserverClipboardAction = {
    try {
        if ([Windows.Forms.Clipboard]::ContainsText()) {
            $ObserverInput.Text = [Windows.Forms.Clipboard]::GetText().Trim()
            $ObserverInput.SelectionStart = $ObserverInput.TextLength
            [void]$ObserverInput.Focus()
        } else {
            $ObserverStatus.Text = '剪贴板没有文本，请先在监测网页复制 AI 授权密钥。'
        }
    } catch {
        $ObserverStatus.Text = '剪贴板暂时不可用，请稍后重试或在输入框按 Ctrl+V。'
    }
}
$ObserverPaste.Add_Click($ObserverClipboardAction)
$ObserverPasteItem.Add_Click($ObserverClipboardAction)
$ObserverClearItem.Add_Click({ $ObserverInput.Clear() })
$ObserverInput.Add_TextChanged({
    $ObserverValue = $ObserverInput.Text.Trim()
    $ObserverValid = $ObserverValue -cmatch '^(?:cm_ai_|so_ai_)[A-Za-z0-9_-]{43}$'
    $ObserverSave.Enabled = $ObserverValid
    if (-not $ObserverValue.Length) {
        $ObserverStatus.Text = '尚未输入。请粘贴 AI 授权密钥。'
    } elseif ($ObserverValid) {
        $ObserverStatus.Text = "已填入 $($ObserverValue.Length) 个字符，格式正确。请点击「保存授权」。"
        $ObserverStatus.ForeColor = [Drawing.Color]::DarkGreen
    } else {
        $ObserverStatus.Text = "已填入 $($ObserverValue.Length) 个字符，格式不正确。请复制完整的 AI 授权密钥。"
        $ObserverStatus.ForeColor = [Drawing.Color]::Firebrick
    }
})
$ObserverSave.Add_Click({
    try {
        Save-ObserverGrant -Path $ConfigPath -BaseUrl $ObserverApiBase -Grant $ObserverInput.Text.Trim()
        $ObserverInput.Clear()
        [void][Windows.Forms.MessageBox]::Show($ObserverForm,
            '授权已加密保存。可以返回配置 AI 继续检查连接。', '保存成功',
            [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information)
        $ObserverForm.DialogResult = [Windows.Forms.DialogResult]::OK
        $ObserverForm.Close()
    } catch {
        $ObserverStatus.Text = '保存失败。请检查当前用户是否有目录写入权限，或请配置 AI 检查环境。'
        $ObserverStatus.ForeColor = [Drawing.Color]::Firebrick
    }
})
$ObserverForm.Controls.AddRange(@($ObserverHeading, $ObserverDescription, $ObserverInput,
    $ObserverPaste, $ObserverStatus, $ObserverSave, $ObserverCancel))
$ObserverForm.AcceptButton = $ObserverSave
$ObserverForm.CancelButton = $ObserverCancel
$ObserverForm.Add_Shown({ [void]$ObserverForm.Activate(); [void]$ObserverInput.Focus() })
try {
    if ($ValidateOnly) {
        $ObserverEmptyDisabled = -not $ObserverSave.Enabled
        $ObserverInput.Text = 'so_ai_' + ('A' * 43)
        $ObserverValidEnabled = $ObserverSave.Enabled
        $ObserverInput.Text = 'not-a-valid-grant'
        $ObserverInvalidDisabled = -not $ObserverSave.Enabled
        [pscustomobject]@{
            masked_input = $ObserverInput.UseSystemPasswordChar
            paste_shortcuts = $ObserverInput.ShortcutsEnabled
            context_menu_items = $ObserverContext.Items.Count
            empty_save_disabled = $ObserverEmptyDisabled
            valid_save_enabled = $ObserverValidEnabled
            invalid_save_disabled = $ObserverInvalidDisabled
        }
        return
    }
    [void]$ObserverForm.ShowDialog()
} finally {
    $ObserverInput.Clear()
    $ObserverContext.Dispose()
    $ObserverForm.Dispose()
}

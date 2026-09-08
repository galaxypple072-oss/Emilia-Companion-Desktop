param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$envPath = Join-Path $ProjectRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
  [System.Windows.Forms.MessageBox]::Show(
    "没有找到 $envPath`n请从 personal-companion 项目的 scripts 目录运行此工具。",
    "Emilia 中继配置",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}

function Get-EnvValue([string]$Name) {
  $line = Get-Content -LiteralPath $envPath -ErrorAction Stop |
    Where-Object { $_ -match ('^' + [regex]::Escape($Name) + '=') } |
    Select-Object -Last 1
  if ($null -eq $line) { return "" }
  return ($line -replace ('^' + [regex]::Escape($Name) + '='), '')
}

function Set-RelayConfig([string]$Url, [string]$PairingCode) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$envPath.relay-backup-$timestamp"
  Copy-Item -LiteralPath $envPath -Destination $backupPath -ErrorAction Stop

  $lines = @(Get-Content -LiteralPath $envPath -ErrorAction Stop | Where-Object {
    $_ -notmatch '^COMPANION_RELAY_(ENABLED|URL|PAIRING_CODE)='
  })
  while ($lines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($lines[-1])) {
    if ($lines.Count -eq 1) { $lines = @(); break }
    $lines = @($lines[0..($lines.Count - 2)])
  }
  $updated = @($lines) + @(
    "",
    "COMPANION_RELAY_ENABLED=true",
    "COMPANION_RELAY_URL=$Url",
    "COMPANION_RELAY_PAIRING_CODE=$PairingCode",
    ""
  )
  $tempPath = "$envPath.relay-new"
  [System.IO.File]::WriteAllLines($tempPath, $updated, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $envPath -Force
  return $backupPath
}

function New-ConnectionCode([string]$Url, [string]$PairingCode) {
  $payload = [ordered]@{
    version = 1
    mode = "relay"
    url = $Url
    pairingCode = $PairingCode
  }
  $json = $payload | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  return "emilia-connect1.$encoded"
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Emilia 私密中继配置"
$form.ClientSize = New-Object System.Drawing.Size(620, 360)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "连接 Windows Core 到私密中继"
$title.Location = New-Object System.Drawing.Point(28, 24)
$title.Size = New-Object System.Drawing.Size(560, 32)
$title.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 15, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($title)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "保存后会复制一枚完整连接码，Mac 只需粘贴一次。"
$hint.Location = New-Object System.Drawing.Point(30, 62)
$hint.Size = New-Object System.Drawing.Size(550, 24)
$hint.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($hint)

$urlLabel = New-Object System.Windows.Forms.Label
$urlLabel.Text = "私密中继地址"
$urlLabel.Location = New-Object System.Drawing.Point(30, 104)
$urlLabel.Size = New-Object System.Drawing.Size(180, 24)
$form.Controls.Add($urlLabel)

$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Location = New-Object System.Drawing.Point(30, 132)
$urlBox.Size = New-Object System.Drawing.Size(555, 30)
$urlBox.Text = Get-EnvValue "COMPANION_RELAY_URL"
$form.Controls.Add($urlBox)

$codeLabel = New-Object System.Windows.Forms.Label
$codeLabel.Text = "配对码（从 Mac 粘贴）"
$codeLabel.Location = New-Object System.Drawing.Point(30, 180)
$codeLabel.Size = New-Object System.Drawing.Size(240, 24)
$form.Controls.Add($codeLabel)

$codeBox = New-Object System.Windows.Forms.TextBox
$codeBox.Location = New-Object System.Drawing.Point(30, 208)
$codeBox.Size = New-Object System.Drawing.Size(555, 30)
$codeBox.UseSystemPasswordChar = $true
$codeBox.Text = Get-EnvValue "COMPANION_RELAY_PAIRING_CODE"
$form.Controls.Add($codeBox)

$showBox = New-Object System.Windows.Forms.CheckBox
$showBox.Text = "显示配对码"
$showBox.Location = New-Object System.Drawing.Point(32, 246)
$showBox.Size = New-Object System.Drawing.Size(150, 26)
$showBox.Add_CheckedChanged({ $codeBox.UseSystemPasswordChar = -not $showBox.Checked })
$form.Controls.Add($showBox)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(30, 282)
$status.Size = New-Object System.Drawing.Size(365, 42)
$status.ForeColor = [System.Drawing.Color]::Firebrick
$form.Controls.Add($status)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = "保存并复制连接码"
$saveButton.Location = New-Object System.Drawing.Point(410, 282)
$saveButton.Size = New-Object System.Drawing.Size(175, 42)
$saveButton.BackColor = [System.Drawing.Color]::FromArgb(116, 82, 155)
$saveButton.ForeColor = [System.Drawing.Color]::White
$saveButton.FlatStyle = "Flat"
$saveButton.Add_Click({
  $url = $urlBox.Text.Trim()
  $code = $codeBox.Text.Trim()
  if ($url -notmatch '^wss://[^\s]+$') {
    $status.Text = "地址必须以 wss:// 开头"
    return
  }
  if ($code -notmatch '^emilia1\.[A-Za-z0-9-]{3,80}\.[A-Za-z0-9_-]{40,80}$') {
    $status.Text = "配对码格式不正确，请重新从 Mac 复制"
    return
  }
  try {
    $backup = Set-RelayConfig $url $code
    $task = Get-ScheduledTask -TaskName "Emilia Core Service" -ErrorAction SilentlyContinue
    if ($null -ne $task) {
      Stop-ScheduledTask -TaskName "Emilia Core Service" -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
      Start-ScheduledTask -TaskName "Emilia Core Service" -ErrorAction Stop
    }
    Set-Clipboard -Value (New-ConnectionCode $url $code)
    [System.Windows.Forms.MessageBox]::Show(
      "Core 已重新启动，完整连接码已复制。`n`n在 Mac 桌宠中打开连接设置，粘贴一次即可。`n`n原配置备份：$(Split-Path -Leaf $backup)",
      "配置完成",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    $form.Close()
  } catch {
    $status.Text = "保存失败：$($_.Exception.Message)"
  }
})
$form.Controls.Add($saveButton)

$form.AcceptButton = $saveButton
[void]$form.ShowDialog()

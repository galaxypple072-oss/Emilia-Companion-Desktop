param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Silent
)

$ErrorActionPreference = "Stop"
$taskName = "Emilia Host Agent"
$installer = Join-Path $ProjectRoot "scripts\install-host-agent-task-windows.ps1"
$launcher = Join-Path $ProjectRoot "scripts\windows\start-host-agent.ps1"

try {
  if (-not (Test-Path -LiteralPath $launcher)) { throw "Host Agent was not found: $launcher" }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    if (-not (Test-Path -LiteralPath $installer)) { throw "Host Agent installer was not found: $installer" }
    & $installer | Out-Null
  }
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $status = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $launcher -Mode status | ConvertFrom-Json
  $health = $status.health
  $summary = @(
    "Emilia is running in the background",
    "Core: $(if ($health.coreBridge) { 'online' } else { 'starting' })",
    "QQ: $(if ($health.onebotHttp) { 'online' } else { 'starting' })",
    "Voice: $(if ($health.voiceService -and $health.voiceEngine) { 'online' } else { 'starting' })"
  ) -join "`n"
  if ($Silent) { Write-Output $summary }
  else {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($summary, "Emilia", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
  }
} catch {
  if ($Silent) { Write-Error "Startup failed: $($_.Exception.Message)" }
  else {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Startup failed: $($_.Exception.Message)", "Emilia", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  }
  exit 1
}

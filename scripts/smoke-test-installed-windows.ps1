param([string]$InstallerPath)

$ErrorActionPreference = "Stop"
if (-not $InstallerPath) {
  $InstallerPath = Get-ChildItem (Join-Path $PSScriptRoot "personal-companion\apps\desktop-pet\src-tauri\target\release\bundle\nsis") -Filter "*0.0.3*x64-setup.exe" |
    Select-Object -First 1 -ExpandProperty FullName
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$install = Join-Path $env:LOCALAPPDATA "Emilia Companion"
$runtime = Join-Path $install "core-runtime"

$process = Start-Process -FilePath $installer -ArgumentList "/S", "/P", "/UPDATE" -Wait -PassThru
Start-Sleep -Seconds 12

$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$coreProcess = if ($listener) { Get-CimInstance Win32_Process -Filter ("ProcessId = " + $listener.OwningProcess) } else { $null }
$modeLine = Get-Content (Join-Path $env:LOCALAPPDATA "PersonalCompanion\.env") -ErrorAction SilentlyContinue |
  Where-Object { $_ -like "AGENT_MODE=*" } | Select-Object -First 1
$coreTask = Get-ScheduledTask -TaskName "Emilia Core Service" -ErrorAction SilentlyContinue
$hostTask = Get-ScheduledTask -TaskName "Emilia Host Agent" -ErrorAction SilentlyContinue

[ordered]@{
  installerExitCode = $process.ExitCode
  appInstalled = Test-Path -LiteralPath (Join-Path $install "personal-companion-desktop.exe")
  bundledNode = Test-Path -LiteralPath (Join-Path $runtime "node\node.exe")
  bundledCore = Test-Path -LiteralPath (Join-Path $runtime "apps\product-core\src\cli.ts")
  bundledHarness = Test-Path -LiteralPath (Join-Path $runtime "node_modules\@deepseek-ai\dsh\package.json")
  bundledEmailMcp = Test-Path -LiteralPath (Join-Path $runtime "apps\email-mcp\src\server.ts")
  bundledFileMcp = Test-Path -LiteralPath (Join-Path $runtime "apps\file-mcp\src\server.ts")
  bundledDeviceMcp = Test-Path -LiteralPath (Join-Path $runtime "apps\device-mcp\src\server.ts")
  agentMode = $modeLine
  coreTaskInstalled = $null -ne $coreTask
  hostTaskInstalled = $null -ne $hostTask
  coreTaskUsesBundle = $null -ne $coreTask -and (($coreTask.Actions | Out-String) -like "*$runtime*")
  hostTaskUsesBundle = $null -ne $hostTask -and (($hostTask.Actions | Out-String) -like "*$runtime*")
  bridgeListening = $null -ne $listener
  deviceApiListening = $null -ne (Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
  coreProcessUsesBundle = $null -ne $coreProcess -and $coreProcess.CommandLine -like "*$runtime*"
  coreCommandLine = if ($coreProcess) { $coreProcess.CommandLine } else { $null }
} | ConvertTo-Json

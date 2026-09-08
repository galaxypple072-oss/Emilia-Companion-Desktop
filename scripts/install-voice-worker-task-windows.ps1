$ErrorActionPreference = "Stop"

$taskName = "Emilia Voice Worker"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot "scripts\windows\start-voice-worker.ps1"
$hiddenRunner = Join-Path $projectRoot "scripts\windows\run-hidden-powershell.vbs"
$userId = "$env:COMPUTERNAME\$env:USERNAME"

if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw "Voice Worker launcher not found: $launcherPath"
}
if (-not (Test-Path -LiteralPath $hiddenRunner)) { throw "Hidden runner not found: $hiddenRunner" }

$action = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "`"$hiddenRunner`" `"$launcherPath`""
$principal = New-ScheduledTaskPrincipal `
    -UserId $userId `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Principal $principal `
    -Settings $settings `
    -Description "Encrypted remote GPT-SoVITS capability for Emilia Core" `
    -Force | Out-Null

Get-ScheduledTask -TaskName $taskName |
    Select-Object TaskName, State, @{Name = "User"; Expression = { $_.Principal.UserId } }

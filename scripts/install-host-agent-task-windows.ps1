$ErrorActionPreference = "Stop"
$taskName = "Emilia Host Agent"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot "scripts\windows\start-host-agent.ps1"
$hiddenRunner = Join-Path $projectRoot "scripts\windows\run-hidden-powershell.vbs"
$userId = "$env:COMPUTERNAME\$env:USERNAME"
if (-not (Test-Path -LiteralPath $launcherPath)) { throw "Host Agent launcher not found: $launcherPath" }
if (-not (Test-Path -LiteralPath $hiddenRunner)) { throw "Hidden runner not found: $hiddenRunner" }
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$hiddenRunner`" `"$launcherPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Unified background supervisor for Emilia host capabilities" -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State, @{Name = "User"; Expression = { $_.Principal.UserId } }

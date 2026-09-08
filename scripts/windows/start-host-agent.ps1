param(
  [ValidateSet("run", "status", "repair")]
  [string]$Mode = "run",
  [ValidateRange(10, 300)]
  [int]$IntervalSeconds = 20
)

$ErrorActionPreference = "Stop"

# The Host Agent is the only logon task. It supervises the existing on-demand
# service tasks, writes one redacted state file, and never opens a terminal.
$projectRoot = "C:\Users\zhyje\personal-companion"
$voiceRoot = "D:\EmiliaVoice\GPT-SoVITS"
$logDir = Join-Path $env:LOCALAPPDATA "PersonalCompanion\logs"
$logPath = Join-Path $logDir "host-agent.log"
$statePath = Join-Path $env:LOCALAPPDATA "PersonalCompanion\host-state.json"
$napCatPath = "C:\Program Files\NapCatQQ Desktop\NapCatQQ-Desktop.exe"
$engineLauncher = Join-Path $projectRoot "scripts\windows\start-gpt-sovits-engine.cmd"
$taskNames = @("Emilia Core Service", "Emilia Voice Service", "Emilia Voice Worker", "Emilia QQ Worker")
$lastStart = @{}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function WriteAgentLog {
  param([string]$Level, [string]$Message)
  $safe = $Message -replace "[\r\n]", " "
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) [$Level] $safe" -Encoding utf8
}

function TestListeningPort {
  param([int]$Port)
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function CanStart {
  param([string]$Name, [int]$CooldownSeconds = 90)
  $previous = $lastStart[$Name]
  if ($null -ne $previous -and ((Get-Date) - $previous).TotalSeconds -lt $CooldownSeconds) { return $false }
  $lastStart[$Name] = Get-Date
  return $true
}

function EnsureTask {
  param([string]$Name)
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task) { return @{ ok = $false; detail = "missing" } }
  $state = [string]($task.State)
  if ($state -eq "Running") { return @{ ok = $true; detail = $state } }
  if (CanStart -Name ("task-" + $Name)) {
    try { Start-ScheduledTask -TaskName $Name; WriteAgentLog "INFO" ("requested task start " + $Name) }
    catch { WriteAgentLog "WARN" ("could not start task " + $Name) }
  }
  return @{ ok = $true; detail = $state }
}

function GetTaskState {
  param([string]$Name)
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task) { return @{ ok = $false; detail = "missing" } }
  return @{ ok = $true; detail = ([string]($task.State)) }
}

function EnsureNapCat {
  $process = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $napCatPath } | Select-Object -First 1
  if ($null -eq $process) {
    if (-not (CanStart -Name "napcat")) { return $false }
    if (Test-Path -LiteralPath $napCatPath) {
      try {
        # NapCat is a desktop application, but minimizing it prevents a logon
        # window from interrupting the user while keeping its tray behavior.
        Start-Process -FilePath $napCatPath -WindowStyle Minimized
        WriteAgentLog "INFO" "requested NapCat start"
      } catch { $null = $_ }
    } else { WriteAgentLog "WARN" "NapCat executable not found" }
  }
  return $null -ne $process
}

function EnsureVoiceEngine {
  if (TestListeningPort 9872) { return }
  if (-not (CanStart -Name "voice-engine" -CooldownSeconds 120)) { return }
  if (-not (Test-Path -LiteralPath $engineLauncher)) {
    WriteAgentLog "WARN" "GPT-SoVITS launcher not found: $engineLauncher"
    return
  }
  try {
    Start-Process -FilePath $env:ComSpec -ArgumentList "/d", "/c", "`"$engineLauncher`"" -WorkingDirectory $voiceRoot -WindowStyle Hidden
    WriteAgentLog "INFO" "requested GPT-SoVITS inference start"
  } catch { $null = $_ }
}

function Get-HostState {
  param([bool]$Repair)
  $napCatRunning = if ($Repair) { EnsureNapCat } else {
    $null -ne (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $napCatPath } | Select-Object -First 1)
  }
  $tasks = @{}
  foreach ($name in $taskNames) { $tasks[$name] = if ($Repair) { EnsureTask -Name $name } else { GetTaskState -Name $name } }
  if ($Repair) { EnsureVoiceEngine }
  [pscustomobject]@{
    schema = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    health = [ordered]@{
      napcatProcess = $napCatRunning
      onebotHttp = TestListeningPort 3000
      onebotWebSocket = TestListeningPort 3001
      coreBridge = TestListeningPort 8765
      coreControl = TestListeningPort 8766
      voiceEngine = TestListeningPort 9872
      voiceService = TestListeningPort 9873
    }
    tasks = $tasks
    logs = [ordered]@{ hostAgent = $logPath; core = (Join-Path $logDir "product-core.log"); qqWorker = (Join-Path $logDir "qq-worker.log"); voiceWorker = (Join-Path $logDir "voice-worker.log") }
  }
}

function Save-HostState($State) {
  $temporary = "$statePath.tmp"
  $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

if ($Mode -eq "status" -or $Mode -eq "repair") {
  $state = Get-HostState ($Mode -eq "repair")
  Save-HostState $state
  $state | ConvertTo-Json -Depth 6
  exit 0
}

$created = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\EmiliaHostAgent", [ref]$created)
if (-not $created) { exit 0 }
try {
  WriteAgentLog "INFO" "Host Agent started"
  while ($true) {
    try { Save-HostState (Get-HostState $true) }
    catch { $null = $_ }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  if ($created) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

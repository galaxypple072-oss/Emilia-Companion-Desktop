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
$moduleConfigPath = Join-Path $env:LOCALAPPDATA "PersonalCompanion\host-modules.json"
$napCatPath = "C:\Program Files\NapCatQQ Desktop\NapCatQQ-Desktop.exe"
$engineLauncher = Join-Path $projectRoot "scripts\windows\start-gpt-sovits-engine.cmd"
$coreTaskName = "Emilia Core Service"
$workerTaskNames = @("Emilia Voice Service", "Emilia Voice Worker", "Emilia QQ Worker")
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

function EnsurePortTask {
  param([string]$Name, [int]$Port)
  # The voice bridge launcher detaches its Node child, so Task Scheduler marks
  # its wrapper Ready even while the service is healthy. A task-state-only
  # check previously restarted it every cooldown interval.
  if (TestListeningPort $Port) { return @{ ok = $true; detail = "online:$Port" } }
  return EnsureTask -Name $Name
}

function GetTaskState {
  param([string]$Name)
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task) { return @{ ok = $false; detail = "missing" } }
  return @{ ok = $true; detail = ([string]($task.State)) }
}

function EnsureNapCat {
  $process = Get-Process -Name "NapCatQQ-Desktop" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $process) {
    $process = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $napCatPath } | Select-Object -First 1
  }
  if ($null -eq $process) {
    # A cold NapCat launch can take longer than one agent loop. Keep a longer
    # cooldown so it is never launched twice just because its process has not
    # registered yet.
    if (-not (CanStart -Name "napcat" -CooldownSeconds 300)) { return $false }
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

function TestCoreReady {
  return (TestListeningPort 8765) -and (TestListeningPort 8766)
}

function ModuleEnabled {
  param([string]$Name)
  # QQ and voice are optional resource providers. A Core-only host should not
  # start either one merely because old task files or a runtime folder exist.
  if (Test-Path -LiteralPath $moduleConfigPath) {
    try {
      $settings = Get-Content -LiteralPath $moduleConfigPath -Raw | ConvertFrom-Json
      if ($null -ne $settings.$Name) { return [bool]$settings.$Name }
    } catch { WriteAgentLog "WARN" "host module settings could not be read" }
  }
  return $false
}

function Get-HostState {
  param([bool]$Repair)
  $qqEnabled = ModuleEnabled "qqEnabled"
  $voiceEnabled = ModuleEnabled "voiceEnabled"
  $napCatRunning = if (-not $qqEnabled) { $false } elseif ($Repair) { EnsureNapCat } else {
    $null -ne (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $napCatPath } | Select-Object -First 1)
  }
  $tasks = @{}
  # Core is the only required process in an all-in-one host.  It must reach
  # both local endpoints before optional workers are asked to connect.  This
  # removes the logon race where four scheduled tasks all started at once.
  $tasks[$coreTaskName] = if ($Repair) { EnsureTask -Name $coreTaskName } else { GetTaskState -Name $coreTaskName }
  $coreReady = TestCoreReady
  foreach ($name in $workerTaskNames) {
    if (-not $voiceEnabled -and ($name -eq "Emilia Voice Service" -or $name -eq "Emilia Voice Worker")) {
      $tasks[$name] = @{ ok = $true; detail = "disabled" }
      continue
    }
    if (-not $qqEnabled -and $name -eq "Emilia QQ Worker") {
      $tasks[$name] = @{ ok = $true; detail = "disabled" }
      continue
    }
    if ($Repair -and $tasks[$coreTaskName].ok -and -not $coreReady) {
      $tasks[$name] = @{ ok = $true; detail = "waiting-for-core" }
    } else {
      $tasks[$name] = if ($Repair -and $name -eq "Emilia Voice Service") { EnsurePortTask -Name $name -Port 9873 } elseif ($Repair) { EnsureTask -Name $name } else { GetTaskState -Name $name }
    }
  }
  if ($Repair -and $voiceEnabled -and ($coreReady -or -not $tasks[$coreTaskName].ok)) { EnsureVoiceEngine }
  [pscustomobject]@{
    schema = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    health = [ordered]@{
      napcatProcess = $napCatRunning
      onebotHttp = TestListeningPort 3000
      onebotWebSocket = TestListeningPort 3001
      coreBridge = TestListeningPort 8765
      coreControl = TestListeningPort 8766
      qqEnabled = $qqEnabled
      voiceEnabled = $voiceEnabled
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

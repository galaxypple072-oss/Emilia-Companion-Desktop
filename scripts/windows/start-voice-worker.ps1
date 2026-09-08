$ErrorActionPreference = "Stop"

# A voice worker is a long-running capability process. Keep the mutex for its
# whole lifetime so a logon task and a repair action cannot create two workers.
$created = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\EmiliaVoiceWorker", [ref]$created)
if (-not $created) { exit 0 }

try {
  $projectRoot = "C:\Users\zhyje\personal-companion"
  $voiceRoot = "D:\EmiliaVoice\GPT-SoVITS"
  $nodePath = "C:\Program Files\nodejs\node.exe"
  $workerPath = Join-Path $projectRoot "apps\voice-service\src\relay-worker.ts"
  $voiceEnvPath = Join-Path $voiceRoot ".env.voice"
  $logDir = Join-Path $env:LOCALAPPDATA "PersonalCompanion\logs"
  $logPath = Join-Path $logDir "voice-worker.log"

  if (-not (Test-Path -LiteralPath $nodePath)) { throw "Node.js not found: $nodePath" }
  if (-not (Test-Path -LiteralPath $workerPath)) { throw "Voice Worker not found: $workerPath" }
  if (-not (Test-Path -LiteralPath $voiceEnvPath)) { throw "Voice configuration not found: $voiceEnvPath" }

  # The worker reads Relay pairing data from the project .env and only reads
  # the local voice token from this machine's GPT-SoVITS directory.
  $env:EMILIA_VOICE_WORKER_ENABLED = "true"
  $env:EMILIA_VOICE_ENV_PATH = $voiceEnvPath
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Set-Location -LiteralPath $projectRoot
  $errorLogPath = Join-Path $logDir "voice-worker.err.log"
  $process = Start-Process -FilePath $nodePath -ArgumentList "--experimental-strip-types", $workerPath -WorkingDirectory $projectRoot -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath -WindowStyle Hidden -PassThru
  $process.WaitForExit()
  exit $process.ExitCode
} finally {
  if ($created) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

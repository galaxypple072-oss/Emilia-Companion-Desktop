$ErrorActionPreference = "Stop"
$created = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\EmiliaQqWorker", [ref]$created)
if (-not $created) { exit 0 }
try {
  $projectRoot = "C:\Users\zhyje\personal-companion"
  $nodePath = "C:\Program Files\nodejs\node.exe"
  $workerPath = Join-Path $projectRoot "apps\qq-gateway\src\relay-worker.ts"
  $logDir = Join-Path $env:LOCALAPPDATA "PersonalCompanion\logs"
  $logPath = Join-Path $logDir "qq-worker.log"
  if (-not (Test-Path -LiteralPath $nodePath)) { throw "Node.js not found: $nodePath" }
  if (-not (Test-Path -LiteralPath $workerPath)) { throw "QQ Worker not found: $workerPath" }
  $env:EMILIA_QQ_WORKER_ENABLED = "true"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Set-Location -LiteralPath $projectRoot
  $errorLogPath = Join-Path $logDir "qq-worker.err.log"
  $process = Start-Process -FilePath $nodePath -ArgumentList "--experimental-strip-types", $workerPath -WorkingDirectory $projectRoot -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath -WindowStyle Hidden -PassThru
  $process.WaitForExit()
  exit $process.ExitCode
} finally {
  if ($created) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

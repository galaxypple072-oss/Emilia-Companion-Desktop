$ErrorActionPreference = "Stop"

# Keep the mutex for the lifetime of Product Core. This prevents an automatic
# logon task and a manual start request from racing to bind the same ports.
$created = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\EmiliaCoreService", [ref]$created)
if (-not $created) { exit 0 }

try {
  $listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) { exit 0 }

  $projectRoot = "C:\Users\zhyje\personal-companion"
  $nodePath = "C:\Program Files\nodejs\node.exe"
  $cliPath = Join-Path $projectRoot "apps\product-core\src\cli.ts"
  $logDir = Join-Path $env:LOCALAPPDATA "PersonalCompanion\logs"
  $logPath = Join-Path $logDir "core-service.log"
  if (-not (Test-Path -LiteralPath $nodePath)) { throw "Node.js not found: $nodePath" }
  if (-not (Test-Path -LiteralPath $cliPath)) { throw "Product Core CLI not found: $cliPath" }

  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Set-Location -LiteralPath $projectRoot
  $errorLogPath = Join-Path $logDir "core-service.err.log"
  # Task Scheduler only notices a failed task after it has returned.  Keeping
  # the supervisor alive here avoids the previous one-minute restart gap that
  # made a cold boot appear to require a manual restart.
  $attempt = 0
  while ($true) {
    $listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($listener) { exit 0 }

    $process = Start-Process -FilePath $nodePath -ArgumentList "--experimental-strip-types", $cliPath, "run" -WorkingDirectory $projectRoot -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath -WindowStyle Hidden -PassThru
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $attempt = [Math]::Min($attempt + 1, 6)
    $delaySeconds = [Math]::Min(5 * [Math]::Pow(2, $attempt - 1), 60)
    Add-Content -LiteralPath $errorLogPath -Value "$(Get-Date -Format o) [supervisor] Core exited with code $exitCode; retrying in $delaySeconds seconds" -Encoding utf8
    Start-Sleep -Seconds $delaySeconds
  }
} finally {
  if ($created) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

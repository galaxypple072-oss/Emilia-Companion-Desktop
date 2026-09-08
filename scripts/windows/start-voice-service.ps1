$ErrorActionPreference = "Stop"
$created = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\EmiliaVoiceService", [ref]$created)
if (-not $created) { exit 0 }
try {
  $port = Get-NetTCPConnection -LocalPort 9873 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($port) { exit 0 }
  $launcher = "D:\EmiliaVoice\GPT-SoVITS\companion-voice-service\start-voice-service-windows.cmd"
  if (-not (Test-Path -LiteralPath $launcher)) { throw "Voice Service launcher was not found: $launcher" }
  $process = Start-Process -FilePath $env:ComSpec -ArgumentList "/d", "/c", "`"$launcher`"" -WorkingDirectory (Split-Path -Parent $launcher) -WindowStyle Hidden -PassThru
  $process.WaitForExit()
  exit $process.ExitCode
} finally {
  if ($created) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

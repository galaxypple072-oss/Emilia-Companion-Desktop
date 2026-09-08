$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path $envPath)) { throw "Missing project .env: $envPath" }

$settings = [ordered]@{
  DISCOVERY_ENABLED = "true"
  DISCOVERY_POLL_SECONDS = "300"
  DISCOVERY_MIN_INTERVAL_HOURS = "12"
  DISCOVERY_DAILY_SHARE_LIMIT = "1"
  DISCOVERY_TIME_ZONE = "Asia/Shanghai"
  WEATHER_ENABLED = "true"
  WEATHER_POLL_SECONDS = "600"
  WEATHER_MIN_INTERVAL_HOURS = "3"
  WEATHER_DAILY_ALERT_LIMIT = "2"
  WEATHER_TIME_ZONE = "Asia/Shanghai"
}
$legacyKeys = @("PROACTIVE_ENABLED", "PROACTIVE_POLL_SECONDS", "PROACTIVE_DAILY_LIMIT", "PROACTIVE_MIN_INTERVAL_MINUTES", "PROACTIVE_IDLE_AFTER_HOURS", "PROACTIVE_TIME_ZONE")
$allKeys = @($settings.Keys) + $legacyKeys
$pattern = '^(' + (($allKeys | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')='
$preserved = Get-Content $envPath | Where-Object { $_ -notmatch $pattern }
$configured = $settings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
$temporaryPath = "$envPath.tmp"
[IO.File]::WriteAllLines($temporaryPath, @($preserved) + @($configured), (New-Object Text.UTF8Encoding($false)))
Move-Item $temporaryPath $envPath -Force
& icacls.exe $envPath /inheritance:r /grant:r "$env:COMPUTERNAME\$env:USERNAME`:F" /grant:r "*S-1-5-18:F" | Out-Null
Write-Output "Event-backed web discovery configured; idle-chat triggers removed."

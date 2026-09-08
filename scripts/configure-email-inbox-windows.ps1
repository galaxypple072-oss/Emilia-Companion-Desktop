$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path $envPath)) { throw "Missing project .env: $envPath" }

$settings = [ordered]@{
  EMAIL_INBOX_ENABLED = "true"
  IMAP_HOST = "imap.163.com"
  IMAP_PORT = "993"
  IMAP_SECURE = "true"
  IMAP_MAILBOX = "INBOX"
  EMAIL_INBOX_POLL_SECONDS = "120"
  EMAIL_INBOX_BATCH_SIZE = "20"
}
$pattern = '^(' + (($settings.Keys | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')='
$preserved = Get-Content $envPath | Where-Object { $_ -notmatch $pattern }
$configured = $settings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
$temporaryPath = "$envPath.tmp"
[IO.File]::WriteAllLines($temporaryPath, @($preserved) + @($configured), (New-Object Text.UTF8Encoding($false)))
Move-Item $temporaryPath $envPath -Force
& icacls.exe $envPath /inheritance:r /grant:r "$env:COMPUTERNAME\$env:USERNAME`:F" /grant:r "*S-1-5-18:F" | Out-Null
Write-Output "Read-only 163 IMAP inbox monitoring configured. Existing SMTP credentials are reused."

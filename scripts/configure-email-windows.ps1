$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path $envPath)) { throw "Missing $envPath" }

$hostName = Read-Host "SMTP host (for example smtp.qq.com)"
$port = Read-Host "SMTP port [465]"
if ([string]::IsNullOrWhiteSpace($port)) { $port = "465" }
$smtpUser = Read-Host "Sender email address"
$bossEmail = Read-Host "Boss email address"
$secret = Read-Host "SMTP authorization code/password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $smtpPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ([string]::IsNullOrWhiteSpace($hostName) -or [string]::IsNullOrWhiteSpace($smtpUser) -or
    [string]::IsNullOrWhiteSpace($bossEmail) -or [string]::IsNullOrWhiteSpace($smtpPassword)) {
  throw "All email settings are required"
}

$managed = @{
  EMAIL_ENABLED = "true"
  SMTP_HOST = $hostName
  SMTP_PORT = $port
  SMTP_SECURE = "true"
  SMTP_USER = $smtpUser
  SMTP_PASSWORD = $smtpPassword
  EMAIL_FROM = $smtpUser
  BOSS_EMAIL = $bossEmail
}
$existing = Get-Content $envPath
$kept = $existing | Where-Object {
  $line = $_
  -not ($managed.Keys | Where-Object { $line -match "^$([regex]::Escape($_))=" })
}
$newLines = @($kept) + @($managed.Keys | Sort-Object | ForEach-Object { "$_=$($managed[$_])" })
[IO.File]::WriteAllLines($envPath, $newLines, [Text.UTF8Encoding]::new($false))
Write-Host "Email settings saved. Restart PersonalCompanionCore to apply them."

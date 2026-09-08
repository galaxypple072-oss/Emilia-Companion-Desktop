$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path $envPath)) { throw "Missing project .env: $envPath" }

$roots = "D:\work;D:\study;D:\learning;D:\pictures;D:\travel"
$preserved = Get-Content $envPath | Where-Object { $_ -notmatch '^COMPANION_FILE_ROOTS=' }
$next = @($preserved) + @("COMPANION_FILE_ROOTS=$roots")
$temporaryPath = "$envPath.tmp"
[IO.File]::WriteAllLines($temporaryPath, $next, (New-Object Text.UTF8Encoding($false)))
Move-Item $temporaryPath $envPath -Force
& icacls.exe $envPath /inheritance:r /grant:r "$env:COMPUTERNAME\$env:USERNAME`:F" /grant:r "*S-1-5-18:F" | Out-Null
Write-Output "Scoped file roots configured."

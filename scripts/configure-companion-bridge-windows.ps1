param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765,
    [string]$ClientAddress = "LocalSubnet",
    [switch]$LoopbackOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path $envPath)) { throw "Missing project .env: $envPath" }

$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$preserved = Get-Content $envPath | Where-Object { $_ -notmatch '^COMPANION_BRIDGE_' }
$bridgeHost = if ($LoopbackOnly) { "127.0.0.1" } else { "0.0.0.0" }
$next = @($preserved) + @(
    "COMPANION_BRIDGE_ENABLED=true",
    "COMPANION_BRIDGE_HOST=$bridgeHost",
    "COMPANION_BRIDGE_PORT=$Port",
    "COMPANION_BRIDGE_TOKEN=$token",
    "COMPANION_BRIDGE_NAME=Emilia Core"
)
$temporaryPath = "$envPath.tmp"
[IO.File]::WriteAllLines($temporaryPath, $next, (New-Object Text.UTF8Encoding($false)))
Move-Item $temporaryPath $envPath -Force
& icacls.exe $envPath /inheritance:r /grant:r "$env:COMPUTERNAME\$env:USERNAME`:F" /grant:r "*S-1-5-18:F" | Out-Null

$ruleName = "Emilia Companion Bridge TCP $Port"
if (-not $LoopbackOnly) {
    $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $existingRule) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress $ClientAddress -Profile Private | Out-Null
    }
}

Set-Clipboard -Value $token
$addresses = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown'
} | Select-Object -ExpandProperty IPAddress

if ($LoopbackOnly) {
    Write-Output "Companion Bridge enabled on Windows loopback TCP $Port; no firewall rule was created."
} else {
    Write-Output "Companion Bridge enabled on TCP $Port for $ClientAddress."
}
Write-Output "Windows IPv4 candidates: $($addresses -join ', ')"
Write-Output "The new bridge token is on the Windows clipboard; it was not printed."
Write-Output "Restart the Product Core, then enter ws://WINDOWS_IP:$Port in the Mac client."

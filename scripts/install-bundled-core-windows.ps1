param(
  [Parameter(Mandatory = $true)]
  [string]$RuntimeRoot
)

$ErrorActionPreference = "Stop"
$runtime = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$node = Join-Path $runtime "node\node.exe"
$cli = Join-Path $runtime "apps\product-core\src\cli.ts"
if (-not (Test-Path -LiteralPath $node)) { throw "Bundled Node runtime not found: $node" }
if (-not (Test-Path -LiteralPath $cli)) { throw "Bundled Product Core not found: $cli" }

foreach ($taskName in @("Emilia Host Agent", "Emilia Core Service")) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq "powershell.exe" -and (
    $_.CommandLine -like "*start-host-agent.ps1*" -or
    $_.CommandLine -like "*start-core-service.ps1*"
  )
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq "node.exe" -and $_.CommandLine -like "*product-core*cli.ts*run*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$dataDir = Join-Path $env:LOCALAPPDATA "PersonalCompanion"
$envPath = Join-Path $dataDir ".env"
$legacyEnvPath = Join-Path $env:USERPROFILE "personal-companion\.env"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

if (-not (Test-Path -LiteralPath $envPath) -and (Test-Path -LiteralPath $legacyEnvPath)) {
  Copy-Item -LiteralPath $legacyEnvPath -Destination $envPath
}

if (-not (Test-Path -LiteralPath $envPath)) {
  function New-UrlToken {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  }
  $bridgeToken = New-UrlToken
  $oneBotToken = New-UrlToken
  $contents = @"
ONEBOT_HTTP_URL=http://127.0.0.1:3000
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_ACCESS_TOKEN=$oneBotToken
ONEBOT_ALLOWED_QQ=123456789
ONEBOT_REQUEST_TIMEOUT_MS=10000
CORE_POLL_INTERVAL_MS=1000
CORE_RECONNECT_DELAY_MS=5000
COMPANION_BRIDGE_ENABLED=true
COMPANION_BRIDGE_HOST=0.0.0.0
COMPANION_BRIDGE_PORT=8765
COMPANION_BRIDGE_TOKEN=$bridgeToken
COMPANION_BRIDGE_NAME=Emilia Core
DEVICE_CONTROL_ENABLED=true
DEVICE_CONTROL_API_PORT=8766
COMPANION_RELAY_ENABLED=false
AGENT_MODE=harness
AGENT_BASE_URL=https://api.deepseek.com
AGENT_API_KEY=
AGENT_MODEL=deepseek-v4-flash
AGENT_THINKING=disabled
AGENT_MAX_TOKENS=800
AGENT_TEMPERATURE=0.8
AGENT_TIMEOUT_MS=60000
AGENT_CONTEXT_MESSAGES=20
ROLEPLAY_ENABLED=false
ROLEPLAY_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ROLEPLAY_API_KEY=
ROLEPLAY_MODEL=qwen-flash-character-2026-02-26
DISCOVERY_ENABLED=false
WEATHER_ENABLED=false
EMAIL_INBOX_ENABLED=false
"@
  [IO.File]::WriteAllText($envPath, $contents, (New-Object Text.UTF8Encoding($false)))
}

# The bundled release includes DeepSeek Harness and its MCP servers. Normalize
# older direct-mode configurations so the installed app exposes the same tools.
$envContents = [IO.File]::ReadAllText($envPath)
if ($envContents -match '(?m)^AGENT_MODE=') {
  $envContents = [regex]::Replace($envContents, '(?m)^AGENT_MODE=.*$', 'AGENT_MODE=harness')
} else {
  $envContents += "`r`nAGENT_MODE=harness`r`n"
}
[IO.File]::WriteAllText($envPath, $envContents, (New-Object Text.UTF8Encoding($false)))

& (Join-Path $runtime "scripts\install-core-task-windows.ps1") | Out-Null
& (Join-Path $runtime "scripts\install-host-agent-task-windows.ps1") | Out-Null
Start-ScheduledTask -TaskName "Emilia Host Agent" -ErrorAction SilentlyContinue

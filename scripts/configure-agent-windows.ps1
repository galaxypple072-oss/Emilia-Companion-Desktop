param(
    [switch]$FromStdin
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path $envPath)) {
    throw "Missing project .env: $envPath"
}

if ($FromStdin) {
    $baseUrl = "https://api.deepseek.com"
    $model = "deepseek-v4-flash"
    $apiKey = [Console]::In.ReadToEnd().Trim()
} else {
    $baseUrl = Read-Host "Agent base URL [https://api.deepseek.com]"
    if (-not $baseUrl) { $baseUrl = "https://api.deepseek.com" }
    $model = Read-Host "Agent model [deepseek-v4-flash]"
    if (-not $model) { $model = "deepseek-v4-flash" }
    Write-Host "Copy the raw Agent API key to the Windows clipboard now."
    Read-Host "Press Enter after copying it (the key will not be displayed)"
    $apiKey = (Get-Clipboard -Raw).Trim()
}

try {
    if (-not $apiKey) { throw "API key must not be empty" }
    if ($apiKey -notmatch '^[\x21-\x7E]+$') {
        throw "API key contains spaces or non-ASCII characters; copy only the raw key"
    }

    $preserved = Get-Content $envPath | Where-Object { $_ -notmatch '^AGENT_' -and $_ -notmatch '^VISION_' -and $_ -notmatch '^MEMORY_' }
    $next = @($preserved) + @(
        "AGENT_MODE=harness",
        "AGENT_BASE_URL=$baseUrl",
        "AGENT_API_KEY=$apiKey",
        "AGENT_MODEL=$model",
        "AGENT_THINKING=disabled",
        "AGENT_MAX_TOKENS=800",
        "AGENT_TEMPERATURE=0.8",
        "AGENT_TIMEOUT_MS=60000",
        "AGENT_CONTEXT_MESSAGES=20",
        "VISION_ENABLED=true",
        "VISION_MODEL=deepseek-v4-flash-vision-exp",
        "VISION_MAX_TOKENS=1200",
        "VISION_TIMEOUT_MS=90000",
        "VISION_MAX_IMAGE_BYTES=8388608",
        "MEMORY_ENABLED=true",
        "MEMORY_MODEL=$model"
    )
    $temporaryPath = "$envPath.tmp"
    [IO.File]::WriteAllLines($temporaryPath, $next, (New-Object Text.UTF8Encoding($false)))
    Move-Item $temporaryPath $envPath -Force
    & icacls.exe $envPath /inheritance:r /grant:r "$env:COMPUTERNAME\$env:USERNAME`:F" /grant:r "*S-1-5-18:F" | Out-Null
    Write-Output "Agent configuration saved. The API key was not printed."
} finally {
    if (-not $FromStdin) { Set-Clipboard -Value "" }
    Remove-Variable apiKey -ErrorAction SilentlyContinue
}

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
    $apiKey = [Console]::In.ReadToEnd().Trim()
} else {
    Write-Host "Copy the raw Alibaba Cloud Model Studio API key to the Windows clipboard now."
    Read-Host "Press Enter after copying it (the key will not be displayed)"
    $clipboardText = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    if (-not $clipboardText) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            $clipboardText = [System.Windows.Forms.Clipboard]::GetText()
        } catch {
            $clipboardText = $null
        }
    }
    if ($clipboardText) {
        $apiKey = $clipboardText.Trim()
    } else {
        Write-Host "Clipboard could not be read. Paste the key at the hidden prompt, then press Enter."
        $secureKey = Read-Host "API key" -AsSecureString
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
        }
    }
}

try {
    if (-not $apiKey) { throw "API key must not be empty" }
    if ($apiKey -notmatch '^[\x21-\x7E]+$') {
        throw "API key contains spaces or non-ASCII characters; copy only the raw key"
    }

    $preserved = Get-Content $envPath | Where-Object { $_ -notmatch '^ROLEPLAY_' }
    $next = @($preserved) + @(
        "ROLEPLAY_ENABLED=true",
        "ROLEPLAY_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1",
        "ROLEPLAY_API_KEY=$apiKey",
        "ROLEPLAY_MODEL=qwen-flash-character-2026-02-26",
        "ROLEPLAY_MAX_TOKENS=500",
        "ROLEPLAY_TEMPERATURE=0.85",
        "ROLEPLAY_TIMEOUT_MS=60000",
        "ROLEPLAY_CONTEXT_MESSAGES=20"
    )
    $temporaryPath = "$envPath.tmp"
    [IO.File]::WriteAllLines($temporaryPath, $next, (New-Object Text.UTF8Encoding($false)))
    Move-Item $temporaryPath $envPath -Force
    & icacls.exe $envPath /inheritance:r /grant:r "$env:COMPUTERNAME\$env:USERNAME`:F" /grant:r "*S-1-5-18:F" | Out-Null
    Write-Output "Roleplay configuration saved. The API key was not printed."
} finally {
    if (-not $FromStdin) { Set-Clipboard -Value "" }
    Remove-Variable apiKey -ErrorAction SilentlyContinue
    Remove-Variable clipboardText -ErrorAction SilentlyContinue
    Remove-Variable secureKey -ErrorAction SilentlyContinue
}

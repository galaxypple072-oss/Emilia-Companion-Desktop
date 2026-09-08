param(
  [string]$ProjectRoot = "D:\EmiliaVoice\GPT-SoVITS",
  [string]$VoiceRoot = "D:\EmiliaVoice\training\data-v1\wavs",
  [int]$Port = 9873,
  [string]$NaturalReferenceSource = "",
  [switch]$AllowLan
)

$ErrorActionPreference = "Stop"
$envPath = Join-Path $ProjectRoot ".env.voice"
if (-not (Test-Path -LiteralPath $ProjectRoot)) { throw "Project root not found: $ProjectRoot" }

$token = -join ((1..48) | ForEach-Object { "abcdef0123456789"[(Get-Random -Maximum 16)] })
$preserved = if (Test-Path -LiteralPath $envPath) { Get-Content -LiteralPath $envPath | Where-Object { $_ -notmatch '^VOICE_' } } else { @() }
$voiceLines = @(
  "VOICE_SERVICE_HOST=$(if ($AllowLan) { '0.0.0.0' } else { '127.0.0.1' })",
  "VOICE_SERVICE_PORT=$Port",
  "VOICE_SERVICE_TOKEN=$token",
  "VOICE_GRADIO_URL=http://127.0.0.1:9872",
  "VOICE_REFERENCE_ROOT=$VoiceRoot",
  "VOICE_OUTPUT_DIR=D:\EmiliaVoice\voice-output",
  "VOICE_GPT_WEIGHT=GPT_weights_v2Pro/EMILIA-LIM-R3-e50.ckpt",
  "VOICE_SOVITS_WEIGHT=SoVITS_weights_v2Pro/EMILIA_LIM_R2_e8_s1624.pth"
)
if ($NaturalReferenceSource) { $voiceLines += "VOICE_NATURAL_REFERENCE_SOURCE=$NaturalReferenceSource" }
$allLines = [System.Collections.Generic.List[string]]::new()
foreach ($line in $preserved) { [void]$allLines.Add([string]$line) }
[void]$allLines.Add("")
foreach ($line in $voiceLines) { [void]$allLines.Add([string]$line) }
[System.IO.File]::WriteAllLines($envPath, $allLines, (New-Object System.Text.UTF8Encoding($false)))

if ($AllowLan) {
  New-NetFirewallRule -DisplayName "Emilia Voice Service (LocalSubnet)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -ErrorAction SilentlyContinue | Out-Null
  Write-Host "Voice service is available to LocalSubnet only."
} else {
  Write-Host "Voice service listens on loopback only."
}
Write-Host "Saved .env.voice. The access token remains local and is not printed."

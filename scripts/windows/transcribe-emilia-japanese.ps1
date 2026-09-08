param(
  [string]$Root = 'D:\EmiliaVoice\GPT-SoVITS',
  [string]$DataRoot = 'D:\EmiliaVoice\training\data-v1',
  [ValidateSet('large-v3', 'large-v3-turbo')]
  [string]$Model = 'large-v3'
)

$ErrorActionPreference = 'Stop'
$env:PATH = (Join-Path $Root '.tools\ffmpeg') + ';' + $env:PATH
$env:PYTHONUTF8 = '1'
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:ALL_PROXY = ''
$env:http_proxy = ''
$env:https_proxy = ''
$env:all_proxy = ''

$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Input = Join-Path $DataRoot 'wavs\Home'
$Output = Join-Path $DataRoot 'asr'

if (-not (Test-Path $Python)) { throw "GPT-SoVITS virtual environment not found: $Python" }
if (-not (Test-Path $Input)) { throw "Filtered Emilia WAV folder not found: $Input" }

New-Item -ItemType Directory -Force -Path $Output | Out-Null
Set-Location $Root
& $Python 'tools\asr\fasterwhisper_asr.py' -i $Input -o $Output -s $Model -l ja -p float16
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output ("ASR_READY=" + (Join-Path $Output 'Home.list'))

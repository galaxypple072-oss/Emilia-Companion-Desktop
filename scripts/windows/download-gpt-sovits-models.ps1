param(
  [string]$Root = 'D:\EmiliaVoice\GPT-SoVITS'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:ALL_PROXY = ''

$Python = Join-Path $Root '.venv\Scripts\python.exe'
$ModelBase = 'https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main'

function Get-ModelFile([string]$RemotePath, [string]$LocalPath) {
  $target = Join-Path $Root $LocalPath
  $partial = "$target.part"
  if (Test-Path $target) {
    Write-Output "exists $LocalPath"
    return $target
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  if ((Test-Path $partial) -and ((Get-Item $partial).Length -eq 0)) {
    Remove-Item $partial -Force
  }

  Write-Output "download $RemotePath"
  $downloaded = $false
  for ($attempt = 1; $attempt -le 12; $attempt++) {
    # Hugging Face's CDN occasionally drops a long request on campus networks.
    # curl's resume support means each retry continues the same .part file.
    & curl.exe -fL --noproxy '*' --retry 3 --retry-delay 3 --continue-at - --output $partial "$ModelBase/$RemotePath"
    if ($LASTEXITCODE -eq 0) {
      $downloaded = $true
      break
    }
    Write-Output "retry $attempt for $RemotePath (curl exit $LASTEXITCODE)"
    Start-Sleep -Seconds 5
  }
  if (-not $downloaded) {
    throw "curl failed for $RemotePath after 12 resumable attempts"
  }
  Move-Item $partial $target
  return $target
}

Set-Location $Root

# Keep this intentionally small: the upstream all-in-one archive is 4.5 GB and
# contains every historical model family. This WebUI trains with the v2Pro
# path, plus the HuBERT feature extractor and Chinese text BERT used when
# Emilia is asked to speak Chinese (~2.1 GB total).
$RequiredFiles = @(
  @{ Remote = 'pretrained_models/s1v3.ckpt'; Local = 'GPT_SoVITS/pretrained_models/s1v3.ckpt' },
  @{ Remote = 'pretrained_models/v2Pro/s2Gv2Pro.pth'; Local = 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth' },
  @{ Remote = 'pretrained_models/v2Pro/s2Dv2Pro.pth'; Local = 'GPT_SoVITS/pretrained_models/v2Pro/s2Dv2Pro.pth' },
  @{ Remote = 'pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt'; Local = 'GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt' },
  @{ Remote = 'pretrained_models/chinese-hubert-base/config.json'; Local = 'GPT_SoVITS/pretrained_models/chinese-hubert-base/config.json' },
  @{ Remote = 'pretrained_models/chinese-hubert-base/preprocessor_config.json'; Local = 'GPT_SoVITS/pretrained_models/chinese-hubert-base/preprocessor_config.json' },
  @{ Remote = 'pretrained_models/chinese-hubert-base/pytorch_model.bin'; Local = 'GPT_SoVITS/pretrained_models/chinese-hubert-base/pytorch_model.bin' },
  @{ Remote = 'pretrained_models/chinese-roberta-wwm-ext-large/config.json'; Local = 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/config.json' },
  @{ Remote = 'pretrained_models/chinese-roberta-wwm-ext-large/tokenizer.json'; Local = 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/tokenizer.json' },
  @{ Remote = 'pretrained_models/chinese-roberta-wwm-ext-large/pytorch_model.bin'; Local = 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/pytorch_model.bin' }
)

foreach ($file in $RequiredFiles) {
  Get-ModelFile -RemotePath $file.Remote -LocalPath $file.Local | Out-Null
}

@{
  completedAt = (Get-Date).ToString('o')
  root = $Root
  source = $ModelBase
} | ConvertTo-Json | Set-Content -Path (Join-Path $Root 'models-ready.json') -Encoding utf8
Write-Output 'MODELS_READY'

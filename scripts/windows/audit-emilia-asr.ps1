param(
  [string]$DataRoot = 'D:\EmiliaVoice\training\data-v1'
)

$ErrorActionPreference = 'Stop'
$ListPath = Join-Path $DataRoot 'asr\Home.list'
$ReviewPath = Join-Path $DataRoot 'asr\Home.review.csv'
$TrainingPath = Join-Path $DataRoot 'asr\Home.training.list'

if (-not (Test-Path $ListPath)) {
  throw "ASR output is not ready: $ListPath"
}

$rows = foreach ($line in Get-Content -Path $ListPath -Encoding utf8) {
  $parts = $line -split '\|', 4
  if ($parts.Count -ne 4) {
    [pscustomobject]@{
      audio_path = $line; speaker = ''; language = ''; transcript = ''
      status = 'invalid_format'; reviewer_note = ''
    }
    continue
  }

  $text = $parts[3].Trim()
  $hasJapanese = $text -match '[\p{IsHiragana}\p{IsKatakana}\p{IsCJKUnifiedIdeographs}]'
  $status = if ([string]::IsNullOrWhiteSpace($text)) { 'empty' } elseif (-not $hasJapanese) { 'needs_review' } else { 'auto_ok' }
  [pscustomobject]@{
    audio_path = $parts[0]; speaker = $parts[1]; language = $parts[2]; transcript = $text
    status = $status; reviewer_note = ''
  }
}

$rows | Export-Csv -Path $ReviewPath -NoTypeInformation -Encoding utf8
$approved = $rows | Where-Object { $_.status -eq 'auto_ok' }
$trainingLines = @($approved | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.audio_path, $_.speaker, $_.language, $_.transcript })
# Windows PowerShell's -Encoding utf8 writes a BOM. GPT-SoVITS passes the
# first path directly to ffmpeg, where that invisible prefix makes the first
# audio file look invalid. Write UTF-8 without BOM instead.
[System.IO.File]::WriteAllLines($TrainingPath, $trainingLines, (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("ASR_AUDIT_READY=$ReviewPath")
Write-Output ("AUTO_APPROVED=$($approved.Count)")
Write-Output ("NEEDS_REVIEW=$(@($rows | Where-Object { $_.status -ne 'auto_ok' }).Count)")

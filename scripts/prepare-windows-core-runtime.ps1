param([switch]$Force)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot ".build\r3"
$dependencyStage = Join-Path $env:TEMP ("emilia-core-deps-" + [guid]::NewGuid().ToString("N"))
$completeMarker = Join-Path $runtimeRoot ".complete"

if (-not $Force -and (Test-Path -LiteralPath $completeMarker)) {
  Write-Output "Using prepared Emilia Core runtime: $runtimeRoot"
  exit 0
}

if (Test-Path -LiteralPath $runtimeRoot) {
  Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

try {
  Push-Location $projectRoot
  try {
    & corepack pnpm --config.node-linker=hoisted --filter personal-companion deploy $dependencyStage --legacy
    if ($LASTEXITCODE -ne 0) { throw "pnpm dependency staging failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot "node") | Out-Null
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $runtimeRoot "node\node.exe")
  Copy-Item -LiteralPath (Join-Path $dependencyStage "node_modules") -Destination (Join-Path $runtimeRoot "node_modules") -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination $runtimeRoot

  foreach ($app in @("product-core", "qq-gateway", "email-mcp", "file-mcp", "device-mcp")) {
    $destination = Join-Path $runtimeRoot ("apps\" + $app)
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot ("apps\" + $app + "\src")) -Destination $destination -Recurse
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot "packages\companion-relay-protocol") | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot "packages\companion-relay-protocol\src") -Destination (Join-Path $runtimeRoot "packages\companion-relay-protocol") -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot "packages\companion-relay-protocol\package.json") -Destination (Join-Path $runtimeRoot "packages\companion-relay-protocol")
  New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot "infra\dsh") | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot "infra\dsh\email-mcp.patch.yml") -Destination (Join-Path $runtimeRoot "infra\dsh")
  New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot "scripts\windows") | Out-Null
  foreach ($script in @("install-bundled-core-windows.ps1", "install-core-task-windows.ps1", "install-host-agent-task-windows.ps1")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot ("scripts\" + $script)) -Destination (Join-Path $runtimeRoot "scripts")
  }
  foreach ($script in @("start-core-service.ps1", "start-host-agent.ps1", "run-hidden-powershell.vbs")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot ("scripts\windows\" + $script)) -Destination (Join-Path $runtimeRoot "scripts\windows")
  }
  [IO.File]::WriteAllText($completeMarker, "Emilia Core runtime 0.0.3`n", (New-Object Text.UTF8Encoding($false)))
} finally {
  if (Test-Path -LiteralPath $dependencyStage) {
    try { Remove-Item -LiteralPath $dependencyStage -Recurse -Force -ErrorAction Stop } catch { $null = $_ }
  }
}

# Build the Windows installers.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -Dir   # unpacked only
#
# electron-builder shells out to `pnpm list` to collect production dependencies.
# This project has none, but if pnpm is not on PATH the collector fails with
# "No JSON content found in output". The script builds a tiny shim in %TEMP%
# that points at the pnpm used to install the app (override with $env:PNPM_MJS).
# It also points electron-builder at the already-downloaded Electron runtime so
# a build never re-downloads 250 MB.

param(
  [switch]$Dir
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path $node)) { throw 'node.exe not found; install Node.js 20+ or set it on PATH' }

$pnpmMjs = $env:PNPM_MJS
if (-not $pnpmMjs) {
  $candidate = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
  if (Test-Path $candidate) { $pnpmMjs = $candidate }
}
if ($pnpmMjs -and (Test-Path $pnpmMjs)) {
  $shimDir = Join-Path $env:TEMP 'opencode-pool-build-shim'
  New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
  $shim = "@echo off`r`n`"$node`" `"$pnpmMjs`" %*`r`n"
  Set-Content -Path (Join-Path $shimDir 'pnpm.cmd') -Value $shim -Encoding ASCII
  $env:PATH = "$shimDir;$env:PATH"
}

$env:npm_config_verify_deps_before_run = 'false'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = if ($env:ELECTRON_BUILDER_BINARIES_MIRROR) { $env:ELECTRON_BUILDER_BINARIES_MIRROR } else { 'https://npmmirror.com/mirrors/electron-builder-binaries/' }

$electronDist = Join-Path $root 'node_modules\electron\dist'
$argsList = @(
  (Join-Path $root 'node_modules\electron-builder\cli.js'),
  '--win',
  "--config.electronDist=$electronDist",
  '--config.win.signExecutable=false'
)
if ($Dir) { $argsList += '--dir' }

Write-Host "building with $node"
& $node @argsList
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
Write-Host 'done: see dist/'

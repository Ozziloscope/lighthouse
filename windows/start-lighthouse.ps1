# Starts Lighthouse on Windows so it shows as "lighthouse.exe" in Task Manager instead of "node.exe".
#
# Windows names a process after its program file, so this script keeps a copy of your installed
# node.exe named lighthouse.exe in the "runtime" folder and runs the server with it. The copy is
# refreshed automatically whenever Node.js is upgraded. The copy keeps Node's digital signature.
#
# Settings: if a file called lighthouse.env sits in the Lighthouse folder, it is loaded
# (same format as deploy\lighthouse.env.example). Use -EnvFile to point at a different file.
#
# Usage (PowerShell, from anywhere):   .\windows\start-lighthouse.ps1
# Or double-click start-lighthouse.cmd, which runs this without changing PowerShell's script policy.
param(
  [string]$EnvFile = "lighthouse.env"
)
$ErrorActionPreference = "Stop"

$PROCESS_NAME = "lighthouse"
$MINIMUM_NODE_VERSION = [version]"22.13.0"

$appFolder = Split-Path -Parent $PSScriptRoot
$runtimeFolder = Join-Path $appFolder "runtime"
$lighthouseExe = Join-Path $runtimeFolder "$PROCESS_NAME.exe"

# 1. Find the installed Node.js and check its version.
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Host "Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
  exit 1
}
$installedNode = $nodeCommand.Source
$nodeVersion = [version]((& $installedNode --version).TrimStart("v"))
if ($nodeVersion -lt $MINIMUM_NODE_VERSION) {
  Write-Host "Lighthouse needs Node.js $MINIMUM_NODE_VERSION or newer; this PC has $nodeVersion." -ForegroundColor Red
  exit 1
}

# 2. Make (or refresh) runtime\lighthouse.exe as a copy of node.exe.
$copyIsMissingOrOld = $true
if (Test-Path $lighthouseExe) {
  $original = Get-Item $installedNode
  $copy = Get-Item $lighthouseExe
  $copyIsMissingOrOld = ($original.Length -ne $copy.Length) -or ($original.LastWriteTimeUtc -ne $copy.LastWriteTimeUtc)
}
if ($copyIsMissingOrOld) {
  New-Item -ItemType Directory -Force -Path $runtimeFolder | Out-Null
  Copy-Item -Path $installedNode -Destination $lighthouseExe -Force
  Write-Host "Prepared $lighthouseExe from Node.js $nodeVersion"
}

# 3. Start the server.
$arguments = @("--disable-warning=ExperimentalWarning")
$envPath = Join-Path $appFolder $EnvFile
if (Test-Path $envPath) {
  $arguments += "--env-file=$envPath"
  Write-Host "Using settings from $envPath"
}
$arguments += (Join-Path $appFolder "server.js")

Set-Location $appFolder
& $lighthouseExe @arguments
exit $LASTEXITCODE

# The launcher: from a downloaded folder to the running app, with nothing needed beforehand.
#
#   1. Node.js: the one on PATH if it is new enough, otherwise a private copy in vendor\node.
#   2. The app's packages (npm ci), when they are missing or package-lock.json has changed.
#   3. A build, when the sources are newer than the last one.
#   4. The app, which offers the components on its first run (ui: ComponentChooser).
#
# Windows PowerShell 5.1, which every Windows 10 and 11 has. Plain ASCII: PowerShell 5.1 reads a
# script without a BOM in the system code page. Nothing here touches anything outside this folder.

param(
  [switch]$PrepareOnly,
  # A project to open, passed on to the app.
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell may default to TLS 1.0, which nodejs.org refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

# Pinned by version and checksum, as everything setup downloads is (setup/manifest.ts).
$NodeVersion = '24.22.2'
$NodeSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
$MinimumNode = [version]'22.18.0'

function Say([string]$Text) { Write-Host "  $Text" }

function Stop-With([string]$What, [string]$Fix) {
  Write-Host ''
  Write-Host "  Pulseforge could not start: $What" -ForegroundColor Red
  Write-Host "  What to do: $Fix"
  exit 1
}

function Find-Node {
  $private = Join-Path $Root 'vendor\node\node.exe'
  if (Test-Path -LiteralPath $private) { return $private }
  $system = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $system) { return $null }
  try {
    $version = [version]((& $system.Source --version).TrimStart('v'))
  } catch {
    return $null
  }
  if ($version -ge $MinimumNode) { return $system.Source }
  return $null
}

function Install-Node {
  $name = "node-v$NodeVersion-win-x64"
  $downloads = Join-Path $Root 'vendor\downloads'
  $zip = Join-Path $downloads "$name.zip"
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  Say "Downloading Node.js $NodeVersion (38 MB)..."
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$name.zip" -OutFile $zip
  } catch {
    Stop-With "Node.js could not be downloaded ($($_.Exception.Message))." 'Check the internet connection and start Pulseforge again.'
  }
  $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $NodeSha256) {
    Remove-Item -LiteralPath $zip -Force
    Stop-With 'the Node.js download does not match its checksum, so it was deleted.' 'Start Pulseforge again. If it repeats, do not bypass it: something is changing the download.'
  }
  Say 'Unpacking Node.js...'
  $temp = Join-Path $Root 'vendor\node-unpack'
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $temp
  Move-Item -LiteralPath (Join-Path $temp $name) -Destination (Join-Path $Root 'vendor\node')
  Remove-Item -LiteralPath $temp -Recurse -Force
}

function Test-PackagesCurrent {
  $stamp = Join-Path $Root 'node_modules\.pulseforge-lock'
  if (-not (Test-Path -LiteralPath $stamp)) { return $false }
  return (Get-Content -LiteralPath $stamp -Raw).Trim() -eq (Get-FileHash -LiteralPath (Join-Path $Root 'package-lock.json') -Algorithm SHA256).Hash
}

function Install-Packages([string]$NodeDir) {
  Say 'Installing the app''s packages (about 250 MB, the first time)...'
  $npm = Join-Path $NodeDir 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npm)) { $npm = 'npm.cmd' }
  & $npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Stop-With 'npm could not install the packages.' 'Check the internet connection, then start Pulseforge again.' }
  (Get-FileHash -LiteralPath (Join-Path $Root 'package-lock.json') -Algorithm SHA256).Hash | Set-Content -LiteralPath (Join-Path $Root 'node_modules\.pulseforge-lock')
}

function Test-BuildCurrent {
  $main = Join-Path $Root 'dist\app\main.js'
  if (-not (Test-Path -LiteralPath $main)) { return $false }
  $built = (Get-Item -LiteralPath $main).LastWriteTimeUtc
  foreach ($folder in 'src', 'setup', 'scripts') {
    $newer = Get-ChildItem -LiteralPath (Join-Path $Root $folder) -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt $built } | Select-Object -First 1
    if ($null -ne $newer) { return $false }
  }
  return $true
}

Write-Host ''
Write-Host '  Pulseforge'
Write-Host ''

$node = Find-Node
if ($null -eq $node) {
  Install-Node
  $node = Find-Node
  if ($null -eq $node) { Stop-With 'Node.js did not unpack.' 'Delete the vendor\node folder and start Pulseforge again.' }
}
$nodeDir = Split-Path -Parent $node
$env:Path = "$nodeDir;$env:Path"

if (-not (Test-PackagesCurrent)) { Install-Packages $nodeDir }

if (-not (Test-BuildCurrent)) {
  Say 'Building the app...'
  & $node --disable-warning=ExperimentalWarning (Join-Path $Root 'scripts\app.ts')
  if ($LASTEXITCODE -ne 0) { Stop-With 'the build failed.' 'Copy the messages above into a bug report.' }
}

if ($PrepareOnly) { exit 0 }

$electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) {
  Remove-Item -LiteralPath (Join-Path $Root 'node_modules\.pulseforge-lock') -Force -ErrorAction SilentlyContinue
  Stop-With 'the Electron runtime is missing.' 'Start Pulseforge again: it will reinstall the packages.'
}
# Quoted by hand: Start-Process joins its arguments with spaces and does not quote them.
$arguments = @(Join-Path $Root 'dist\app\main.js') + @($AppArgs | Where-Object { $_ }) | ForEach-Object { '"' + (Resolve-Path -LiteralPath $_).Path + '"' }
Start-Process -FilePath $electron -ArgumentList $arguments

@echo off
setlocal
cd /d "%~dp0"

set "REGISTRY_DIR=%APPDATA%\FACEIT\extension-loader"
set "REGISTRY_FILE=%REGISTRY_DIR%\installed.json"
set "EXTENSIONS_DIR=%REGISTRY_DIR%\extensions"
set "REPEEK_EXTENSION_ID=mokknliiomknodkdmpcellamkopbdmao"
set "REPEEK_DEST=%EXTENSIONS_DIR%\repeek"
set "REPEEK_CRX_URL=https://clients2.google.com/service/update2/crx?response=redirect&prodversion=150.0.0.0&acceptformat=crx3&x=id%%3D%REPEEK_EXTENSION_ID%%%26installsource%%3Dondemand%%26uc"

if not exist "%REGISTRY_DIR%" mkdir "%REGISTRY_DIR%"
if not exist "%EXTENSIONS_DIR%" mkdir "%EXTENSIONS_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$temp = Join-Path $env:TEMP ('faceit-repeek-' + [guid]::NewGuid().ToString('N'));" ^
  "$crx = Join-Path $temp 'repeek.crx';" ^
  "$zip = Join-Path $temp 'repeek.zip';" ^
  "New-Item -ItemType Directory -Path $temp | Out-Null;" ^
  "try {" ^
  "  Write-Host 'Downloading Repeek from Chrome Web Store...';" ^
  "  Invoke-WebRequest -Uri $env:REPEEK_CRX_URL -OutFile $crx -UseBasicParsing -Headers @{ 'User-Agent' = 'Mozilla/5.0' };" ^
  "  $bytes = [System.IO.File]::ReadAllBytes($crx);" ^
  "  if ($bytes.Length -lt 16 -or [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'Cr24') { throw 'Downloaded file is not a CRX package.' }" ^
  "  $version = [BitConverter]::ToUInt32($bytes, 4);" ^
  "  if ($version -eq 3) {" ^
  "    $headerSize = [BitConverter]::ToUInt32($bytes, 8);" ^
  "    $zipOffset = 12 + [int]$headerSize;" ^
  "  } elseif ($version -eq 2) {" ^
  "    $publicKeySize = [BitConverter]::ToUInt32($bytes, 8);" ^
  "    $signatureSize = [BitConverter]::ToUInt32($bytes, 12);" ^
  "    $zipOffset = 16 + [int]$publicKeySize + [int]$signatureSize;" ^
  "  } else {" ^
  "    throw ('Unsupported CRX version: ' + $version);" ^
  "  }" ^
  "  if ($zipOffset -le 0 -or $zipOffset -ge $bytes.Length) { throw 'Invalid CRX ZIP offset.' }" ^
  "  $zipBytes = New-Object byte[] ($bytes.Length - $zipOffset);" ^
  "  [Array]::Copy($bytes, $zipOffset, $zipBytes, 0, $zipBytes.Length);" ^
  "  [System.IO.File]::WriteAllBytes($zip, $zipBytes);" ^
  "  if (Test-Path $env:REPEEK_DEST) { Remove-Item -Path $env:REPEEK_DEST -Recurse -Force }" ^
  "  New-Item -ItemType Directory -Path $env:REPEEK_DEST | Out-Null;" ^
  "  Expand-Archive -Path $zip -DestinationPath $env:REPEEK_DEST -Force;" ^
  "  $manifestPath = Join-Path $env:REPEEK_DEST 'manifest.json';" ^
  "  if (-not (Test-Path $manifestPath)) { throw ('manifest.json was not found after unpacking: ' + $env:REPEEK_DEST) }" ^
  "  $manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json;" ^
  "  $entries = @();" ^
  "  if (Test-Path $env:REGISTRY_FILE) {" ^
  "    try {" ^
  "      $existing = Get-Content -Raw -Encoding UTF8 $env:REGISTRY_FILE | ConvertFrom-Json;" ^
  "      foreach ($entry in @($existing.extensions)) {" ^
  "        if (-not $entry) { continue }" ^
  "        $entryPath = if ($entry.path) { [string]$entry.path } else { '' };" ^
  "        $entryId = if ($entry.id) { [string]$entry.id } else { '' };" ^
  "        if ($entryId -eq $env:REPEEK_EXTENSION_ID) { continue }" ^
  "        if ($entryPath -and (($entryPath -replace '\\', '/') -eq (($env:REPEEK_DEST -replace '\\', '/')))) { continue }" ^
  "        $entries += $entry;" ^
  "      }" ^
  "    } catch {" ^
  "      Write-Host 'Existing registry could not be parsed; it will be replaced.';" ^
  "    }" ^
  "  }" ^
  "  $repeekEntry = [ordered]@{ path = ($env:REPEEK_DEST -replace '\\', '/'); enabled = $true; id = $env:REPEEK_EXTENSION_ID; name = $manifest.name };" ^
  "  $json = [ordered]@{ version = 1; extensions = @($repeekEntry) + $entries } | ConvertTo-Json -Depth 8;" ^
  "  $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false;" ^
  "  [System.IO.File]::WriteAllText($env:REGISTRY_FILE, $json + [Environment]::NewLine, $encoding);" ^
  "  Write-Host 'Installed Repeek:' $env:REPEEK_DEST;" ^
  "  Write-Host 'Wrote registry:' $env:REGISTRY_FILE;" ^
  "} finally {" ^
  "  if (Test-Path $temp) { Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue }" ^
  "}"

if errorlevel 1 (
  echo.
  echo Repeek Web Store install failed. As a fallback, install Repeek in Chrome or Edge and run:
  echo   6-enable-repeek-from-browser.bat
  echo.
  pause
  exit /b 1
)

echo.
pause

@echo off
setlocal
cd /d "%~dp0"

set "REGISTRY_DIR=%APPDATA%\FACEIT\extension-loader"
set "REGISTRY_FILE=%REGISTRY_DIR%\installed.json"
set "SMOKE_EXTENSION_PATH=%~dp0smoke-extension"
set "REPEEK_EXTENSION_ID=mokknliiomknodkdmpcellamkopbdmao"

if not exist "%REGISTRY_DIR%" mkdir "%REGISTRY_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$id = $env:REPEEK_EXTENSION_ID;" ^
  "$roots = @(" ^
  "  Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data';" ^
  "  Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data';" ^
  "  Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data';" ^
  "  Join-Path $env:APPDATA 'Opera Software\Opera Stable'" ^
  ") | Where-Object { Test-Path $_ };" ^
  "$manifests = foreach ($root in $roots) {" ^
  "  Get-ChildItem -Path (Join-Path $root ('*\Extensions\' + $id + '\*\manifest.json')) -File -ErrorAction SilentlyContinue;" ^
  "  Get-ChildItem -Path (Join-Path $root ('Extensions\' + $id + '\*\manifest.json')) -File -ErrorAction SilentlyContinue;" ^
  "};" ^
  "$selectedManifest = $manifests | Sort-Object LastWriteTime -Descending | Select-Object -First 1;" ^
  "$selected = if ($selectedManifest) { $selectedManifest.Directory } else { $null };" ^
  "if (-not $selected) {" ^
  "  Write-Host 'Repeek was not found in Chrome/Edge/Brave/Opera profiles.';" ^
  "  Write-Host 'Install Repeek from Chrome Web Store first, then run this file again.';" ^
  "  exit 2;" ^
  "}" ^
  "$extensions = @([ordered]@{ path = ($selected.FullName -replace '\\', '/'); enabled = $true; id = $id; name = 'Repeek' });" ^
  "if (Test-Path (Join-Path $env:SMOKE_EXTENSION_PATH 'manifest.json')) { $extensions += [ordered]@{ path = ($env:SMOKE_EXTENSION_PATH -replace '\\', '/'); enabled = $true; name = 'Smoke Test' } }" ^
  "$json = [ordered]@{ version = 1; extensions = $extensions } | ConvertTo-Json -Depth 5;" ^
  "$encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false;" ^
  "[System.IO.File]::WriteAllText($env:REGISTRY_FILE, $json + [Environment]::NewLine, $encoding);" ^
  "Write-Host 'Wrote registry:' $env:REGISTRY_FILE;" ^
  "Write-Host 'Repeek extension:' $selected.FullName"

if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
pause

@echo off
setlocal
cd /d "%~dp0"

set "REGISTRY_DIR=%APPDATA%\FACEIT\extension-loader"
set "REGISTRY_FILE=%REGISTRY_DIR%\installed.json"
set "EXTENSION_PATH=%~dp0smoke-extension"

if not exist "%EXTENSION_PATH%\manifest.json" (
  echo Smoke extension was not found:
  echo   %EXTENSION_PATH%
  pause
  exit /b 1
)

if not exist "%REGISTRY_DIR%" mkdir "%REGISTRY_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$path = $env:EXTENSION_PATH -replace '\\', '/';" ^
  "$json = [ordered]@{ version = 1; extensions = @([ordered]@{ path = $path; enabled = $true }) } | ConvertTo-Json -Depth 5;" ^
  "$encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false;" ^
  "[System.IO.File]::WriteAllText($env:REGISTRY_FILE, $json + [Environment]::NewLine, $encoding);" ^
  "Write-Host 'Wrote registry:' $env:REGISTRY_FILE;" ^
  "Write-Host 'Smoke extension:' $path"

echo.
pause

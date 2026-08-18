@echo off
setlocal

set "FACEIT_ROOT=%LOCALAPPDATA%\FACEIT"
if not exist "%FACEIT_ROOT%" (
  echo FACEIT install root was not found:
  echo   %FACEIT_ROOT%
  echo.
  pause
  exit /b 1
)

call "%~dp0_ensure-faceit-closed.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = Join-Path $env:LOCALAPPDATA 'FACEIT';" ^
  "if (!(Test-Path $root)) { Write-Error \"FACEIT install root was not found: $root\"; exit 1 }" ^
  "$app = Get-ChildItem -LiteralPath $root -Directory -Filter 'app-*' | Sort-Object @{ Expression = { try { [version]($_.Name -replace '^app-', '') } catch { [version]'0.0.0' } }; Descending = $true }, LastWriteTime -Descending | Select-Object -First 1;" ^
  "if (!$app) { Write-Error \"No app-* directory found under $root\"; exit 1 }" ^
  "$exe = Join-Path $app.FullName 'FACEIT.exe';" ^
  "if (!(Test-Path $exe)) { Write-Error \"FACEIT.exe was not found: $exe\"; exit 1 }" ^
  "Write-Host 'Starting:' $exe;" ^
  "Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222';" ^
  "Start-Sleep -Seconds 5;" ^
  "Start-Process 'http://127.0.0.1:9222/json/list'"

echo.
echo FACEIT should now be running with remote debugging on port 9222.
echo If Chrome opened a JSON page, send me that output or screenshot.
echo.
pause

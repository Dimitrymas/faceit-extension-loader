@echo off
setlocal
cd /d "%~dp0"

set "FACEIT_ROOT=%LOCALAPPDATA%\FACEIT"
if not exist "%FACEIT_ROOT%" (
  echo FACEIT install root was not found:
  echo   %FACEIT_ROOT%
  echo.
  echo Install and close the FACEIT desktop client, then run this again.
  pause
  exit /b 1
)

call "%~dp0_ensure-faceit-closed.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo Patching latest FACEIT app.asar under:
echo   %FACEIT_ROOT%
echo.
"%~dp0node\node.exe" "%~dp0scripts\install-update-hook-payload.js" "%LOCALAPPDATA%\FACEIT Mods\current"
if errorlevel 1 (
  echo Could not install the event-driven FACEIT update hook payload.
  echo.
  pause
  exit /b 1
)
"%~dp0node\node.exe" "%~dp0bin\faceit-extension-loader.js" patch "%FACEIT_ROOT%"
echo.
"%~dp0node\node.exe" "%~dp0bin\faceit-extension-loader.js" inspect "%FACEIT_ROOT%"
echo.
pause

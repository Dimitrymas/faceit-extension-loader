@echo off
setlocal
cd /d "%~dp0"

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

echo Restoring app.asar from app.asar.orig under:
echo   %FACEIT_ROOT%
echo.
"%~dp0node\node.exe" "%~dp0bin\faceit-extension-loader.js" restore "%FACEIT_ROOT%"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
reg delete "HKCU\Software\Classes\faceit-mods" /f >nul 2>nul
reg delete "HKCU\Software\Classes\addonport" /f >nul 2>nul
reg delete "HKCU\Software\FACEIT Mods" /f >nul 2>nul
reg delete "HKCU\Software\AddonPort\FACEIT" /f >nul 2>nul
del /q "%LOCALAPPDATA%\FACEIT Mods\installed.marker" >nul 2>nul
echo Removed the AddonPort protocol handlers.
echo.
pause

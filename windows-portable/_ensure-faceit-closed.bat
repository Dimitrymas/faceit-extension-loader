@echo off
setlocal EnableExtensions

call :is_faceit_running
if errorlevel 1 exit /b 0

echo.
echo WARNING: The FACEIT desktop client is currently running.
echo It must be closed before this operation can continue.
echo Only FACEIT.exe will be closed; FACEIT Anti-Cheat services are not touched.

echo.
echo Closing FACEIT immediately...
taskkill /IM FACEIT.exe /T >nul 2>&1

for /L %%I in (1,1,5) do (
  call :is_faceit_running
  if errorlevel 1 goto :closed
  timeout /T 1 /NOBREAK >nul
)

echo FACEIT did not exit normally; closing the remaining desktop processes...
taskkill /F /IM FACEIT.exe /T >nul 2>&1

for /L %%I in (1,1,5) do (
  call :is_faceit_running
  if errorlevel 1 goto :closed
  timeout /T 1 /NOBREAK >nul
)

echo ERROR: FACEIT.exe is still running. Close it from Task Manager and try again.
exit /b 1

:closed
echo FACEIT is closed. Continuing...
exit /b 0

:is_faceit_running
tasklist /FI "IMAGENAME eq FACEIT.exe" /FO CSV /NH 2>nul | findstr /I /C:"FACEIT.exe" >nul
if errorlevel 1 exit /b 1
exit /b 0

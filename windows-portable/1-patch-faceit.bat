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
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$root = Join-Path $env:LOCALAPPDATA 'FACEIT';" ^
  "$exe = Join-Path $root 'FACEIT.exe';" ^
  "if (-not (Test-Path $exe)) {" ^
  "  $app = Get-ChildItem -LiteralPath $root -Directory -Filter 'app-*' | Sort-Object @{ Expression = { try { [version]($_.Name -replace '^app-', '') } catch { [version]'0.0.0' } }; Descending = $true }, LastWriteTime -Descending | Select-Object -First 1;" ^
  "  if (-not $app) { throw ('No FACEIT launcher found under ' + $root) }" ^
  "  $exe = Join-Path $app.FullName 'FACEIT.exe';" ^
  "}" ^
  "if (-not (Test-Path $exe)) { throw ('FACEIT.exe was not found: ' + $exe) }" ^
  "$handler = 'HKCU:\Software\Classes\faceit-mods';" ^
  "$addonportHandler = 'HKCU:\Software\Classes\addonport';" ^
  "$product = 'HKCU:\Software\FACEIT Mods';" ^
  "$addonportProduct = 'HKCU:\Software\AddonPort\FACEIT';" ^
  "$version = (Get-Content -LiteralPath '%~dp0package.json' -Raw | ConvertFrom-Json).version;" ^
  "New-Item -Path $handler -Force | Out-Null;" ^
  "Set-Item -Path $handler -Value 'URL:AddonPort for FACEIT legacy link';" ^
  "New-ItemProperty -Path $handler -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null;" ^
  "New-Item -Path (Join-Path $handler 'DefaultIcon') -Force | Out-Null;" ^
  "Set-Item -Path (Join-Path $handler 'DefaultIcon') -Value ('\"' + $exe + '\"');" ^
  "New-Item -Path (Join-Path $handler 'shell\open\command') -Force | Out-Null;" ^
  "Set-Item -Path (Join-Path $handler 'shell\open\command') -Value ('\"' + $exe + '\" \"%1\"');" ^
  "New-Item -Path $addonportHandler -Force | Out-Null;" ^
  "Set-Item -Path $addonportHandler -Value 'URL:AddonPort link';" ^
  "New-ItemProperty -Path $addonportHandler -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null;" ^
  "New-Item -Path (Join-Path $addonportHandler 'DefaultIcon') -Force | Out-Null;" ^
  "Set-Item -Path (Join-Path $addonportHandler 'DefaultIcon') -Value ('\"' + $exe + '\"');" ^
  "New-Item -Path (Join-Path $addonportHandler 'shell\open\command') -Force | Out-Null;" ^
  "Set-Item -Path (Join-Path $addonportHandler 'shell\open\command') -Value ('\"' + $exe + '\" \"%1\"');" ^
  "New-Item -Path $product -Force | Out-Null;" ^
  "New-ItemProperty -Path $product -Name 'DisplayName' -Value 'AddonPort for FACEIT' -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $product -Name 'DisplayVersion' -Value $version -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $product -Name 'InstallLocation' -Value (Join-Path $env:LOCALAPPDATA 'FACEIT Mods\current') -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $product -Name 'Protocol' -Value 'faceit-mods' -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $product -Name 'ProtocolVersion' -Value '1' -PropertyType String -Force | Out-Null;" ^
  "New-Item -Path $addonportProduct -Force | Out-Null;" ^
  "New-ItemProperty -Path $addonportProduct -Name 'DisplayName' -Value 'AddonPort for FACEIT' -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $addonportProduct -Name 'DisplayVersion' -Value $version -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $addonportProduct -Name 'InstallLocation' -Value (Join-Path $env:LOCALAPPDATA 'FACEIT Mods\current') -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $addonportProduct -Name 'Protocol' -Value 'addonport' -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $addonportProduct -Name 'ProtocolVersion' -Value '2' -PropertyType String -Force | Out-Null;" ^
  "New-ItemProperty -Path $addonportProduct -Name 'LegacyProtocol' -Value 'faceit-mods' -PropertyType String -Force | Out-Null;" ^
  "$marker = Join-Path $env:LOCALAPPDATA 'FACEIT Mods\installed.marker';" ^
  "[IO.File]::WriteAllText($marker, ($version + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)));" ^
  "Write-Host 'Registered addonport:// and legacy faceit-mods:// handlers for:' $exe"
if errorlevel 1 (
  echo Could not register the AddonPort protocol handlers.
  echo.
  pause
  exit /b 1
)
echo.
"%~dp0node\node.exe" "%~dp0bin\faceit-extension-loader.js" inspect "%FACEIT_ROOT%"
echo.
pause

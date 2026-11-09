@echo off
rem Fabric MCP Studio - update helper.
rem If this is a full app copy, run the in-place updater script.
rem If this is just the installer package, fall back to installer update.
setlocal
title Fabric MCP Studio - update

set "REPO_PS1=%~dp0..\scripts\update-studio.ps1"
if exist "%REPO_PS1%" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO_PS1%" %*
  set "RC=%ERRORLEVEL%"
  echo.
  if not "%RC%"=="0" echo  The update stopped ^(code %RC%^). The messages above show why.
  if "%~1"=="" pause
  exit /b %RC%
)

set "PS1=%~dp0files\Install-FabricMCPStudio.ps1"
if exist "%PS1%" (
  echo.
  echo  Full app files were not found next to this command.
  echo  Running the installer update path instead...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
  set "RC=%ERRORLEVEL%"
  echo.
  if "%~1"=="" pause
  exit /b %RC%
)

echo.
echo  The updater files are missing next to this command.
echo  Extract the whole zip file first ^(right-click it ^> Extract All^), then run this file again.
echo.
pause
exit /b 1

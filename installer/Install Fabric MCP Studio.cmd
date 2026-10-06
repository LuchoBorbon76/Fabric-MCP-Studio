@echo off
rem Fabric MCP Studio - installer. Double-click to install or update the app (see README.txt).
setlocal
title Fabric MCP Studio - installer
set "PS1=%~dp0files\Install-FabricMCPStudio.ps1"
if not exist "%PS1%" (
  echo.
  echo  The installer files are missing next to this file.
  echo  Extract the whole zip file first ^(right-click it ^> Extract All^), then run this file from the extracted folder.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo  The installer stopped ^(code %RC%^). The messages and the log file above say why.
if "%~1"=="" pause
exit /b %RC%

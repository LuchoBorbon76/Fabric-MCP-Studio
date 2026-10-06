@echo off
rem Fabric MCP Studio - shows which prerequisites are installed, missing or too old. Changes nothing.
setlocal
title Fabric MCP Studio - prerequisites
set "PS1=%~dp0files\Install-FabricMCPStudio.ps1"
if not exist "%PS1%" (
  echo.
  echo  The installer files are missing next to this file. Extract the whole zip file first, then run this file again.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -CheckOnly %*
set "RC=%ERRORLEVEL%"
echo.
if "%~1"=="" pause
exit /b %RC%

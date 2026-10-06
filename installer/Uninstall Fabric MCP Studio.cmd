@echo off
rem Fabric MCP Studio - removes the shortcuts and the app folder. Git, Node.js and the other tools stay installed.
rem Your projects, chats and settings are kept next to the app folder (remove -KeepData below to delete them too).
setlocal
title Fabric MCP Studio - uninstall
set "PS1=%~dp0files\Install-FabricMCPStudio.ps1"
if not exist "%PS1%" (
  echo.
  echo  The installer files are missing next to this file. Extract the whole zip file first, then run this file again.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Uninstall -KeepData %*
set "RC=%ERRORLEVEL%"
echo.
if "%~1"=="" pause
exit /b %RC%

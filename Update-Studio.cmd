@echo off
setlocal
rem Updates this local copy of Fabric MCP Studio, refreshes dependencies, and starts it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-studio.ps1" %*
if errorlevel 1 (
  echo.
  echo Update failed.
  pause
  exit /b %errorlevel%
)

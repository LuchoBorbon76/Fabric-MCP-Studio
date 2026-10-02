@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js 20 or later is required. Install the LTS version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules\@github\copilot-sdk (
  echo Installing Fabric MCP Studio dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed. Check your network or proxy settings and try again.
    pause
    exit /b 1
  )
)
node server\main.mjs %*
if errorlevel 1 pause

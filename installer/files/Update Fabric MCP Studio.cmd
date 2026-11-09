@echo off
rem Fabric MCP Studio - update helper from installer\files.
setlocal
set "ROOT_UPDATE=%~dp0..\Update Fabric MCP Studio.cmd"
if exist "%ROOT_UPDATE%" (
  call "%ROOT_UPDATE%" %*
  exit /b %ERRORLEVEL%
)
echo.
echo  Could not find "..\Update Fabric MCP Studio.cmd" next to this file.
echo  Run the updater from the installer root folder.
echo.
pause
exit /b 1

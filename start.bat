@echo off
setlocal
rem LocalAI launcher for Windows: installs dependencies on first run, then starts the app.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules\electron" (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 goto failed
)

call npm start
goto :eof

:nonode
echo Node.js was not found. Install the LTS version 22 or newer from https://nodejs.org and run this file again.
pause
exit /b 1

:failed
echo npm install failed. Check your internet connection and try again.
pause
exit /b 1

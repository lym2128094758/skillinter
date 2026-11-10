@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 24.9 or newer.
  pause
  exit /b 1
)
node --env-file-if-exists=.env start.mjs --open
if errorlevel 1 (
  echo.
  echo Skillinter could not start. See the error above.
  pause
  exit /b 1
)

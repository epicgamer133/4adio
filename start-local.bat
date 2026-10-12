@echo off
rem Double-click to run the radio locally. Close this window to stop it.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-fund --no-audit
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env - set ADMIN_PASSWORD in it, then run this again.
  notepad .env
  exit /b
)
start "" http://127.0.0.1:8090
node server/index.js
pause

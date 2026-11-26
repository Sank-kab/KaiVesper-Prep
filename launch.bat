@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 18+ is required. Download it from https://nodejs.org
  pause
  exit /b 1
)
start "" /b node server.cjs
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:47822

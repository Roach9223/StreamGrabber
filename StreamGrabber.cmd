@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not on PATH. Install it from nodejs.org and try again. & pause & exit /b 1)
if not exist node_modules (
  echo First run: installing dependencies and the headless browser...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
node server.js %*

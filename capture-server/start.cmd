@echo off
REM Double-click to run the HTML to Figma capture service.
REM Keep this window open while you use "Import from URL" in the Figma plugin.
title HTML to Figma - capture service
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node 22 or newer from https://nodejs.org
  echo.
  pause
  exit /b 1
)
node capture-server\server.js
echo.
echo The capture service stopped.
pause

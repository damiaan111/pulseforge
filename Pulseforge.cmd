@echo off
rem Double-click to start Pulseforge. The first run fetches what it needs into this folder, and
rem nothing is installed anywhere else. Everything real is in launcher\start.ps1.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\start.ps1" %*
if errorlevel 1 (
  echo.
  pause
)

@echo off
setlocal
cd /d "%~dp0"
set "PET_NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined PET_NODE set "PET_NODE=%%I"
if not defined PET_NODE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "PET_NODE=%%D\node.exe"
if not defined PET_NODE (
  echo Node.js 22 or later is required. Ask the Agent that installed this project.
  pause
  exit /b 1
)
"%PET_NODE%" scripts/start-local.js --open
if errorlevel 1 pause

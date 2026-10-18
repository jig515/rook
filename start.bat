@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal
title rook gateway

echo.
echo   rook - local model gateway
echo   ----------------------------------------------
echo.

rem ------------------------------------------------------------------- node
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE set "NODE=%%i"
)
if not defined NODE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE if exist "%%d\node.exe" set "NODE=%%d\node.exe"
  )
)
if not defined NODE (
  for %%p in ("C:\Program Files\nodejs\node.exe" "C:\Program Files (x86)\nodejs\node.exe") do (
    if not defined NODE if exist %%p set "NODE=%%p"
  )
)

if not defined NODE (
  echo   [X] Node.js not found.
  echo       Install Node 20.3 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

"%NODE%" -e "process.exit(AbortSignal.any?0:1)" >nul 2>nul
if errorlevel 1 (
  echo   [X] Node is too old: %NODE%
  echo       This gateway needs 20.3+ ^(AbortSignal.any^).
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------------------- port
rem for /f chokes on nested quotes, so round-trip through a temp file
set "PORT=8790"
set "PORTTMP=%TEMP%\rook_port.txt"
if exist "config.json" (
  "%NODE%" -e "process.stdout.write(String(require('./config.json').port||8790))" >"%PORTTMP%" 2>nul
  if exist "%PORTTMP%" (
    set /p PORT=<"%PORTTMP%"
    del "%PORTTMP%" >nul 2>nul
  )
)
if not defined PORT set "PORT=8790"

echo   node      %NODE%
echo   console   http://127.0.0.1:%PORT%/
echo.
echo   Ctrl+C stops it. Do not just close this window - spawned
echo   CLI children may survive.
echo.

rem ------------------------------------------------------------ open the ui
if not defined ROOK_NO_BROWSER (
  start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & explorer http://127.0.0.1:%PORT%/"
)

rem -------------------------------------------------------------------- run
"%NODE%" server.js
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo   [X] server exited with code %CODE%
  echo       Port %PORT% in use? Change "port" in config.json,
  echo       or run "node server.js" here to see the full error.
) else (
  echo   stopped.
)
echo.
pause

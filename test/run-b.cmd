@echo off
REM run-b.cmd — boot the remote-b instance on 127.0.0.1:3112 with its own DSH_HOME.
REM Foreground process; logs go to test\logs\remote-b.log. Stop with test\stop.cmd.
setlocal
set "ROOT=%~dp0"
set "DSH_HOME=%USERPROFILE%\.dsh-remote-b"
set "PROFILE=remote-b"
set "PORT=3112"
if not exist "%ROOT%logs" mkdir "%ROOT%logs"

if exist "%ROOT%.env.local" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%.env.local") do (
    if /i "%%A"=="DSH_RELAY_TOKEN" set "DSH_RELAY_TOKEN=%%B"
  )
)

if not defined DSH_CLI (
  for /d %%D in ("%LOCALAPPDATA%\npm-cache\_npx\*") do (
    if exist "%%D\node_modules\@deepseek-ai\dsh\lib\bin.js" set "DSH_CLI=%%D\node_modules\@deepseek-ai\dsh\lib\bin.js"
  )
)
if not exist "%DSH_CLI%" (
  echo [run-b] dsh CLI not found. Set DSH_CLI=...\@deepseek-ai\dsh\lib\bin.js
  exit /b 1
)
if not defined DSH_RELAY_TOKEN echo [run-b] note: DSH_RELAY_TOKEN is not set; relay features will stay idle.

echo [run-b] DSH_HOME=%DSH_HOME%
echo [run-b] profile=%PROFILE%  http://127.0.0.1:%PORT%   log=%ROOT%logs\remote-b.log
node "%DSH_CLI%" --profile %PROFILE% --port %PORT% --host 127.0.0.1 --no-open > "%ROOT%logs\remote-b.log" 2>&1
exit /b %errorlevel%

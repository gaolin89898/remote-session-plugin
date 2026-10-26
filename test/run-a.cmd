@echo off
REM run-a.cmd — boot the remote-a instance on 127.0.0.1:3111 with its own DSH_HOME.
REM Foreground process; logs go to test\logs\remote-a.log. Stop with test\stop.cmd.
setlocal
set "ROOT=%~dp0"
set "DSH_HOME=%USERPROFILE%\.dsh-remote-a"
set "PROFILE=remote-a"
set "PORT=3111"
if not exist "%ROOT%logs" mkdir "%ROOT%logs"

REM Optional local relay token: test\.env.local with a single line DSH_RELAY_TOKEN=...
REM The token is runtime-only and must never be committed (test\.gitignore covers it).
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
  echo [run-a] dsh CLI not found. Set DSH_CLI=...\@deepseek-ai\dsh\lib\bin.js
  exit /b 1
)
if not defined DSH_RELAY_TOKEN echo [run-a] note: DSH_RELAY_TOKEN is not set; relay features will stay idle.

echo [run-a] DSH_HOME=%DSH_HOME%
echo [run-a] profile=%PROFILE%  http://127.0.0.1:%PORT%   log=%ROOT%logs\remote-a.log
node "%DSH_CLI%" --profile %PROFILE% --port %PORT% --host 127.0.0.1 --no-open > "%ROOT%logs\remote-a.log" 2>&1
exit /b %errorlevel%

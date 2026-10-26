@echo off
REM stop.cmd — kill whatever listens on the two test ports (3111 / 3112).
REM Only touches listeners of these ports; the user's own dsh (3080) is left alone.
setlocal
set FOUND=0
for %%P in (3111 3112) do (
  for /f "tokens=5" %%X in ('netstat -ano ^| findstr /r ":%%P .*LISTENING"') do (
    echo [stop] killing PID %%X on port %%P
    taskkill /F /PID %%X >nul 2>&1
    set FOUND=1
  )
)
if "%FOUND%"=="0" echo [stop] nothing listening on 3111/3112
echo [stop] done (logs kept in %~dp0logs)

@echo off
REM setup.cmd — execution-policy-safe wrapper around setup.ps1.
REM Everything is written to temp DSH homes (%USERPROFILE%\.dsh-remote-a|b);
REM the real ~/.dsh (desktop profile, sessions, storages) is never touched.
setlocal
set "PS=powershell"
where pwsh >nul 2>&1 && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
exit /b %errorlevel%

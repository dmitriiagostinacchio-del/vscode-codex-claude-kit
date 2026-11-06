@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Please install Node.js 22 or newer, then run this file again.
 pause
 exit /b 1
)
node "%~dp0install.cjs"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Failed. Read the error above before retrying.
pause
exit /b %RESULT%

@echo off
REM Posts a lead CSV to the CRM straight from the command line.
REM Usage:  push "C:\path\to\leads.csv"
REM Checks first and sends nothing until you confirm.
cd /d "%~dp0"
if "%~1"=="" (
  echo.
  echo  Usage: push "C:\path\to\leads.csv"
  echo.
  echo  Drag a CSV onto this file, or pass the path.
  echo  It shows a report first, then asks before posting anything.
  echo.
  pause
  exit /b 1
)
echo.
echo  === STEP 1: checking the file (nothing is sent yet) ===
echo.
node push.js %1
if errorlevel 1 goto done
echo.
echo  === STEP 2: posting ===
echo.
node push.js %1 --post
:done
echo.
pause

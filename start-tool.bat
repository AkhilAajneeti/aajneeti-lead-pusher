@echo off
REM Starts the Lead Pusher web tool and opens it in your browser.
REM Close this window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
echo.
echo  Starting Lead Pusher...
echo  It will open at http://localhost:8788
echo  Leave this window open while you use it.
echo.
start "" http://localhost:8788
npx wrangler pages dev . --port 8788
pause

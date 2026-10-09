@echo off
REM Double-click launcher for the Slopsmith desktop app (dev build).
REM Launches the native Electron window, not the browser view.

cd /d "%~dp0"
set "DLC_DIR=C:/Program Files (x86)/Steam/steamapps/common/Rocksmith2014/dlc"

echo Starting Slopsmith desktop...
echo (Close this window or press Ctrl+C after the app to stop it.)
echo.

call npm run dev

REM Keep the console open if npm exits with an error so the message is visible.
if errorlevel 1 (
  echo.
  echo Slopsmith exited with an error ^(code %errorlevel%^).
  pause
)

@echo off
REM Launch the isolated Slopsmith TEST instance (branch engine build, own settings + plugins).
REM Set it up first with:  python -I setup_test_instance.py
REM Your installed Slopsmith and its files are not touched, but the two can't run at the same
REM time: on startup the app stops any Slopsmith backend on port 18000.

setlocal
set "WT=%USERPROFILE%\Desktop\repos\feedback-upstream\wt-live-pitch"
set "TEST=%USERPROFILE%\SlopsmithTest"

tasklist /FI "IMAGENAME eq Slopsmith.exe" | find /I "Slopsmith.exe" >nul
if not errorlevel 1 (
  echo Your installed Slopsmith is running. Close it first, then run this again.
  pause
  exit /b 1
)
if not exist "%TEST%\core\server.py" (
  echo Test instance not set up. Run: python -I "%~dp0setup_test_instance.py"
  pause
  exit /b 1
)

set "SLOPSMITH_DIR=%TEST%\core"
set "DLC_DIR=C:/Program Files (x86)/Steam/steamapps/common/Rocksmith2014/dlc"

cd /d "%WT%"
echo Building the desktop shell (TypeScript)...
call npm run build:ts || (pause & exit /b 1)
echo Starting Slopsmith TEST instance (engine: %WT%\build\Release)...
call "%WT%\node_modules\.bin\electron.cmd" . --user-data-dir="%TEST%\userdata"
endlocal

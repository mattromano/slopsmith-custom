@echo off
rem Start feedBack Studio from source on http://localhost:8010 (uses the existing venv + build).
cd /d "%~dp0backend"
set "VGMSTREAM_CLI=%cd%\tools\vgmstream\vgmstream-cli.exe"
start "" http://localhost:8010/
".venv\Scripts\python.exe" -m uvicorn app.main:app --port 8010

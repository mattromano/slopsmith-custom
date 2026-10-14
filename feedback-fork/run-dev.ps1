# Run our feedBack build from source in the browser (no desktop app, no native audio).
#   powershell -ExecutionPolicy Bypass -File run-dev.ps1   -> http://localhost:8000
param(
    [string]$Root = "$env:USERPROFILE\Desktop\repos\feedback-upstream",
    [string]$DlcDir = "C:/Program Files (x86)/Steam/steamapps/common/Rocksmith2014/dlc",
    [string]$ConfigDir = "$env:LOCALAPPDATA\feedback-dev",
    [int]$Port = 8000
)
$env:DLC_DIR = $DlcDir
$env:CONFIG_DIR = $ConfigDir
$env:FEEDBACK_PLUGINS_DIR = "$Root\dev-plugins"
$env:PYTHONPATH = "$Root\feedBack\lib;$Root\feedBack"   # as in the Dockerfile
$env:PORT = "$Port"; $env:HOST = "127.0.0.1"
New-Item -ItemType Directory -Force $ConfigDir | Out-Null
Set-Location "$Root\feedBack"
& "$Root\feedBack\.venv\Scripts\python.exe" main.py

# Clone and build feedBack Studio from source (no unsigned installer) for hand-fixing charts and
# placing sync-point anchors.  Runs on http://localhost:8010 via start_feedback_local.bat.
#
#   powershell -ExecutionPolicy Bypass -File song-builder\feedback-studio\setup_feedback_studio.ps1 [-Dest path]
param([string]$Dest = "$env:USERPROFILE\Desktop\feedback-studio-src")
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$Dest\.git")) {
    git clone --depth 1 https://github.com/glferrari1969/feedBack-Studio.git $Dest
}
Push-Location "$Dest\backend"
# system site-packages: reuse the host's GPU torch/demucs instead of the CPU-only pins in requirements-ai.txt
if (-not (Test-Path ".venv\Scripts\python.exe")) { py -3.12 -m venv --system-site-packages .venv }
& ".venv\Scripts\python.exe" -m pip install -r requirements-core.txt
Pop-Location
Push-Location $Dest
npm install --package-lock=false --no-audit --no-fund
npm run build
Pop-Location
Copy-Item "$here\start_feedback_local.bat" "$Dest\start_feedback_local.bat" -Force
New-Item -ItemType Directory -Force "$env:USERPROFILE\Desktop\feedback-studio-work" | Out-Null
Write-Host "Done. Start it with $Dest\start_feedback_local.bat (http://localhost:8010)."

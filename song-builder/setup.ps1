# Set up the song-builder toolchain on a Windows machine.
#
#   powershell -ExecutionPolicy Bypass -File song-builder\setup.ps1 [-Slopsmith C:\path\to\slopsmith] [-SkipHost]
#
# 1. Host Python 3.12 packages (torch CUDA build, demucs, beat_this, pyguitarpro, librosa...).
# 2. The MIR venv at <slopsmith>\_build\.mirvenv: system site-packages + basic-pitch (ONNX, installed
#    --no-deps because its TensorFlow pin has no Python 3.12 wheel) + onnxruntime + livechord refiner.
# 3. The slopsmith-song-builder Claude Code skill into ~/.claude/skills.
# 4. Album YAMLs into <slopsmith>\_build\albums (if missing).
param(
    [string]$Slopsmith = "$env:USERPROFILE\Desktop\slopsmith",
    [switch]$SkipHost
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$Slopsmith\scripts\gp_to_sloppak.py")) {
    throw "No song-builder scripts in $Slopsmith. Point -Slopsmith at your custom Slopsmith checkout (or this repo's slopsmith folder)."
}

if (-not $SkipHost) {
    Write-Host "== host packages (py -3.12)"
    py -3.12 -m pip install torch==2.14.1 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu130
    py -3.12 -m pip install -r "$here\requirements-host.txt"
}

Write-Host "== MIR venv"
$venv = "$Slopsmith\_build\.mirvenv"
if (-not (Test-Path "$venv\Scripts\python.exe")) {
    New-Item -ItemType Directory -Force "$Slopsmith\_build" | Out-Null
    py -3.12 -m venv --system-site-packages $venv
}
& "$venv\Scripts\python.exe" -m pip install livechord-beat-refiner onnxruntime mir-eval pretty-midi "resampy<0.4.3"
& "$venv\Scripts\python.exe" -m pip install --no-deps basic-pitch==0.4.0

Write-Host "== Claude Code skill"
$skillDir = "$env:USERPROFILE\.claude\skills\slopsmith-song-builder"
New-Item -ItemType Directory -Force $skillDir | Out-Null
Copy-Item "$here\skill\SKILL.md" "$skillDir\SKILL.md" -Force

Write-Host "== album YAMLs"
New-Item -ItemType Directory -Force "$Slopsmith\_build\albums" | Out-Null
Get-ChildItem "$here\albums" | ForEach-Object {
    $dst = "$Slopsmith\_build\albums\$($_.Name)"
    if (-not (Test-Path $dst)) { Copy-Item $_.FullName $dst }
}

Write-Host "== check"
& "$venv\Scripts\python.exe" -c "import basic_pitch, livechord_beat_refiner, guitarpro, demucs, beat_this, torch; print('ok, CUDA:', torch.cuda.is_available())"
Write-Host "Done. Optional: song-builder\feedback-studio\setup_feedback_studio.ps1 for the manual sync editor."

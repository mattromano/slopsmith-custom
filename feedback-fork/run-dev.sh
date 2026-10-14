#!/usr/bin/env bash
# Run our feedBack build from source in the browser (no desktop app, no native audio).
#   ./run-dev.sh   -> http://localhost:8000
# Env: FB_ROOT, DLC_DIR (default ~/Desktop/rocksmith/dlc), CONFIG_DIR, PORT
set -euo pipefail
ROOT="${FB_ROOT:-$HOME/Desktop/repos/feedback-upstream}"
export DLC_DIR="${DLC_DIR:-$HOME/Desktop/rocksmith/dlc}"
export CONFIG_DIR="${CONFIG_DIR:-$HOME/.local/share/feedback-dev}"
export FEEDBACK_PLUGINS_DIR="$ROOT/dev-plugins"
export PYTHONPATH="$ROOT/feedBack/lib:$ROOT/feedBack"   # as in the Dockerfile
export PORT="${PORT:-8000}" HOST="${HOST:-127.0.0.1}"
mkdir -p "$CONFIG_DIR"
cd "$ROOT/feedBack"
exec .venv/bin/python main.py

#!/usr/bin/env bash
# Run this custom Slopsmith natively on macOS (no Docker) against the local song library.
#   ./run-mac.sh            -> http://localhost:8000
# Env overrides: DLC_DIR (default ~/Desktop/rocksmith/dlc), PORT (8000), VENV (~/drums-work/.venv)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="${VENV:-$HOME/drums-work/.venv}"
export DLC_DIR="${DLC_DIR:-$HOME/Desktop/rocksmith/dlc}"
export CONFIG_DIR="${CONFIG_DIR:-$HOME/.local/share/slopsmith-custom}"
export SLOPSMITH_PLUGINS_DIR="$HERE/plugins"       # drums, multiplayer, note_detect, nam_tone, autotune
export PYTHONPATH="$HERE/slopsmith/lib:$HERE/slopsmith"
export PORT="${PORT:-8000}" HOST="${HOST:-127.0.0.1}"
mkdir -p "$CONFIG_DIR"
if [ ! -x "$VENV/bin/python" ]; then
  uv venv -q --python 3.11 "$VENV"
fi
uv pip install -q --python "$VENV/bin/python" -r "$HERE/slopsmith/requirements.txt" \
  -r "$HERE/plugins/multiplayer/requirements.txt" 2>/dev/null || true
cd "$HERE/slopsmith"
exec "$VENV/bin/python" main.py

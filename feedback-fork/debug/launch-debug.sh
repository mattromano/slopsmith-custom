#!/usr/bin/env bash
# Launch the INSTALLED feedback app with a Chrome DevTools port so a session can
# drive and inspect the real app (never the browser dev server).
#   ./launch-debug.sh            # port 9333, log at /tmp/feedback-app.log
# Then: node cdp.mjs "<js expression>"   (evaluates in http://127.0.0.1:18000/)
set -euo pipefail
PORT="${PORT:-9333}"
APP=/Applications/feedback.app/Contents/MacOS/feedback
if pgrep -f "$APP( |$)" >/dev/null; then
  echo "feedback is already running — quit it first (ask the user)." >&2; exit 1
fi
exec "$APP" --remote-debugging-port="$PORT" >"${LOG:-/tmp/feedback-app.log}" 2>&1

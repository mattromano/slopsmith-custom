#!/usr/bin/env bash
# Install a Build-workflow Mac artifact over /Applications/feedback.app, in place.
#
#   ./install-build.sh            latest successful Build run on mattromano/feedBack-desktop@custom
#   ./install-build.sh <run-id>   that run
#   ./install-build.sh --rollback put the previous install back
#
# Quits feedback, keeps the current app as the rollback copy, installs the new one,
# clears quarantine, and starts it again if it was running. Settings, tones and the
# library live outside the app and are untouched.
# To start a build:  gh workflow run build.yml -R mattromano/feedBack-desktop --ref custom
#   (Mac only by default; add -f platforms=all for Windows + Linux too).
# For core / plugin changes alone, ./dev-sync.sh is faster: no build.
set -euo pipefail
REPO=mattromano/feedBack-desktop
APP="${FB_APP:-/Applications/feedback.app}"
CACHE="$HOME/.cache/feedback-builds"
PREV="$CACHE/previous.app"
mkdir -p "$CACHE"

quit_app() {
  local pid; pid=$(pgrep -f "$APP/Contents/MacOS/feedback( |$)" | head -1 || true)
  [ -n "$pid" ] || return 1
  echo "Quitting feedback..."
  kill -TERM "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
  echo "feedback didn't quit; quit it and run again" >&2; exit 1
}
swap_in() {  # swap_in <new .app>: current -> previous, new -> APP
  rm -rf "${PREV:?}"
  [ -d "$APP" ] && mv "$APP" "$PREV"
  if ! ditto "$1" "$APP"; then
    echo "Install failed; restoring the previous app" >&2
    rm -rf "${APP:?}"; [ -d "$PREV" ] && mv "$PREV" "$APP"; exit 1
  fi
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
}

if [ "${1:-}" = "--rollback" ]; then
  [ -d "$PREV" ] || { echo "No previous install kept" >&2; exit 1; }
  was=0; quit_app && was=1
  tmp="$CACHE/rollback-swap.app"; rm -rf "${tmp:?}"; mv "$PREV" "$tmp"
  swap_in "$tmp"; rm -rf "${tmp:?}"
  echo "Rolled back."; [ "$was" -eq 1 ] && open -a "$APP"; exit 0
fi

run="${1:-}"
if [ -z "$run" ]; then
  run=$(gh run list -R "$REPO" --workflow build.yml --branch custom --status success --limit 20 \
        --json databaseId -q '.[].databaseId' | while read -r id; do
          gh api "repos/$REPO/actions/runs/$id/artifacts" -q '.artifacts[] | select(.name=="slopsmith-mac-arm64" and (.expired|not)) | .name' \
            | grep -q . && { echo "$id"; break; }
        done)
  [ -n "$run" ] || { echo "No successful build with a Mac artifact found" >&2; exit 1; }
fi
echo "Build run $run ($(gh run view "$run" -R "$REPO" --json headSha,createdAt -q '.headSha[0:7]+", "+.createdAt'))"

dir="$CACHE/$run"
if [ ! -d "$dir/app/feedback.app" ]; then
  rm -rf "${dir:?}"; mkdir -p "$dir"
  echo "Downloading..."
  gh run download "$run" -R "$REPO" -n slopsmith-mac-arm64 -D "$dir"
  mkdir -p "$dir/app"; ditto -x -k "$dir/release/feedback-macos-arm64.zip" "$dir/app"
  rm -rf "${dir:?}/release"
fi
new="$dir/app/feedback.app"
[ -f "$new/Contents/Resources/slopsmith/server.py" ] || { echo "Artifact has no feedback.app" >&2; exit 1; }

was=0; quit_app && was=1
swap_in "$new"
# Keep only this download (the rollback copy is the previous app itself).
find "$CACHE" -mindepth 1 -maxdepth 1 -type d ! -name "$run" ! -name previous.app -exec rm -rf {} +
drums=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$APP/Contents/Resources/slopsmith/plugins/drums/plugin.json" 2>/dev/null || echo '?')
echo "Installed run $run (drums $drums). Previous app kept for ./install-build.sh --rollback"
[ "$was" -eq 1 ] && open -a "$APP"
echo "Local changes not in this build? Run ./dev-sync.sh next."

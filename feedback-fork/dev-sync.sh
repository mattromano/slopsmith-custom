#!/usr/bin/env bash
# Copy core + plugin checkouts straight into the installed app: no build, no reinstall.
#
#   ./dev-sync.sh               sync, then restart feedback if it was running
#   ./dev-sync.sh --dry-run     list what would change
#   ./dev-sync.sh --no-restart  sync only
#
# The packaged app runs core and plugins from plain files in
# feedback.app/Contents/Resources/slopsmith, so for core / plugin changes (JS, Python,
# HTML) this replaces a full build. It copies the WORKING TREES in
# ~/Desktop/repos/feedback-upstream: the core fork (feedBack) and every plugin linked in
# dev-plugins/, matched to the bundled plugin folder by plugin.json id. Plugins the
# bundle doesn't already have are skipped (they need a build).
# Not covered (run a build, then install-build.sh): desktop / Electron / native audio
# changes, new Python dependencies, and new Tailwind classes (the build regenerates
# tailwind.min.css over every plugin; this keeps the installed one).
# Env: FB_ROOT (checkouts), FB_APP (default /Applications/feedback.app).
set -euo pipefail
ROOT="${FB_ROOT:-$HOME/Desktop/repos/feedback-upstream}"
APP="${FB_APP:-/Applications/feedback.app}"
RES="$APP/Contents/Resources/slopsmith"
CORE="$ROOT/feedBack"
DRY=() RESTART=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=(-n); RESTART=0 ;;
    --no-restart) RESTART=0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
[ -f "$RES/server.py" ] || { echo "No feedback app at $APP" >&2; exit 1; }
[ -f "$CORE/server.py" ] || { echo "No core checkout at $CORE (run ./setup.sh)" >&2; exit 1; }

state() { echo "$(git -C "$1" branch --show-current)@$(git -C "$1" rev-parse --short HEAD)$( [ -n "$(git -C "$1" status --porcelain)" ] && echo ' +uncommitted')"; }
sync() {  # sync <src dir> <dst dir> [extra rsync args]
  local src="$1" dst="$2"; shift 2
  local out; out=$(rsync -a --checksum --delete ${DRY[@]+"${DRY[@]}"} --itemize-changes --exclude .git --exclude __pycache__ --exclude .pytest_cache --exclude node_modules "$@" "$src/" "$dst/")
  local n; n=$(printf '%s' "$out" | grep -c '^[<>c*]' || true)
  [ "$n" -gt 0 ] && echo "  $(basename "$dst"): $n file(s)$( [ ${#DRY[@]} -gt 0 ] && echo ' would change')" || true
}

pid=$(pgrep -f "$APP/Contents/MacOS/feedback( |$)" | head -1 || true)
if [ -n "$pid" ] && [ ${#DRY[@]} -eq 0 ]; then
  echo "Quitting feedback..."
  kill -TERM "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && { echo "feedback didn't quit; quit it and run again" >&2; exit 1; }
else
  RESTART=0   # wasn't running (or dry run): leave it as it is
fi

echo "core $(state "$CORE")"
# Same layout as scripts/bundle-slopsmith.sh in the desktop fork.
for f in "$CORE"/*.py "$CORE/VERSION"; do
  [ ${#DRY[@]} -gt 0 ] || cp -p "$f" "$RES/"
done
for d in lib static data; do
  [ -d "$CORE/$d" ] && sync "$CORE/$d" "$RES/$d" --exclude art --exclude sloppak_cache --exclude 'audio_*.mp3' \
    --exclude tailwind.min.css --exclude _tailwind.src.css   # the build regenerates Tailwind over all plugins
done
for pkg in "$CORE"/*/__init__.py; do
  d=$(basename "$(dirname "$pkg")"); case "$d" in plugins|tests|lib) continue ;; esac
  sync "$CORE/$d" "$RES/$d"
done

# Plugins: core's in-tree ones plus the linked forks, matched by plugin.json id.
# id<TAB>folder for every bundled plugin, read once.
IDMAP=$(python3 - "$RES/plugins" <<'PY'
import json, os, sys
for d in sorted(os.listdir(sys.argv[1])):
    try: print(json.load(open(os.path.join(sys.argv[1], d, "plugin.json"))).get("id", "") + "\t" + d)
    except Exception: pass
PY
)
bundle_dir_for() {  # id -> bundled plugin folder, or empty
  local d; d=$(printf '%s\n' "$IDMAP" | awk -F'\t' -v id="$1" '$1 == id { print $2; exit }')
  [ -n "$d" ] && echo "$RES/plugins/$d" || true
}
for src in "$CORE"/plugins/*/ "$ROOT"/dev-plugins/*; do
  src="${src%/}"; [ -f "$src/plugin.json" ] || continue
  [ -L "$src" ] && src="$(cd "$src" && pwd -P)"
  id=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("id",""))' "$src/plugin.json")
  dst=$(bundle_dir_for "$id")
  if [ -z "$dst" ]; then echo "  skip $id (not in this build)"; continue; fi
  [ "$src" = "$CORE/plugins/$(basename "$src")" ] || echo "plugin $id $(state "$src")"
  # career's club / arena venue packs download on demand; the build leaves them out.
  sync "$src" "$dst" --exclude /venue-packs/club --exclude /venue-packs/arena
done

if [ "$RESTART" -eq 1 ]; then echo "Starting feedback..."; open -a "$APP"; fi
echo "Done.$( [ ${#DRY[@]} -gt 0 ] && echo ' (dry run, nothing changed)')"

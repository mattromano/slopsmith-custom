#!/usr/bin/env bash
# Clone (or update) every mattromano feedBack fork, check out our build branch,
# and link the plugin checkouts into one dev plugins folder. Safe to re-run.
#   ./setup.sh                 -> ~/Desktop/repos/feedback-upstream
# Env: FB_ROOT (clone folder)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${FB_ROOT:-$HOME/Desktop/repos/feedback-upstream}"
mkdir -p "$ROOT/dev-plugins"
grep -v '^#' "$HERE/repos.txt" | while read -r repo up branch plugin; do
  [ -n "$repo" ] || continue
  dir="$ROOT/$repo"
  if [ ! -d "$dir/.git" ]; then
    extra=(); [ "$repo" = feedBack-desktop ] && extra=(--filter=blob:none)  # vendors JUCE
    git clone -q "${extra[@]}" "https://github.com/mattromano/$repo.git" "$dir"
  fi
  git -C "$dir" config user.name mattromano
  git -C "$dir" config user.email 42412983+mattromano@users.noreply.github.com
  if [ "$up" != "-" ]; then
    git -C "$dir" remote get-url upstream >/dev/null 2>&1 || git -C "$dir" remote add upstream "https://github.com/$up.git"
    git -C "$dir" fetch -q upstream
  fi
  # Every PR branch adds a CHANGELOG entry; keep both sides when merging them.
  grep -qs 'CHANGELOG.md merge=union' "$dir/.git/info/attributes" || echo 'CHANGELOG.md merge=union' >> "$dir/.git/info/attributes"
  git -C "$dir" fetch -q origin
  if git -C "$dir" diff --quiet && git -C "$dir" diff --cached --quiet; then
    git -C "$dir" checkout -q -B "$branch" "origin/$branch" 2>/dev/null \
      || git -C "$dir" checkout -q "$branch"
    git -C "$dir" branch -q --set-upstream-to="origin/$branch" "$branch"
  else
    echo "  $repo has uncommitted changes, left on $(git -C "$dir" branch --show-current)"
  fi
  [ "$plugin" != "-" ] && ln -sfn "$dir" "$ROOT/dev-plugins/$plugin"
  echo "$repo: $(git -C "$dir" log -1 --format='%h %s' | cut -c1-70)"
done
if [ ! -x "$ROOT/feedBack/.venv/bin/python" ]; then
  uv venv -q --python 3.12 "$ROOT/feedBack/.venv"
fi
uv pip install -q --python "$ROOT/feedBack/.venv/bin/python" -r "$ROOT/feedBack/requirements.txt" \
  -r "$ROOT/feedBack-plugin-multiplayer/requirements.txt"
echo "Done. Run: $HERE/run-dev.sh"

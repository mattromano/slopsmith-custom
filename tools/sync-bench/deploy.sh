# usage: deploy.sh <dest-plugins-dir> plugin...
D="$1"; shift
R=/c/Users/mattr/Desktop/repos/slopsmith-custom/plugins
for p in "$@"; do
  for f in $(cd $R/$p && git ls-files | grep -v -E '^(tests|tools|docs|\.claude|\.github|\.specify)/'); do
    mkdir -p "$D/$p/$(dirname $f)"; cp "$R/$p/$f" "$D/$p/$f"
  done
  # also untracked new files at top level
  for f in $(cd $R/$p && git ls-files --others --exclude-standard | grep -v -E '^(tests|tools|docs)/'); do mkdir -p "$D/$p/$(dirname $f)"; cp "$R/$p/$f" "$D/$p/$f"; done
  echo "deployed $p"
done

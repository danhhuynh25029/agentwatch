#!/bin/sh
# Regenerates media/screenshots/*.png and media/demo.gif from fictional demo data.
# Needs: a compiled out/ (npm run compile), Google Chrome, python3 with Pillow.
# Usage: sh tools/demo/build.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
node "$ROOT/tools/demo/gen.js" "$WORK/projects"
node "$ROOT/tools/demo/render.js" "$ROOT/out" "$WORK/projects" "$WORK/html"

# shot <html name> <css width,height> <png path> <scale>
shot() {
  rm -rf "$WORK/profile"
  "$CHROME" --headless=new --user-data-dir="$WORK/profile" --disable-gpu --hide-scrollbars \
    --force-device-scale-factor="$4" --window-size="$2" --screenshot="$3" "file://$WORK/html/$1.html" >/dev/null 2>&1 &
  pid=$!
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
  kill "$pid" 2>/dev/null || true
}

mkdir -p "$ROOT/media/screenshots" "$WORK/tall"
shot session 1100,1400 "$ROOT/media/screenshots/session.png" 1.5
shot dashboard 1100,1400 "$ROOT/media/screenshots/dashboard.png" 1.5
shot conversation 1100,1000 "$ROOT/media/screenshots/conversation.png" 1.5
shot compare 1100,1000 "$ROOT/media/screenshots/compare.png" 1.5
for n in session conversation dashboard compare; do shot "$n" 1100,6000 "$WORK/tall/$n.png" 1; done
python3 "$ROOT/tools/demo/make_gif.py" "$WORK/tall" "$ROOT/media/demo.gif"
rm -rf "$WORK"

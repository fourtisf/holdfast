#!/usr/bin/env bash
# The launch demo (moatpad-live.mp4): a 4 s intro, a real capture of the web app launching a coin with the
# demo wallet and the coin going live (capture-demo.mjs), a 7 s outro, and a soundtrack synced to the capture.
# Needs the web app in mock mode on :3311:
#   cd apps/web && NEXT_PUBLIC_USE_MOCKS=1 NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta pnpm build && NEXT_PUBLIC_USE_MOCKS=1 pnpm start -p 3311 &
#   bash brand/video/build-demo.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
web="$here/../../apps/web"
cd "$web"
cp "$here/render.mjs" .render.mjs
cp "$here/capture-demo.mjs" .demo.mjs
trap 'rm -f .render.mjs .demo.mjs' EXIT
node .render.mjs demo-intro "$here/demo-intro.mp4"
node .demo.mjs "$here/demo-app.mp4"
node .render.mjs demo-outro "$here/demo-outro.mp4"
python3 "$here/music.py"
ffmpeg -y -loglevel error -i "$here/demo-intro.mp4" -i "$here/demo-app.mp4" -i "$here/demo-outro.mp4" -i "$here/music-demo.wav" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v];[3:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 19 -c:a aac -b:a 192k -ar 48000 -shortest -movflags +faststart "$here/moatpad-live.mp4"
rm -f "$here/demo-intro.mp4" "$here/demo-app.mp4" "$here/demo-outro.mp4"
echo "wrote $here/moatpad-live.mp4"

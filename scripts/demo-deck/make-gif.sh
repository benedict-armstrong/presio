#!/usr/bin/env bash
# Rasterise sync.typ (one page per frame) and stitch the frames into
# demo-sync.gif, the animated figure the demo deck embeds.
#
# Usage: scripts/demo-deck/make-gif.sh
# Needs: typst, ImageMagick (magick).
set -euo pipefail

cd "$(dirname "$0")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 72 ppi keeps 1pt = 1px, so the page size in sync.typ is the GIF's pixel size.
typst compile --format png --ppi 72 sync.typ "$TMP/frame-{0p}.png"

# 7 = 70ms a frame, so the four slides take about 2.2s to cycle.
magick -delay 7 -loop 0 "$TMP"/frame-*.png -layers optimize demo-sync.gif

echo "demo-sync.gif  $(du -h demo-sync.gif | cut -f1)  $(magick identify demo-sync.gif | wc -l | tr -d ' ') frames"

#!/bin/sh
# Regenerates build/icon.png and build/icons/<N>x<N>.png from the SVG sources.
# 16, 24 and 32 px come from build/icon-small.svg (frame + central star only);
# every other size comes from build/icon.svg (the full logo). Needs ImageMagick
# with the librsvg delegate (`magick`). Run from the repository root.
set -eu
cd "$(dirname "$0")/.."
render() { # source size output
  magick -background none -density 1200 "$1" -resize "${2}x${2}" -define png:exclude-chunk=all "$3"
}
mkdir -p build/icons
render build/icon.svg 1024 build/icon.png
for size in 16 24 32; do render build/icon-small.svg "$size" "build/icons/${size}x${size}.png"; done
for size in 48 64 96 128 192 256 512 1024; do render build/icon.svg "$size" "build/icons/${size}x${size}.png"; done

# Explicit Windows and macOS icons. electron-builder would otherwise derive them from
# build/icon.png and downscale the FULL logo to 16-32 px, so the small variant would
# never reach the taskbar or the Finder list; package.json points win.icon / mac.icon here.
magick build/icons/16x16.png build/icons/24x24.png build/icons/32x32.png build/icons/48x48.png \
  build/icons/64x64.png build/icons/128x128.png build/icons/256x256.png build/icon.ico
node scripts/build-icns.mjs

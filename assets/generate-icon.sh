#!/bin/bash
# generate-icon.sh
# Regenerates icon.icns + icon-dock.png from logo.png — a macOS-style icon:
# dark rounded-square (squircle) background with the logo centered + padding.
# Requires: macOS (iconutil) + ImageMagick (brew install imagemagick).

set -e

A="$(cd "$(dirname "$0")" && pwd)"
ICONSET="$A/icon.iconset"
LOGO="$A/logo.png"
MASTER="$A/icon-master.png"

command -v magick >/dev/null || { echo "Install ImageMagick: brew install imagemagick"; exit 1; }

echo "Generating icon from logo.png…"

# macOS icons must NOT fill the full canvas — Apple's grid puts the rounded
# square at ~824/1024 (≈80%) with transparent padding, so the icon renders at
# the same visual size as every other app in the Dock. Filling the full 1024
# makes the icon look oversized. Corner radius follows the continuous-curvature
# ratio (~0.225 of the square's side → 824 * 0.225 ≈ 185).
# Square region: 824×824 centered on the 1024 canvas (100px padding each side).

# 1) Transparent canvas with a dark rounded-square (subtle gradient) inset
magick -size 824x824 gradient:"#27272b"-"#141416" "$A/_grad.png"
magick "$A/_grad.png" \
  \( -size 824x824 xc:none -fill white -draw "roundrectangle 0,0,823,823,185,185" \) \
  -alpha set -compose DstIn -composite "$A/_sq.png"
magick -size 1024x1024 xc:none "$A/_sq.png" -gravity center -compose over -composite "$A/_bg.png"
# 2) Composite the logo centered inside the squircle (~59% of the square ≈ 486px)
magick "$A/_bg.png" \( "$LOGO" -resize 486x486 \) -gravity center -compose over -composite "$MASTER"
rm -f "$A/_grad.png" "$A/_sq.png" "$A/_bg.png"

# 3) Build the iconset and pack into .icns
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
declare -a S=("16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
  "128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" \
  "512:512x512" "1024:512x512@2x")
for e in "${S[@]}"; do
  magick "$MASTER" -resize "${e%%:*}x${e%%:*}" "$ICONSET/icon_${e##*:}.png"
done
iconutil -c icns "$ICONSET" -o "$A/icon.icns"

# 4) Dock icon PNG (used at runtime)
magick "$MASTER" -resize 512x512 "$A/icon-dock.png"

rm -f "$MASTER"; rm -rf "$ICONSET"
echo "Created: $A/icon.icns and $A/icon-dock.png"

#!/bin/sh
# Optionales Autorenwerkzeug: Node 24, installierte Projektabhängigkeiten, ImageMagick 6, DejaVu Sans. Kein Build-Schritt, keine Netzabrufe.
set -eu
cd "$(dirname "$0")/../apps/web/public"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node -e 'require("sharp")("marke/zeichen.svg", {density:1440}).resize(512,512).png().toFile(process.argv[1]).catch(e=>{console.error(e);process.exitCode=1})' "$tmp/zeichen.png"
convert "$tmp/zeichen.png" -background '#f5f7f2' -alpha remove -alpha off -define icon:auto-resize=48,32,16 favicon.ico
for size in 180 192 512; do
  edge=$((size * 3 / 4))
  convert "$tmp/zeichen.png" -resize "${edge}x${edge}" -gravity center -background '#f5f7f2' -extent "${size}x${size}" -alpha remove -alpha off -strip "marke/app-$size.png"
done
convert -size 1200x630 xc:'#f5f7f2' \( "$tmp/zeichen.png" -resize 228x228 \) -geometry +108+201 -composite \
  -fill '#173d38' -font "${DEJAVU_DIR:-/usr/share/fonts/truetype/dejavu}/DejaVuSans-Bold.ttf" -pointsize 114 -annotate +394+326 'trainerb' \
  -font "${DEJAVU_DIR:-/usr/share/fonts/truetype/dejavu}/DejaVuSans.ttf" -pointsize 40 -annotate +402+397 'A K A D E M I E' -depth 8 -strip marke/vorschaubild.png

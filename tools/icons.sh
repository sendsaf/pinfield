#!/usr/bin/env bash
# Renders the icon in every size the stores and browsers ask for. Needs rsvg-convert (librsvg).
# Two looks: icons/logo (Pinterest's mark in the centre) and icons/pin (a pushpin, no third-party logo).
set -euo pipefail
cd "$(dirname "$0")/.."
for v in logo pin; do
  mkdir -p "icons/$v"
  node tools/icon.js "$v" "icons/$v/icon.svg"
  node tools/icon.js "$v" "icons/$v/icon-small.svg" small
  for n in 48 128; do rsvg-convert -w "$n" -h "$n" "icons/$v/icon.svg" -o "icons/$v/icon-$n.png"; done
  # at 16 and 32 a honeycomb is mush: those sizes show the centre card alone
  for n in 16 32; do rsvg-convert -w "$n" -h "$n" "icons/$v/icon-small.svg" -o "icons/$v/icon-$n.png"; done
done
echo "Icons rendered into icons/logo and icons/pin"

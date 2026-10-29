#!/usr/bin/env bash
# Packs the extension.
#   dist/pinfield-<version>.zip        Pinterest's mark in the icon: for your own browsers
#   dist/pinfield-<version>-store.zip  pushpin icon, no third-party logo: for the Chrome Web Store and Firefox Add-ons
# Flatpak browsers (Zen, Firefox from Flathub) can only see the single file you pick, so load the zip
# there instead of manifest.json. The zip is also what you upload to both stores.
set -euo pipefail
cd "$(dirname "$0")"
[ -f icons/logo/icon-128.png ] || tools/icons.sh
mkdir -p dist
python3 - <<'PY'
import json, pathlib, shutil, zipfile
version = json.load(open("manifest.json"))["version"]
# the icons manifest.json points at (icons/icon-N.png) are the logo set, so loading the folder unpacked works too
for n in (16, 32, 48, 128):
    shutil.copyfile(f"icons/logo/icon-{n}.png", f"icons/icon-{n}.png")
for variant, name in (("logo", f"pinfield-{version}.zip"), ("pin", f"pinfield-{version}-store.zip")):
    out = pathlib.Path("dist") / name
    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write("manifest.json")
        for p in sorted(pathlib.Path("src").glob("*.js")):
            z.write(p)
        for p in sorted(pathlib.Path("popup").iterdir()):
            z.write(p)
        for n in (16, 32, 48, 128):
            z.write(f"icons/{variant}/icon-{n}.png", f"icons/icon-{n}.png")
    print("built", out)
shutil.copyfile(f"dist/pinfield-{version}.zip", "dist/pinfield.zip")
PY
dest="${XDG_DOWNLOAD_DIR:-$HOME/Downloads}"
cp dist/pinfield.zip "$dest/pinfield.zip"
echo "Copied the logo build to $dest/pinfield.zip"

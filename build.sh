#!/usr/bin/env bash
# Packs the extension.
#   dist/pinfield-<version>.zip                Chrome, Pinterest's mark in the icon: for your own browsers
#   dist/pinfield-<version>-store.zip          Chrome, pushpin icon, no third-party logo: for the Chrome Web Store
#   dist/pinfield-<version>-firefox.zip        Firefox / Zen, Pinterest's mark: for your own browsers
#   dist/pinfield-<version>-firefox-store.zip  Firefox, pushpin icon: for Firefox Add-ons
# The two browsers want the background script declared differently: Chrome runs it as a service worker and
# warns about "background.scripts"; Firefox only runs "background.scripts". manifest.json is the Chrome one,
# so the folder loads cleanly unpacked in Chrome; the Firefox zips get the Firefox form.
# Flatpak browsers (Zen, Firefox from Flathub) can only see the single file you pick, so load the zip
# there instead of manifest.json.
set -euo pipefail
cd "$(dirname "$0")"
[ -f icons/logo/icon-128.png ] || tools/icons.sh
mkdir -p dist
python3 - <<'PY'
import json, pathlib, shutil, zipfile
manifest = json.load(open("manifest.json"))
version = manifest["version"]
firefox = dict(manifest, background={"scripts": [manifest["background"]["service_worker"]]})
# the icons manifest.json points at (icons/icon-N.png) are the logo set, so loading the folder unpacked works too
for n in (16, 32, 48, 128):
    shutil.copyfile(f"icons/logo/icon-{n}.png", f"icons/icon-{n}.png")
builds = (
    ("logo", manifest, f"pinfield-{version}.zip"),
    ("pin", manifest, f"pinfield-{version}-store.zip"),
    ("logo", firefox, f"pinfield-{version}-firefox.zip"),
    ("pin", firefox, f"pinfield-{version}-firefox-store.zip"),
)
for variant, man, name in builds:
    out = pathlib.Path("dist") / name
    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(man, indent=2, ensure_ascii=False) + "\n")
        for p in sorted(pathlib.Path("src").glob("*.js")):
            z.write(p)
        for p in sorted(pathlib.Path("popup").iterdir()):
            z.write(p)
        for n in (16, 32, 48, 128):
            z.write(f"icons/{variant}/icon-{n}.png", f"icons/icon-{n}.png")
    print("built", out)
# ~/Downloads/pinfield.zip is what Zen (a Flatpak Firefox) loads
shutil.copyfile(f"dist/pinfield-{version}-firefox.zip", "dist/pinfield.zip")
PY
dest="${XDG_DOWNLOAD_DIR:-$HOME/Downloads}"
cp dist/pinfield.zip "$dest/pinfield.zip"
echo "Copied the Firefox logo build to $dest/pinfield.zip"

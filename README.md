# Pinfield

Turns Pinterest's feed into an endless field of pins you can drag, fling and zoom. Pins only, no text. It
uses the pins Pinterest already sends you, and asks Pinterest for the next page of the feed you're on with
Pinterest's own request, so its hidden page doesn't have to render it. Save, unsave, boards and download
use Pinterest's own endpoints, only when you press them. Nothing goes anywhere but Pinterest
(see PRIVACY.md).

Shipping it: see RELEASE.md. Store listing text and images: `store/`.

## Load it for development

- Chrome / Edge / Brave: `chrome://extensions` → Developer mode → Load unpacked → pick this folder.
- Firefox (140+): `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest.json`.
- Zen, or any Flatpak browser: run `./build.sh`, then Load Temporary Add-on → pick `~/Downloads/pinfield.zip`.
  A Flatpak browser only sees the one file you pick, so `manifest.json` alone loads without its scripts.
  Re-run `./build.sh` and press Reload after every change.

## Use it

- Drag, flick, scroll or use the arrow keys to move. Ctrl + scroll, pinch or +/- to zoom (0 resets).
- Hover a pin: Save (to your last board, press again to remove), board picker, visit site, copy link, and
  ⋯ for More like this, Download and Hide.
- Select (top right): click pins to pick them (a drag still pans), then Download saves them all at full
  size into `Downloads/Pinfield/<board or search> <date time>/`, numbered in the order you picked them.
  Video pins save their cover picture. Esc or Cancel leaves select mode.
- Click a pin: it takes a three-column slot in the middle of the grid, its buttons in a rail beside it, and
  Pinterest's related pins fill in around it. Enlarge from its corner; Esc or ✕ goes back to where you were.
- Video pins play muted when the field is still, a few at a time.
- Search: Pinterest's suggestions as you type; on an empty box, refinements for the current search plus
  recent searches. Arrow keys and Enter work; it searches in-app without reloading.
- Bottom bar: back, home, explore (Pinterest's Explore: interests, trending, featured boards, what's new),
  search, your account (profile and boards). Top right: create, look and speed, normal Pinterest
  (Alt+Shift+F switches back).
- Look and speed: background colour, and Motion: Auto (adjusts to your computer), Smooth (lightest) or Sharp.

## Files

- `src/hook.js`: runs in the page; reads Pinterest's responses, loads next pages, and sends save/unsave/download when you ask.
- `src/extract.js`: pulls pins (images, video, link) out of any Pinterest JSON.
- `src/layout.js`: the endless world, worked out from column and row numbers; an open pin is a block the grid flows around.
- `src/field.js`: the renderer: motion first, everything else waits until the field is still.
- `src/main.js`: routes, bars, quick actions, the open pin, explore, boards, select mode.
- `src/background.js`: saves selected pins into one folder with the browser's downloads API (the only use of the `downloads` permission).
- `tools/icon.js`, `tools/icons.sh`: draw and render the icon. `tools/shots.js`: store screenshots.

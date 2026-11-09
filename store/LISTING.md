# Store listing (copy and paste)

Upload `dist/pinfield-<version>-store.zip` to the Chrome Web Store and `dist/pinfield-<version>-firefox-store.zip`
to Firefox Add-ons. The store build uses the pushpin icon:
see "Why the store build has no Pinterest logo" at the bottom.

## Name
Pinfield

## Summary (Chrome: 132 characters max; Firefox: 250)
See Pinterest as an endless, pannable field of pins. Only changes how pins look on your screen.

## Description
Pinfield turns your Pinterest into one endless field of pins you can drag, fling and zoom, instead of a
long scroll.

- Pan in any direction. Your best pins sit in the middle and the rest spread out around them.
- Zoom out to see hundreds of pins at once, or in to see one closely.
- Open a pin and it takes centre stage in the grid, with Pinterest's related pins laid out around it.
- Save, save to a board, unsave, copy link, download and visit, right from the pin.
- Select: pick any number of pins, then save them all to one board or download them all, full size, into one folder.
- Search with Pinterest's own suggestions, browse Explore, and see your boards.
- Light Pinterest look with any background colour you like, and a Smooth mode for slower computers.

Pinfield only changes how Pinterest looks in your browser. It collects nothing and has no servers: it uses
the pins Pinterest already sends you, with your own Pinterest session.

Press Alt+Shift+F, or the Pinterest button in the top-right corner, to switch back to normal Pinterest at any time.

Pinfield is an independent project and is not affiliated with, endorsed by or sponsored by Pinterest.

## Category
- Chrome Web Store: Productivity > Tools (or Lifestyle > Art & Design)
- Firefox Add-ons: Photos, Music & Videos (or Appearance)

## Chrome Web Store "Privacy practices" tab

**Single purpose:** Shows Pinterest's pins as an endless, pannable and zoomable field instead of a
scrolling feed.

**Host permission justification (pinterest.com and Pinterest's country sites):** Pinfield runs only on
Pinterest. It needs these sites to draw its view over Pinterest's page and to read the pins Pinterest's
page already loads. It does not run anywhere else.

**downloads permission justification:** "Select" lets the user pick several pins and press Download to
save their pictures into one folder (Downloads/Pinfield/<board or search> <date>/). The downloads API is
the only way an extension can save several files into a named folder. It is called only when the user
presses Download, only for the selected pins' images on i.pinimg.com, and Pinfield never reads the
download history.

**Remote code:** No, I am not using remote code. All code ships in the package.

**Data usage:** tick none of the data types. Pinfield does not collect or transmit user data. Then tick all
three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** a public link to PRIVACY.md (see RELEASE.md, step 2).

## Firefox Add-ons notes for the reviewer
Pinfield replaces Pinterest's feed with its own view. It reads the pin data from Pinterest's own
responses (src/hook.js, page context) and asks Pinterest for the next page of the feed you are on with
Pinterest's own request. Save, unsave and board actions use Pinterest's own endpoints with the user's
session, only when the user presses those buttons. The downloads permission is used by src/background.js
only when the user selects pins and presses Download: it saves those images (i.pinimg.com URLs only) into
Downloads/Pinfield/<folder>/. Every value put into HTML is escaped (esc / cssUrl in
src/main.js). No remote code, no minified or generated code, no build step: the source in the zip is the
source. (The packing script only writes manifest.json's background key as "scripts" for Firefox, where
the Chrome copy says "service_worker".)

## Why the store build has no Pinterest logo
Pinterest's brand guidelines don't let third-party apps use the Pinterest logo as their icon, and both
stores take down extensions whose icon or name suggests they come from another company (Chrome Web Store
"impersonation", Mozilla's add-on policies on trademarks). The store build therefore uses the same
honeycomb with a red pushpin in the middle. The logo build (`dist/pinfield-<version>.zip`) is for your own
browsers.

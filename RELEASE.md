# Releasing Pinfield

Everything here is one-time setup, then the same three commands for each new version.

## 0. Before every release

1. Raise `version` in `manifest.json` (stores refuse a number they've already seen): `1.0.0` -> `1.0.1`.
2. Run `./build.sh`. It writes:
   - `dist/pinfield-<version>-store.zip`: upload this one to the stores
   - `dist/pinfield-<version>.zip`: same extension with the Pinterest-logo icon, for your own browsers
3. Optional check: `npx web-ext lint --source-dir . --ignore-files "dist/**" "tools/**" "icons/logo/**" "icons/pin/**" "*.md" "build.sh"`
   should report 0 errors. The innerHTML warnings are expected (every value is escaped).

Icons are drawn by `tools/icon.js`; re-render them with `tools/icons.sh`. Store screenshots come from
`node tools/shots.js store/screenshots` (needs Playwright's Chromium).

## 1. Accounts (once)

- **Chrome Web Store:** sign in at https://chrome.google.com/webstore/devconsole with a Google account,
  pay the one-time $5 registration fee and verify your email. Also covers Microsoft Edge if you later
  upload the same zip at https://partner.microsoft.com/dashboard/microsoftedge (free).
- **Firefox Add-ons (AMO):** sign in at https://addons.mozilla.org/developers/ with a Mozilla account. Free.

## 2. Privacy policy link (once)

The Chrome Web Store asks for a public URL. Any public page works:
- put PRIVACY.md on your site (for example designedbysaf.com/pinfield/privacy), or
- paste it into a public GitHub Gist and use that link.

## 3. Chrome Web Store

1. Developer console -> **New item** -> upload `dist/pinfield-<version>-store.zip`.
2. **Store listing:** copy name, summary, description and category from `store/LISTING.md`. Upload
   `store/icon-128.png`, the four `store/screenshots/*.png` (1280x800) and `store/promo-small-440x280.png`.
3. **Privacy practices:** copy the single purpose, permission justification and data answers from
   `store/LISTING.md`; paste the privacy policy URL.
4. **Distribution:** Public (or Unlisted to share by link first). Submit for review. First reviews
   usually take a few days; host permissions mean an in-depth review, so up to a few weeks.

## 4. Firefox Add-ons

1. https://addons.mozilla.org/developers/addon/submit/distribution -> **On this site** -> upload the same
   store zip.
2. It asks whether you used a build tool or minifier: answer **No** (the zip is the source).
3. Copy the listing from `store/LISTING.md`, paste the reviewer notes into "Notes for reviewers".
   Upload icon and screenshots. Submit.
4. The extension ID `pinfield@designedbysaf` in manifest.json ties future versions to this listing:
   never change it.

## 5. Updates

Raise the version, `./build.sh`, then upload the new store zip to each store (Chrome: item -> Package ->
Upload new package; Firefox: Manage -> Upload new version). Installed copies update themselves.

## Things to know

- Pinterest's page changes from time to time. When Pinfield stops finding pins, the fix is almost always
  in `src/extract.js` or `src/hook.js`.
- Pinfield is unofficial. Keep "not affiliated with Pinterest" in the listing, and keep the Pinterest logo
  out of the store icon and screenshots' marketing text, or a store or Pinterest can ask for removal.

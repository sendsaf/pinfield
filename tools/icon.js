// Draws Pinfield's icon as SVG: a honeycomb of glass cards (Apple Watch app-grid style) around one big card.
// node tools/icon.js <logo|pin> <out.svg> [small]
//   logo: Pinterest's mark in the centre card. pin: a pushpin (store-safe: no third-party logo).
//   small: the 16/32px version, centre card only (a honeycomb is mush at that size).
const fs = require("fs");
const [variant = "logo", out = "icon.svg", small] = process.argv.slice(2);

// 24-unit paths
const PINTEREST = "M12 2a10 10 0 0 0-3.64 19.31c-.09-.79-.17-2 .03-2.86l1.17-4.97s-.3-.6-.3-1.48c0-1.39.8-2.42 1.8-2.42.85 0 1.26.64 1.26 1.4 0 .85-.54 2.13-.82 3.31-.24 1 .5 1.8 1.48 1.8 1.78 0 3.14-1.87 3.14-4.57 0-2.39-1.72-4.06-4.17-4.06-2.84 0-4.5 2.13-4.5 4.33 0 .86.33 1.78.74 2.28.08.1.1.19.07.29l-.27 1.13c-.05.18-.15.22-.34.13-1.25-.58-2.03-2.41-2.03-3.88 0-3.16 2.3-6.06 6.62-6.06 3.48 0 6.18 2.48 6.18 5.79 0 3.45-2.18 6.23-5.2 6.23-1.02 0-1.97-.53-2.3-1.15l-.62 2.38c-.23.87-.84 1.96-1.25 2.63A10 10 0 1 0 12 2";
const PIN = "M17 3H7v2h1v5.4L5 13v2h6v6l1 1 1-1v-6h6v-2l-3-2.6V5h1z";

const C = 64; // centre of the 128 canvas
// card tints: all red glass, in slightly uneven shades so the ring doesn't read as one flat stamp
const TINTS = [
  ["#ff7a85", "#e2293d"], ["#ff8f98", "#e8424f"], ["#f9606c", "#cf1d31"],
  ["#ff9ba3", "#ec5662"], ["#f45562", "#c41a2d"], ["#ff858e", "#dd3444"],
  ["#ff6f7b", "#d92236"], ["#ffa3aa", "#ee5f6a"], ["#fb6672", "#d42638"],
  ["#ff929a", "#e54b57"], ["#f75b67", "#ca1c30"], ["#ff7c86", "#df2e40"],
];

let defs = "", body = "";
let gid = 0;
// one glass card: tinted fill, a soft light from the top-left, a bright rim fading toward the bottom
function card(cx, cy, s, tint, opts = {}) {
  const r = s * 0.28, x = cx - s / 2, y = cy - s / 2, id = gid++;
  const [a, b] = tint;
  defs += `
    <linearGradient id="f${id}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
    <linearGradient id="h${id}" x1="0" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".62"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".12"/></linearGradient>
    <linearGradient id="r${id}" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".5" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity=".5"/></linearGradient>`;
  const sh = opts.shadow ? `<rect x="${x}" y="${y + s * 0.07}" width="${s}" height="${s}" rx="${r}" fill="#20120c" opacity="${opts.shadow}" filter="url(#soft)"/>` : "";
  const g = `${sh}
    <rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}" fill="url(#f${id})"/>
    <rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}" fill="url(#h${id})"/>
    <rect x="${x + 0.5}" y="${y + 0.5}" width="${s - 1}" height="${s - 1}" rx="${r - 0.5}" fill="none" stroke="url(#r${id})" stroke-width="${Math.max(0.8, s * 0.035)}"/>`;
  if (!opts.blur) { body += g; return; }
  // motion blur along the line from the centre, as if the ring is flying outward (the watch grid zooming).
  // The outer group is rotated so the blur's x axis points away from the centre; the inner group rotates
  // back, so the card itself stays upright where it was.
  const ang = (Math.atan2(cy - C, cx - C) * 180) / Math.PI;
  defs += `
    <filter id="mb${id}" x="-60%" y="-20%" width="220%" height="140%"><feGaussianBlur stdDeviation="${opts.blur} 0"/></filter>`;
  body += `
    <g transform="rotate(${ang.toFixed(2)} ${C} ${C})" filter="url(#mb${id})"><g transform="rotate(${(-ang).toFixed(2)} ${C} ${C})">${g}</g></g>`;
}
// uneven blur per card so the ring doesn't move in lockstep
const JITTER = [1, 0.72, 1.18, 0.86, 1.1, 0.78];

const bgTop = "#fbf8f4", bgBot = "#ece6df";
defs += `
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgTop}"/><stop offset="1" stop-color="${bgBot}"/></linearGradient>
  <linearGradient id="bgRim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></linearGradient>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>
  <filter id="softer" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.2"/></filter>
  <clipPath id="tile"><rect x="8" y="8" width="112" height="112" rx="27"/></clipPath>`;

if (!small) {
  // honeycomb like the Apple Watch app grid: a hex grid around the centre card, cards shrinking with
  // distance (its fisheye), the tile's edge cropping the outer ring
  const D = 38, D1 = 43; // inner ring pushed out to make room for the bigger centre card
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3 + Math.PI / 6;
    // outer ring first so the inner ring's shadows fall on it
    card(C + 2 * D * Math.cos(t), C + 2 * D * Math.sin(t), 19, TINTS[(k * 2 + 6) % 12], { shadow: 0.1, blur: 2.6 * JITTER[k] });
    const tm = t + Math.PI / 6;
    card(C + Math.sqrt(3) * D * Math.cos(tm), C + Math.sqrt(3) * D * Math.sin(tm), 22, TINTS[(k * 2 + 7) % 12], { shadow: 0.1, blur: 2 * JITTER[(k + 3) % 6] });
  }
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3 + Math.PI / 6;
    card(C + D1 * Math.cos(t), C + D1 * Math.sin(t), 25, TINTS[k], { shadow: 0.16, blur: 1.1 * JITTER[(k + 1) % 6] });
  }
}

// centre card: glass over white with the mark in it
const S = small ? 92 : 56, cr = S * 0.28, x0 = C - S / 2, y0 = C - S / 2;
// a white centre stands out against the red ring; the 16/32px pin icon has no ring, so it stays a red tile
const whiteCentre = variant === "logo" || !small;
const markFill = whiteCentre ? "#e60023" : "#fff";
defs += `
  <linearGradient id="cf" x1="0" y1="0" x2="0" y2="1">${whiteCentre
    ? `<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1ece8"/>`
    : `<stop offset="0" stop-color="#ff3b4f"/><stop offset="1" stop-color="#d4001f"/>`}</linearGradient>
  <linearGradient id="ch" x1="0" y1="0" x2="0.7" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${whiteCentre ? ".5" : ".42"}"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="cr" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity=".7"/></linearGradient>`;
const m = S * 0.62, ms = m / 24, mx = C - m / 2, my = C - m / 2;
const centre = `
  <rect x="${x0}" y="${y0 + S * 0.08}" width="${S}" height="${S}" rx="${cr}" fill="#2a0a0a" opacity="${small ? 0.18 : 0.28}" filter="url(#softer)"/>
  <rect x="${x0}" y="${y0}" width="${S}" height="${S}" rx="${cr}" fill="url(#cf)"/>
  <rect x="${x0}" y="${y0}" width="${S}" height="${S}" rx="${cr}" fill="url(#ch)"/>
  <g transform="translate(${mx} ${my}) scale(${ms})"><path d="${variant === "logo" ? PINTEREST : PIN}" fill="${markFill}"/></g>
  <rect x="${x0 + 0.6}" y="${y0 + 0.6}" width="${S - 1.2}" height="${S - 1.2}" rx="${cr - 0.6}" fill="none" stroke="url(#cr)" stroke-width="${small ? 2.4 : 1.4}"/>`;

const svg = small
  ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs>${defs}</defs>${centre}</svg>`
  : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs>${defs}</defs>
  <rect x="8" y="10" width="112" height="112" rx="27" fill="#3a2a20" opacity=".18" filter="url(#softer)"/>
  <rect x="8" y="8" width="112" height="112" rx="27" fill="url(#bg)"/>
  <g clip-path="url(#tile)">${body}${centre}</g>
  <rect x="8.6" y="8.6" width="110.8" height="110.8" rx="26.4" fill="none" stroke="url(#bgRim)" stroke-width="1.2"/>
</svg>`;
fs.writeFileSync(out, svg);
console.log("wrote", out);

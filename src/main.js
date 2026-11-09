// Glue: collects pins, keeps one world per Pinterest route, and draws the overlay UI (dock, quick actions, pin view).
(function () {
  "use strict";
  if (window.__pfMain) return;
  window.__pfMain = 1;
  const { World } = globalThis.__pfLayout;
  const { Field } = globalThis.__pfField;
  const X = globalThis.__pfExtract;

  const LS = { on: "pinfield:on", seed: "pinfield:seed", bg: "pinfield:bg", q: "pinfield:q", hidden: "pinfield:hidden", board: "pinfield:board" };
  const BOOT_MIN = 40, BOOT_WAIT = 2500;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const lsJson = (k, d) => { try { return JSON.parse(lsGet(k, "null")) ?? d; } catch { return d; } };

  // ---------- account (read from the page Pinterest already sent) ----------
  const account = (() => {
    try {
      const j = JSON.parse(document.getElementById("__PWS_DATA__").textContent);
      const c = j.context || (j.props && j.props.context) || {};
      const u = c.user || {};
      return { signedIn: !!c.is_authenticated, username: typeof u.username === "string" ? u.username : null };
    } catch { return { signedIn: false, username: null }; }
  })();
  const canSave = () => account.signedIn;

  // ---------- state ----------
  // One key per Pinterest page: the path, plus the query for searches (other query params don't change the feed)
  function norm(u) {
    let x;
    try { x = new URL(u, location.origin); } catch { return null; }
    let p = x.pathname.replace(/\/+$/, "") + "/";
    if (p.startsWith("/search/")) return p + "?q=" + (x.searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ");
    return p;
  }
  const routeKey = () => norm(location.href);
  // which page a response belongs to: Pinterest names it in source_url; else the page the request was made from
  function routeOf(req, at) {
    try {
      const src = new URL(req, location.origin).searchParams.get("source_url");
      if (src) return norm(src);
    } catch {}
    return at ? norm(at) : cur;
  }
  const sigOf = (p) => { const u = p.src && (p.src.s || p.src.m); return u ? u.split("/").slice(-4).join("/") : p.id; };
  const pinIdOf = (path) => (path.match(/^\/pin\/(\d+)/) || [])[1] || null;
  const routes = new Map();
  const route = (k) => {
    let r = routes.get(k);
    if (!r) routes.set(k, (r = { pins: [], ids: new Set(), sigs: new Set(), world: null, camera: null, guides: null }));
    return r;
  };
  let cur = routeKey();
  let lastFeed = null;
  const seen = new Map();
  const hidden = new Set(lsJson(LS.hidden, []));
  // pins you saved here: pin id -> { id of the copy saving made, board name }, so a second press can undo it
  const LS_SAVED = "pinfield:saved";
  const savedMap = new Map(Object.entries(lsJson(LS_SAVED, {})).filter(([, v]) => v && typeof v.id === "string"));
  const saved = { has: (id) => savedMap.has(id) };
  const keepSaved = () => lsSet(LS_SAVED, JSON.stringify(Object.fromEntries([...savedMap].slice(-500))));

  const salt = (() => {
    let s;
    const v = lsJson(LS.seed, null);
    if (v && Date.now() - v.t < 864e5) s = v.s;
    if (!s) { s = Math.random().toString(36).slice(2, 10); lsSet(LS.seed, JSON.stringify({ s, t: Date.now() })); }
    let h = 0;
    for (const ch of s) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    return h >>> 0;
  })();
  const hashStr = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; return h; };

  function ingest(pins, key = cur) {
    const r = route(key);
    const fresh = [];
    for (const p of pins) {
      const old = seen.get(p.id);
      if (old) { if (!old.video && p.video) old.video = p.video; if (!old.link && p.link) old.link = p.link; }
      else seen.set(p.id, p);
      // the same picture is often saved as several pins: show it once
      const sig = sigOf(p);
      if (hidden.has(p.id) || r.ids.has(p.id) || r.sigs.has(sig)) continue;
      r.ids.add(p.id);
      r.sigs.add(sig);
      r.pins.push(old || p);
      fresh.push(old || p);
    }
    if (boxPin && pins.some((p) => p.id === boxPin.id)) renderBoxActions();
    if (!fresh.length) return;
    if (host && key === cur) host.dataset.pins = r.pins.length;
    if (r.world) {
      r.world.add(fresh);
      if (key === cur && field) field.refresh();
    }
    if (key === cur) maybeBoot();
  }

  const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 800 }) : setTimeout(fn, 50));
  for (const id of ["__PWS_INITIAL_PROPS__", "__PWS_DATA__"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const text = el.textContent;
    if (text.indexOf('"images"') < 0) continue;
    idle(() => {
      try {
        const json = JSON.parse(text);
        ingest(X.collect(json, [], new Set()));
        if (text.indexOf('"rankedGuides"') >= 0) setGuides(X.guidesFrom(json));
      } catch {}
    });
  }
  // Pinterest's own "refine this search" suggestions, each with a small picture
  document.addEventListener("pf:guides", (e) => {
    try { const d = JSON.parse(e.detail); if (routeOf(d.req, d.at) === cur) setGuides(d.guides); } catch {}
  });
  function setGuides(g) {
    if (!g || !g.length || !location.pathname.startsWith("/search")) return;
    route(cur).guides = g;
    renderGuides();
  }
  let fromData = false;
  document.addEventListener("pf:pins", (e) => {
    try {
      const d = JSON.parse(e.detail);
      const key = routeOf(d.req, d.at);
      if (!key) return;
      fromData = true;
      ingest(d.pins, key);
    } catch {}
  });
  let scanT = 0;
  function scanDom() {
    scanT = 0;
    if (host) quietPage();
    if (fromData) return;
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/pin/"]')) {
      const id = (a.getAttribute("href").match(/\/pin\/(\d+)/) || [])[1];
      if (!id || seen.has(id)) continue;
      const img = a.querySelector('img[src*="pinimg.com"]');
      if (!img || !img.complete || !img.naturalWidth) continue;
      const src = img.currentSrc || img.src;
      out.push({
        id, w: img.naturalWidth, h: img.naturalHeight, color: null, title: (img.alt || "").slice(0, 140), link: null, video: null,
        src: { s: X.sized(src, "236x"), m: X.sized(src, "474x"), l: X.sized(src, "736x"), o: X.sized(src, "originals") },
      });
    }
    if (out.length) ingest(out);
  }
  new MutationObserver(() => { if (!scanT) scanT = setTimeout(scanDom, 600); })
    .observe(document.documentElement, { childList: true, subtree: true });
  // the hidden Pinterest page underneath would keep playing its own videos
  function quietPage() { for (const v of document.getElementsByTagName("video")) if (!v.paused) v.pause(); }

  // ---------- actions sent through Pinterest's own page (hook.js) ----------
  let apiN = 0;
  const apiWait = new Map();
  document.addEventListener("pf:api:res", (e) => {
    let r;
    try { r = JSON.parse(e.detail); } catch { return; }
    const w = apiWait.get(r.id);
    if (!w) return;
    apiWait.delete(r.id);
    r.ok ? w.resolve(r.data) : w.reject(new Error(r.error));
  });
  const api = (op, args) => new Promise((resolve, reject) => {
    const id = ++apiN;
    apiWait.set(id, { resolve, reject });
    document.dispatchEvent(new CustomEvent("pf:api", { detail: JSON.stringify({ id, op, args }) }));
    setTimeout(() => { if (apiWait.delete(id)) reject(new Error("timed out")); }, 15000);
  });

  // ---------- theme ----------
  const SWATCHES = ["#ffffff", "#f1f1f1", "#f6f1e7", "#e7ecef", "#2b2b2b", "#111111"];
  function themeVars(bg) {
    const n = parseInt(bg.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.55
      ? `--bg:${bg};--fg:#111;--muted:#5f5f5f;--chrome:#fff;--field:#e9e9e9;--field-h:#e1e1e1;--line:rgba(0,0,0,.08);--ph:#efefef;--btn:#e9e9e9;--btn-h:#dadada;--shade:rgba(0,0,0,.14);--glass:rgba(255,255,255,.52);--glass-2:rgba(250,250,250,.88);--rim:rgba(255,255,255,.9);--rim-lo:rgba(255,255,255,.35);--edge:rgba(0,0,0,.07);--lens:rgba(0,0,0,.11);--press:rgba(0,0,0,.05)`
      : `--bg:${bg};--fg:#f2f2f2;--muted:#a5a5a5;--chrome:#1f1f1f;--field:#2f2f2f;--field-h:#383838;--line:rgba(255,255,255,.08);--ph:#262626;--btn:#2f2f2f;--btn-h:#3a3a3a;--shade:rgba(0,0,0,.45);--glass:rgba(38,38,38,.5);--glass-2:rgba(34,34,34,.88);--rim:rgba(255,255,255,.24);--rim-lo:rgba(255,255,255,.08);--edge:rgba(255,255,255,.06);--lens:rgba(255,255,255,.13);--press:rgba(255,255,255,.07)`;
  }
  const getBg = () => { const v = lsGet(LS.bg, ""); return /^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff"; };
  function applyBg(bg) {
    lsSet(LS.bg, bg);
    if (!ui.root) return;
    ui.root.style.cssText = themeVars(bg);
    for (const b of ui.root.querySelectorAll("[data-bg]")) b.setAttribute("aria-pressed", String(b.dataset.bg === bg));
    const c = ui.root.querySelector(".sw.custom input");
    if (c) c.value = bg;
  }

  // ---------- icons (paths drawn for this, 24px grid) ----------
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    home: svg("M9 19v-4.5h6V19a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-8.17a2 2 0 0 0-.6-1.43l-7-6.82a2 2 0 0 0-2.8 0l-7 6.82A2 2 0 0 0 3 10.83V19a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1"),
    explore: svg("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14m4 3-5.5 2.5L8 16l5.5-2.5zm-4 2.7a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6"),
    search: svg("M10 16a6 6 0 1 1 .01-12.01A6 6 0 0 1 10 16m13.12 2.88-4.26-4.26A9.9 9.9 0 0 0 20 10a10 10 0 1 0-10 10c1.67 0 3.24-.41 4.62-1.14l4.26 4.26a3 3 0 0 0 4.24 0 3 3 0 0 0 0-4.24"),
    boards: svg("M3 3h8v8H3zm10 0h8v5h-8zM3 13h8v8H3zm10-3h8v11h-8z"),
    create: svg("M11 3h2v8h8v2h-8v8h-2v-8H3v-2h8z"),
    native: svg("M12 2a10 10 0 0 0-3.64 19.31c-.09-.79-.17-2 .03-2.86l1.17-4.97s-.3-.6-.3-1.48c0-1.39.8-2.42 1.8-2.42.85 0 1.26.64 1.26 1.4 0 .85-.54 2.13-.82 3.31-.24 1 .5 1.8 1.48 1.8 1.78 0 3.14-1.87 3.14-4.57 0-2.39-1.72-4.06-4.17-4.06-2.84 0-4.5 2.13-4.5 4.33 0 .86.33 1.78.74 2.28.08.1.1.19.07.29l-.27 1.13c-.05.18-.15.22-.34.13-1.25-.58-2.03-2.41-2.03-3.88 0-3.16 2.3-6.06 6.62-6.06 3.48 0 6.18 2.48 6.18 5.79 0 3.45-2.18 6.23-5.2 6.23-1.02 0-1.97-.53-2.3-1.15l-.62 2.38c-.23.87-.84 1.96-1.25 2.63A10 10 0 1 0 12 2"),
    tune: svg("M4 7h9.2a3 3 0 0 1 5.6 0H20v2h-1.2a3 3 0 0 1-5.6 0H4zm12 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2M4 15h1.2a3 3 0 0 1 5.6 0H20v2h-9.2a3 3 0 0 1-5.6 0H4zm4 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2"),
    back: svg("M8.4 13l6.3 6.3-1.4 1.4L4.6 12l8.7-8.7 1.4 1.4L8.4 11H20v2z"),
    share: svg("M12 2l5 5-1.4 1.4L13 5.8V15h-2V5.8L8.4 8.4 7 7zM4 13h2v6h12v-6h2v8H4z"),
    more: svg("M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4m7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4"),
    visit: svg("M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z"),
    download: svg("M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3zM4 19h16v2H4z"),
    similar: svg("M3 3h7v9H3zm11 0h7v5h-7zM3 16h7v5H3zm11-5h7v10h-7z"),
    hide: svg("M2.8 4.2 4.2 2.8l17 17-1.4 1.4-3.2-3.2A11 11 0 0 1 12 19C6.5 19 2.6 15 1 12c.8-1.5 2-3.2 3.7-4.6zM12 5c5.5 0 9.4 4 11 7a13 13 0 0 1-3.1 3.8L16.9 13A5 5 0 0 0 11 7.1L9 5.2A12 12 0 0 1 12 5m-3.7 6.1a4 4 0 0 0 4.6 4.6z"),
    close: svg("m15.18 12 7.16-7.16-3.18-3.18L12 8.82 4.84 1.66 1.66 4.84 8.82 12l-7.16 7.16 3.18 3.18L12 15.18l7.16 7.16 3.18-3.18z"),
    chev: svg("M12 15.5 5.5 9l1.4-1.4 5.1 5.1 5.1-5.1L18.5 9z"),
    pin: svg("M17 3H7v2h1v5.4L5 13v2h6v6l1 1 1-1v-6h6v-2l-3-2.6V5h1z"),
    check: svg("M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"),
    expand: svg("M4 4h6v2H7.4l3.3 3.3-1.4 1.4L6 7.4V10H4zm10 0h6v6h-2V7.4l-3.3 3.3-1.4-1.4L16.6 6H14zM4 14h2v2.6l3.3-3.3 1.4 1.4L7.4 18H10v2H4zm14 2.6V14h2v6h-6v-2h2.6l-3.3-3.3 1.4-1.4z"),
    person: svg("M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10m0 2c-4.4 0-9 2.2-9 5.5V22h18v-2.5c0-3.3-4.6-5.5-9-5.5"),
    link: svg("M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0M7 18a4 4 0 0 1-2.8-6.8l2.5-2.5 1.4 1.4-2.5 2.5a2 2 0 0 0 2.8 2.8l2.5-2.5 1.4 1.4-2.5 2.5A4 4 0 0 1 7 18m10.3-4.7-1.4-1.4 2.5-2.5a2 2 0 0 0-2.8-2.8l-2.5 2.5-1.4-1.4 2.5-2.5a4 4 0 0 1 5.6 5.6z"),
  };

  // ---------- overlay ----------
  let host = null, field = null, ui = {};
  let bootTimer = 0, keyGuard = false, boxPin = null;
  // select mode: picked pins in the order you picked them; selNote is a passing message in the pill ("Saving 3")
  let selecting = false, selNote = null, selT = 0;
  const selected = new Map();
  const isOn = () => lsGet(LS.on, "1") !== "0";

  const STYLE = `
  :host{all:initial}
  *{box-sizing:border-box}
  .root{position:fixed;inset:0;z-index:2147483646;background:var(--bg);color:var(--fg);font:400 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Helvetica,ui-sans-serif,sans-serif;contain:strict;-webkit-font-smoothing:antialiased}
  svg{width:20px;height:20px;fill:currentColor;flex:none}
  .stage{position:absolute;inset:0;overflow:hidden;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;outline:none;overscroll-behavior:none}
  .stage[data-panning]{cursor:grabbing}
  .layer{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
  .layer.mv{pointer-events:none}
  .layer.enter{animation:enter .8s cubic-bezier(.16,1,.3,1) both}
  @keyframes enter{from{opacity:0;scale:.92}to{opacity:1;scale:1}}
  .t{position:absolute;left:0;top:0;display:block;contain:layout paint style;color:inherit;text-decoration:none;-webkit-user-drag:none;transition:opacity .2s}
  .t[hidden]{display:none}
  .ph{position:relative;display:block;width:100%;height:100%;overflow:hidden;border-radius:16px}
  /* three dots on a tile still waiting for its picture; still while the field moves, so panning stays cheap */
  .dots{position:absolute;inset:0;display:none;align-items:center;justify-content:center;gap:5px;pointer-events:none}
  .t[data-ld] .dots{display:flex}
  .dots i{width:7px;height:7px;border-radius:50%;background:var(--muted);opacity:.55}
  .t[data-ld] .dots i{animation:dot 1s infinite ease-in-out}
  .t[data-ld] .dots i:nth-child(2){animation-delay:.15s}.t[data-ld] .dots i:nth-child(3){animation-delay:.3s}
  .layer.mv .dots i,.stage[data-ql="2"] .dots i{animation-play-state:paused}
  /* a search on its way: the old results fade back and the dots show until the new ones arrive */
  .stage{transition:opacity .25s ease}
  .root[data-busy] .stage{opacity:.25}
  .ph img,.ph .vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 0}
  .ph img{opacity:0;transition:opacity .2s ease}
  .ph img.in{opacity:1}
  .ph .vid{opacity:0;transition:opacity .25s;pointer-events:none}
  .ph .vid.on{opacity:1}
  .stage[data-ql="2"] .ph img,.stage[data-ql="2"] .t{transition:none}
  .stage[data-ql="2"] .ph{border-radius:12px}
  .t:focus-visible .ph{outline:3px solid #0074e8;outline-offset:2px}
  .stage[data-pivot] .t:not([data-seed]){opacity:.3}
  .t[data-seed]{z-index:2}
  .t.rise{animation:fade .4s ease both;animation-delay:var(--d,0s)}
  @keyframes fade{from{opacity:0;translate:0 18px}}
  /* quick actions: one element, moved onto whichever pin is hovered */
  .qa{position:absolute;inset:0;z-index:3;background:rgba(0,0,0,.3);display:flex;flex-direction:column;justify-content:space-between;padding:10px;animation:qa .12s ease both}
  @keyframes qa{from{opacity:0}}
  .qa-top,.qa-bot{display:flex;gap:6px;align-items:center}
  .qa-top{justify-content:flex-end}
  .qa-bot{justify-content:flex-end}
  .qa-bot .grow{flex:1}
  .q{height:36px;min-width:36px;display:inline-flex;align-items:center;justify-content:center;gap:4px;border-radius:999px;background:rgba(255,255,255,.62);-webkit-backdrop-filter:blur(12px) saturate(1.8);backdrop-filter:blur(12px) saturate(1.8);color:#111;cursor:pointer;font-weight:600;font-size:14px;padding:0 10px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.9),inset 0 0 0 .5px rgba(255,255,255,.4),0 2px 10px rgba(0,0,0,.12);transition:scale .2s cubic-bezier(.2,.8,.2,1),background .15s}
  .q:hover{background:rgba(255,255,255,.85)}
  .q:active{scale:1.1}
  .stage[data-ql="2"] .q{-webkit-backdrop-filter:none;backdrop-filter:none}
  .stage[data-ql="2"] .q:not(.save):not(.board){background:rgba(255,255,255,.92)}
  .q svg{width:16px;height:16px}
  .q.ic{width:36px;padding:0}
  .q.save{background:#e60023;color:#fff;padding:0 14px;font-size:15px}
  .q.save:hover{background:#ad081b}
  .q.save[data-done]{background:#111}
  .q.board{max-width:130px;background:rgba(0,0,0,.32);color:#fff;font-weight:600;margin-right:auto;box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 2px 10px rgba(0,0,0,.12)}
  .q.board:hover{background:rgba(0,0,0,.48)}
  .q.board span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .q[hidden]{display:none}
  .stage[data-lite] .qa{display:none}
  /* Liquid Glass (iOS 26/27): floating capsules of frosted glass with a bright rim, a darker lens behind
     the selected tab, and a dock that shrinks while you move. */
  .glass{position:relative;background:var(--glass);-webkit-backdrop-filter:blur(16px) saturate(1.8);backdrop-filter:blur(16px) saturate(1.8);
    box-shadow:inset 0 1px 0 var(--rim),inset 0 -1px 0 var(--rim-lo),inset 0 0 0 .5px var(--rim-lo),0 0 0 .5px var(--edge),0 8px 28px var(--shade)}
  .glass::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
    background:linear-gradient(180deg,rgba(255,255,255,.28),rgba(255,255,255,0) 42%,rgba(255,255,255,0) 72%,rgba(255,255,255,.1));mix-blend-mode:soft-light}
  .root[data-ql="2"] .glass,.root[data-ql="2"] .pop,.root[data-ql="2"] .sugg{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--glass-2)}
  /* a long pan: the glass turns to frosted solid, so the GPU doesn't re-blur the moving field under it every frame */
  .glass{transition:background .2s}
  .root[data-moving] .glass{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--glass-2);transition:background .2s .25s,backdrop-filter 0s .25s,scale .35s cubic-bezier(.2,.8,.2,1) .25s}
  .dock{position:absolute;bottom:18px;left:50%;translate:-50% 0;z-index:9;display:flex;align-items:center;transform-origin:50% 100%;
    transition:scale .35s cubic-bezier(.2,.8,.2,1),translate .35s cubic-bezier(.2,.8,.2,1)}
  .root[data-moving] .dock{scale:.86;translate:-50% 8px;transition-delay:.25s}
  .corner{position:absolute;top:16px;right:16px;z-index:9;transform-origin:100% 0;transition:scale .35s cubic-bezier(.2,.8,.2,1)}
  .root[data-moving] .corner{scale:.86;transition-delay:.25s}
  .grp{display:flex;align-items:center;gap:2px;padding:5px;border-radius:29px;isolation:isolate}
  .lens{position:absolute;left:0;top:5px;width:48px;height:48px;border-radius:24px;background:var(--lens);z-index:-1;opacity:0;pointer-events:none;
    box-shadow:inset 0 .5px 0 var(--rim-lo)}
  .lens.on{opacity:1}
  .dock .srch{position:relative;display:flex;align-items:center;height:48px;margin:0 4px;padding:0}
  .dock form svg{position:absolute;left:14px;top:50%;translate:0 -50%;width:17px;height:17px;fill:var(--muted);pointer-events:none}
  .dock input{display:block;box-sizing:border-box;width:min(28vw,280px);height:40px;margin:0;border:0;border-radius:20px;padding:0 14px 0 38px;background:var(--press);color:var(--fg);font:inherit;font-size:15px;line-height:40px;outline:none;-webkit-appearance:none;appearance:none;transition:background .2s,box-shadow .2s}
  .dock input::placeholder{color:var(--muted)}
  .dock input:hover{background:var(--lens)}
  .dock input:focus{background:var(--lens);box-shadow:0 0 0 2px rgba(0,116,232,.5)}
  .ib{width:48px;height:48px;border:0;border-radius:50%;background:transparent;color:var(--fg);cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;position:relative;
    transition:scale .25s cubic-bezier(.2,.8,.2,1),background .2s}
  .ib svg{width:22px;height:22px}
  .ib:hover{background:var(--press)}
  .ib:active{scale:1.12;background:var(--lens)}
  .ib[hidden]{display:none}
  .ib:focus-visible,.sw:focus-visible,.btn:focus-visible,.mi:focus-visible,.seg button:focus-visible,.bd:focus-visible{outline:3px solid #0074e8;outline-offset:1px}
  /* popovers */
  .pop{position:absolute;z-index:11;border-radius:24px;background:var(--glass-2);-webkit-backdrop-filter:blur(30px) saturate(1.8);backdrop-filter:blur(30px) saturate(1.8);color:var(--fg);
    box-shadow:inset 0 1px 0 var(--rim),inset 0 0 0 .5px var(--rim-lo),0 0 0 .5px var(--edge),0 14px 40px var(--shade);padding:10px;transform-origin:50% 100%;animation:pop .28s cubic-bezier(.2,.8,.2,1) both}
  @keyframes pop{from{opacity:0;scale:.9;translate:0 10px}}
  .pop[hidden]{display:none}
  .pop h3{margin:6px 8px 8px;font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em}
  .swatches{display:grid;grid-template-columns:repeat(4,36px);gap:8px;padding:4px 8px 8px}
  .sw{width:36px;height:36px;border-radius:50%;border:0;cursor:pointer;box-shadow:0 0 0 1px rgba(0,0,0,.15) inset}
  .sw[aria-pressed="true"]{box-shadow:0 0 0 1px rgba(0,0,0,.15) inset,0 0 0 2px var(--chrome),0 0 0 4px var(--fg)}
  .sw.custom{position:relative;overflow:hidden;background:conic-gradient(#e60023,#f5a623,#f8e71c,#7ed321,#4a90e2,#9013fe,#e60023)}
  .sw.custom input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;padding:0}
  .seg{display:flex;gap:4px;padding:4px 8px 8px}
  .seg button{flex:1;height:34px;border:0;border-radius:17px;background:var(--btn);color:var(--fg);font:inherit;font-weight:600;font-size:13px;cursor:pointer;padding:0 12px}
  .seg button[aria-pressed="true"]{background:var(--fg);color:var(--chrome)}
  .mi{display:flex;align-items:center;gap:12px;width:100%;height:44px;border:0;border-radius:10px;background:transparent;color:var(--fg);font:inherit;font-weight:600;font-size:15px;cursor:pointer;padding:0 12px;text-align:left}
  .mi{transition:background .15s}
  .mi:hover{background:var(--press)}
  .mi:active{background:var(--lens)}
  .bp{width:320px;max-height:min(440px,70vh);display:flex;flex-direction:column;padding:6px}
  .bp input{height:44px;border:0;border-radius:22px;background:var(--press);color:var(--fg);font:inherit;font-size:15px;padding:0 16px;margin:2px 0 10px;outline:none;flex:none;transition:background .2s,box-shadow .2s}
  .bp input:focus{background:var(--lens);box-shadow:0 0 0 2px rgba(0,116,232,.5)}
  .bp h3{margin:4px 8px 6px;font-size:12px;font-weight:600;color:var(--muted)}
  .bp .list{overflow:auto;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin}
  .bd{display:flex;align-items:center;gap:12px;border:0;background:transparent;color:var(--fg);font:inherit;font-weight:600;font-size:15px;padding:6px;border-radius:10px;cursor:pointer;text-align:left}
  .bd{transition:background .15s,scale .15s}
  .bd:hover{background:var(--press)}
  .bd:active{scale:.98;background:var(--lens)}
  .bd i{width:48px;height:48px;border-radius:10px;background:var(--ph) center/cover;flex:none;display:flex;align-items:center;justify-content:center}
  .bd span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  /* account page: profile header, Created/Saved tabs, board cards */
  .boards{position:absolute;inset:0;z-index:7;overflow:auto;padding:40px 28px 130px;background:var(--bg)}
  .boards[hidden]{display:none}
  .acct{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;margin-bottom:22px}
  .acct .av{width:112px;height:112px;border-radius:50%;background:var(--ph) center/cover;display:flex;align-items:center;justify-content:center;color:var(--muted)}
  .acct .av svg{width:48px;height:48px}
  .acct h2{margin:8px 0 0;font-size:32px;line-height:1.15;font-weight:600;letter-spacing:-.01em}
  .acct .handle{color:var(--muted);font-size:14px}
  .acct .stats{font-size:15px;font-weight:600}
  .acct .row{display:flex;gap:8px;margin-top:12px}
  .tabs{display:flex;justify-content:center;gap:28px;margin:10px 0 18px}
  .tab{border:0;background:none;color:var(--fg);font:inherit;font-weight:600;font-size:16px;padding:8px 2px;cursor:pointer;position:relative}
  .tab[aria-current="page"]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;border-radius:2px;background:var(--fg)}
  .tools{max-width:1400px;margin:0 auto 14px;display:flex;justify-content:space-between;align-items:center}
  .tools select{height:40px;border:0;border-radius:20px;background:var(--btn);color:var(--fg);font:inherit;font-weight:600;padding:0 14px;cursor:pointer}
  .bgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;max-width:1400px;margin:0 auto}
  .bcard{display:flex;flex-direction:column;gap:12px;padding:12px;border-radius:28px;background:var(--chrome);box-shadow:0 0 0 1px var(--line)}
  .bcard .cover{display:block;width:100%;aspect-ratio:1;border:0;padding:0;border-radius:18px;background:var(--ph) center/cover;cursor:pointer}
  .bcard .meta{display:flex;align-items:center;gap:10px;padding:0 4px}
  .bcard .nm{flex:1;min-width:0;font-weight:600;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bcard .badge{flex:none;font-size:11px;font-weight:600;padding:3px 8px;border-radius:6px;box-shadow:0 0 0 1px var(--line) inset;color:var(--muted)}
  .bcard .strip{display:flex;align-items:center;gap:10px;padding:8px 12px 8px 8px;border-radius:18px;box-shadow:0 0 0 1px var(--line) inset}
  .bcard .stack{flex:1;display:flex;border:0;padding:0;background:none;cursor:pointer;min-width:0;height:72px}
  .bcard .stack b{flex:none;width:52px;height:72px;border-radius:12px;background:var(--ph) center/cover;box-shadow:0 0 0 2px var(--chrome)}
  .bcard .stack b + b{margin-left:-30px}
  .bcard .stack b:nth-child(1){z-index:5}.bcard .stack b:nth-child(2){z-index:4}.bcard .stack b:nth-child(3){z-index:3}.bcard .stack b:nth-child(4){z-index:2}.bcard .stack b:nth-child(5){z-index:1}
  .bcard .all{flex:none;display:flex;align-items:center;gap:6px;border:0;background:none;color:var(--fg);font:inherit;font-weight:600;font-size:14px;cursor:pointer;line-height:1.1;text-align:left;padding:6px}
  .bcard .all svg{width:18px;height:18px}
  .bcard .all small{display:block;color:var(--muted);font-weight:500;font-size:12px}
  .bcard .cover:focus-visible,.bcard .stack:focus-visible,.bcard .all:focus-visible,.tab:focus-visible,.tools select:focus-visible{outline:3px solid #0074e8;outline-offset:2px}
  .ib .me{width:28px;height:28px;border-radius:50%;background:var(--ph) center/cover}
  /* explore: Pinterest's Explore page, laid out the way Pinterest does it */
  .ex{max-width:1400px;margin:0 auto;display:flex;flex-direction:column;gap:34px}
  .exh{text-align:center}
  .exh .day{font-size:16px;font-weight:600}
  .exh h2{margin:4px 0 0;font-size:36px;line-height:1.1;font-weight:600;letter-spacing:-.01em}
  .ints{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:-12px}
  .ints .chip{padding:0 16px}
  .ex h3{margin:0 0 14px;font-size:24px;font-weight:600;letter-spacing:-.01em}
  .stories{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .pops{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,1fr);gap:16px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
  .story,.topic{display:flex;flex-direction:column;gap:8px;border:0;padding:0;background:none;color:var(--fg);font:inherit;text-align:left;cursor:pointer}
  .story i,.topic i{display:block;width:100%;border-radius:16px;background:center/cover no-repeat;transition:filter .15s}
  .story i{aspect-ratio:3/2}
  .topic i{aspect-ratio:3/4}
  .story:hover i,.topic:hover i,.fb:hover .col,.fp:hover{filter:brightness(.9)}
  .story span{font-size:18px;font-weight:600;line-height:1.2}
  .topic span{font-size:15px;font-weight:600;line-height:1.2;padding:0 2px}
  .fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px}
  .fb{display:flex;flex-direction:column;gap:4px;border:0;padding:0;background:none;color:var(--fg);font:inherit;text-align:left;cursor:pointer}
  .fb .col{display:grid;grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr;gap:2px;aspect-ratio:3/2;border-radius:16px;overflow:hidden;margin-bottom:6px;transition:filter .15s}
  .fb .col b{background:var(--ph) center/cover}
  .fb .col b:first-child{grid-row:1 / 3}
  .fb .nm{font-size:16px;font-weight:600;line-height:1.25;padding:0 4px}
  .fb small{font-size:12px;color:var(--muted);padding:0 4px}
  .fresh{columns:6 180px;column-gap:16px}
  .fp{display:block;width:100%;border:0;padding:0;margin:0 0 16px;border-radius:16px;background:center/cover;cursor:pointer;break-inside:avoid;transition:filter .15s}
  .exf{display:flex;justify-content:center}
  .story:focus-visible i,.topic:focus-visible i,.fb:focus-visible .col,.fp:focus-visible{outline:3px solid #0074e8;outline-offset:2px}
  /* pin view */
  /* an open pin: a big card in the grid with its button rail beside it; the cards around it stay faded until
     you move the field */
  /* enlarge: the pin full size over everything; click anywhere or Esc to close */
  .box{position:absolute;inset:0;z-index:13;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(12,12,12,.9);cursor:zoom-out;animation:fadeIn .2s ease both}
  .box[hidden]{display:none}
  @keyframes fadeIn{from{opacity:0}}
  .box img{max-width:100%;max-height:100%;object-fit:contain;border-radius:12px}
  .box .ib{position:absolute;top:18px;right:18px;color:#fff;background:rgba(255,255,255,.16);box-shadow:inset 0 1px 0 rgba(255,255,255,.25)}
  .box .ib:hover{background:rgba(255,255,255,.26)}
  .hero{position:absolute;left:0;top:0;z-index:4}
  .hero .card{position:relative;width:100%;height:100%;border-radius:28px;overflow:hidden;background:var(--ph);box-shadow:0 10px 32px var(--shade),0 0 0 .5px var(--edge)}
  /* enlarge sits in the corner, only while you're over the pin */
  .hero .zoom{position:absolute;top:14px;right:14px;opacity:0;scale:.9;transition:opacity .18s ease,scale .18s ease}
  .hero .card:hover .zoom,.hero .zoom:focus-visible{opacity:1;scale:1}
  .hero .media{position:relative;width:100%;height:100%;display:block;overflow:hidden}
  .hero .media img,.hero .media video{position:relative;display:block;width:100%;height:100%;object-fit:contain}
  .hero .media img.bg{position:absolute;inset:0;object-fit:cover;filter:blur(36px) saturate(1.15);scale:1.2;opacity:.85}
  .acts{position:absolute;display:flex;flex-direction:column;gap:10px;align-items:center}
  /* where a save went: slides out beside the pin button, then goes */
  .acts .tag{position:absolute;left:calc(100% + 8px);height:36px;display:flex;align-items:center;padding:0 14px;border-radius:18px;white-space:nowrap;font-weight:600;font-size:14px;color:var(--fg);
    opacity:0;translate:-6px 0;pointer-events:none;transition:opacity .2s ease,translate .3s cubic-bezier(.2,.8,.2,1)}
  .acts .tag.on{opacity:1;translate:0 0}
  .acts .grp{flex-direction:column;gap:4px;padding:5px}
  .acts .ib svg{width:20px;height:20px}
  .ib.save{background:#e60023;color:#fff}
  .ib.save:hover{background:#c8001f}
  .ib.save:active{background:#ad081b}
  .ib.save[data-done]{background:var(--fg);color:var(--chrome)}
  .ib.save[data-done]:hover{background:var(--muted)}
  .stage[data-focus] .t{opacity:.16}
  .stage[data-focus] .qa{display:none}
  .toast{position:absolute;left:50%;bottom:96px;translate:-50% 0;z-index:12;display:flex;align-items:center;gap:10px;padding:12px 18px;border-radius:999px;background:rgba(20,20,20,.72);-webkit-backdrop-filter:blur(20px) saturate(1.6);backdrop-filter:blur(20px) saturate(1.6);color:#fff;font-weight:600;font-size:14px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 8px 28px rgba(0,0,0,.25);animation:toast .3s cubic-bezier(.2,.8,.2,1) both}
  .toast[hidden]{display:none}
  .toast i{width:28px;height:28px;border-radius:8px;background:#333 center/cover}
  @keyframes toast{from{opacity:0;translate:-50% 8px}}
  .load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:6px;pointer-events:none}
  .load[hidden]{display:none}
  .load i{width:8px;height:8px;border-radius:50%;background:var(--muted);animation:dot 1s infinite ease-in-out}
  .load i:nth-child(2){animation-delay:.15s}.load i:nth-child(3){animation-delay:.3s}
  @keyframes dot{50%{opacity:.25;scale:.7}}
  .note{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--muted);font-size:16px}
  .note[hidden]{display:none}
  .note p{margin:0}
  .btn{height:44px;padding:0 18px;border:0;border-radius:999px;background:var(--btn);color:var(--fg);font:inherit;font-weight:600;font-size:15px;cursor:pointer}
  .btn:hover{background:var(--btn-h)}
  /* search suggestions: opens upward from the dock's search box, like a normal search */
  .sugg{position:absolute;z-index:11;width:min(520px,80vw);max-height:min(460px,60vh);overflow:auto;border-radius:26px;background:var(--glass-2);-webkit-backdrop-filter:blur(30px) saturate(1.8);backdrop-filter:blur(30px) saturate(1.8);color:var(--fg);
    box-shadow:inset 0 1px 0 var(--rim),inset 0 0 0 .5px var(--rim-lo),0 0 0 .5px var(--edge),0 14px 40px var(--shade);padding:10px;scrollbar-width:none;transform-origin:50% 100%;animation:pop .28s cubic-bezier(.2,.8,.2,1) both}
  .sugg[hidden]{display:none}
  .sugg h3{margin:8px 10px 6px;font-size:12px;font-weight:600;color:var(--muted)}
  .sg{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;border:0;border-radius:12px;background:transparent;color:var(--fg);font:inherit;font-size:15px;padding:6px 10px;cursor:pointer;text-align:left}
  .sg:hover,.sg[aria-selected="true"]{background:var(--btn)}
  .sg svg{width:16px;height:16px;fill:var(--muted)}
  .sg i{width:32px;height:32px;border-radius:8px;background:var(--ph) center/cover;flex:none}
  .sg b{font-weight:600}
  .chips{display:flex;flex-wrap:wrap;gap:8px;padding:2px 6px 6px}
  .chip{display:flex;align-items:center;gap:8px;height:40px;border:0;border-radius:20px;background:var(--btn);color:var(--fg);font:inherit;font-weight:600;font-size:14px;padding:0 14px 0 4px;cursor:pointer}
  .chip:hover,.chip[aria-selected="true"]{background:var(--btn-h)}
  .chip i{width:32px;height:32px;border-radius:50%;background:var(--ph) center/cover;flex:none}
  .sg:focus-visible,.chip:focus-visible{outline:3px solid #0074e8;outline-offset:1px}
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  /* select: a pill left of the corner tools. It grows to "3 selected | Download | Cancel" as you pick pins;
     its width is set from its contents so the change can animate. --cw is the corner's width. */
  .sel{position:absolute;top:16px;right:calc(16px + var(--cw,158px) + 8px);z-index:9;display:flex;justify-content:flex-end;overflow:hidden;transform-origin:100% 0;
    transition:width .32s cubic-bezier(.2,.8,.2,1),scale .35s cubic-bezier(.2,.8,.2,1),translate .35s cubic-bezier(.2,.8,.2,1),background .2s}
  /* follows the corner as it shrinks while you move */
  .root[data-moving] .sel{scale:.86;translate:calc(var(--cw,158px) * .14) 0;transition-delay:.25s}
  .boards:not([hidden]) ~ .sel{display:none}
  .sel .in{display:flex;align-items:center;gap:2px;flex:none;white-space:nowrap}
  .sb{height:48px;display:inline-flex;align-items:center;gap:6px;padding:0 18px;border:0;border-radius:24px;background:transparent;color:var(--fg);font:inherit;font-weight:600;font-size:15px;cursor:pointer;
    transition:scale .25s cubic-bezier(.2,.8,.2,1),background .2s}
  .sb svg{width:18px;height:18px}
  .sb:hover{background:var(--press)}
  .sb:active{scale:1.08;background:var(--lens)}
  .sb:focus-visible{outline:3px solid #0074e8;outline-offset:1px}
  .sb.dl{background:#e60023;color:#fff}
  .sb.dl:hover{background:#c8001f}
  .sb.dl:active{background:#ad081b}
  .sb[disabled]{cursor:default;opacity:.6}
  .sel .lbl{display:inline-flex;align-items:center;gap:6px;height:48px;padding:0 10px 0 16px;font-weight:600;font-size:15px;font-variant-numeric:tabular-nums}
  .sel .lbl svg{width:18px;height:18px}
  .sel .sep{width:1px;height:22px;background:var(--line);margin:0 4px}
  @media (max-width:560px){.sel{top:76px;right:16px}.root[data-moving] .sel{translate:0 0}}
  /* select mode: a ring and a tick on each picked pin; the hover buttons step aside */
  .stage[data-select] .qa{display:none}
  .stage[data-select]{cursor:default}
  .ck{position:absolute;top:10px;right:10px;z-index:4;width:28px;height:28px;border-radius:50%;display:none;pointer-events:none;
    background:rgba(255,255,255,.7);box-shadow:inset 0 0 0 2px rgba(255,255,255,.95),0 1px 6px rgba(0,0,0,.25);transition:background .15s,scale .2s cubic-bezier(.2,.8,.2,1)}
  .stage[data-select] .t[href] .ck{display:block}
  .t[data-sel] .ck{display:block;background:#e60023;scale:1.08}
  .t[data-sel] .ck::after{content:"";position:absolute;left:10px;top:6px;width:6px;height:12px;border:solid #fff;border-width:0 2.5px 2.5px 0;rotate:45deg}
  .t[data-sel] .ph::after{content:"";position:absolute;inset:0;z-index:4;border-radius:inherit;pointer-events:none;box-shadow:inset 0 0 0 4px #e60023,inset 0 0 0 6px rgba(255,255,255,.85)}
  @media (prefers-reduced-motion:reduce){.layer.enter,.t.rise,.load i,.qa,.toast,.pop,.sugg,.card,.acts,.box,.dots i{animation:none!important}.dock,.corner,.ib,.q,.acts .tag,.hero .zoom,.sel,.sb,.ck{transition:none}.ph img,.ph .vid{transition:none}}
  `;

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cssUrl = (u) => (typeof u === "string" && /^https:\/\/[is]\.pinimg\.com\//.test(u) ? `url("${u.replace(/["\\]/g, "")}")` : "none");

  function mount() {
    if (host) return;
    host = document.createElement("pinfield-root");
    const shadow = host.attachShadow({ mode: "open" });
    const style = el("style");
    style.textContent = STYLE;
    const root = el("div", "root");
    shadow.append(style, root);

    const dock = el("nav", "dock");
    dock.setAttribute("aria-label", "Pinfield");
    dock.innerHTML = `
      <div class="glass grp tabbar"><span class="lens" aria-hidden="true"></span>
        <button class="ib" data-a="back" title="Back" aria-label="Back" hidden>${I.back}</button>
        <button class="ib" data-a="home" title="Home" aria-label="Home">${I.home}</button>
        <button class="ib" data-a="explore" title="Explore" aria-label="Explore">${I.explore}</button>
        <form role="search" class="srch">${I.search}<input type="search" placeholder="Search" aria-label="Search Pinterest"></form>
        <button class="ib" data-a="boards" title="Your account and boards" aria-label="Your account and boards">${I.person}</button>
      </div>`;
    // the tools sit apart, top right
    const corner = el("div", "glass grp corner");
    corner.innerHTML = `
        <button class="ib" data-a="create" title="Create a pin" aria-label="Create a pin">${I.create}</button>
        <button class="ib" data-a="tune" title="Look and speed" aria-label="Look and speed" aria-expanded="false">${I.tune}</button>
        <button class="ib" data-a="native" title="Normal Pinterest: notifications, messages, profile (Alt+Shift+F)" aria-label="Switch to normal Pinterest">${I.native}</button>`;

    const tune = el("div", "pop", `
      <h3>Background</h3>
      <div class="swatches">
        ${SWATCHES.map((c) => `<button class="sw" data-bg="${c}" style="background:${c}" aria-label="Background ${c}" aria-pressed="false"></button>`).join("")}
        <label class="sw custom" title="Any colour"><input type="color" aria-label="Pick any background colour"></label>
      </div>
      <h3>Motion</h3>
      <div class="seg" role="group" aria-label="Quality">
        <button data-qm="auto" aria-pressed="false" title="Adjusts to your computer">Auto</button>
        <button data-qm="smooth" aria-pressed="false" title="Lightest: for slower computers">Smooth</button>
        <button data-qm="sharp" aria-pressed="false" title="Sharpest images and video">Sharp</button>
      </div>`);
    tune.hidden = true;
    tune.setAttribute("role", "dialog");
    tune.setAttribute("aria-label", "Look and speed");

    const menu = el("div", "pop");
    menu.hidden = true;
    menu.setAttribute("role", "menu");

    const boards = el("section", "boards");
    boards.hidden = true;
    boards.setAttribute("aria-label", "Your boards");

    const load = el("div", "load", "<i></i><i></i><i></i>");
    load.setAttribute("role", "status");
    load.setAttribute("aria-label", "Loading pins");
    const note = el("div", "note", `<p>No pins on this page</p><button class="btn" data-a="native">Show normal Pinterest</button>`);
    note.hidden = true;
    const box = el("div", "box");
    box.hidden = true;
    const sugg = el("div", "sugg");
    sugg.hidden = true;
    sugg.id = "pf-sugg";
    sugg.setAttribute("role", "listbox");
    sugg.setAttribute("aria-label", "Search suggestions");
    const toast = el("div", "toast");
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    // the shared quick-actions overlay that the field moves onto the hovered pin
    const qa = el("span", "qa", `
      <span class="qa-top">
        <span class="q board" data-q="board" role="button" title="Choose a board"><span></span>${I.chev}</span>
        <span class="q save" data-q="save" role="button">Save</span>
      </span>
      <span class="qa-bot">
        <span class="q ic" data-q="visit" role="button" title="Visit site" aria-label="Visit site">${I.visit}</span>
        <span class="grow"></span>
        <span class="q ic" data-q="share" role="button" title="Copy link" aria-label="Copy link">${I.share}</span>
        <span class="q ic" data-q="more" role="button" title="More" aria-label="More">${I.more}</span>
      </span>`);

    const sel = el("div", "glass grp sel", `<span class="in"></span>`);
    sel.setAttribute("role", "toolbar");
    sel.setAttribute("aria-label", "Select pins");

    root.append(load, note, boards, box, dock, corner, sel, tune, menu, sugg, toast);
    ui = { root, dock, corner, sel, tune, menu, boards, load, note, box, sugg, toast, qa };
    applyBg(getBg());

    const input = dock.querySelector("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "pf-sugg");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("autocomplete", "off");
    dock.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const sel = sugg.querySelector('[aria-selected="true"]');
      search(sel ? sel.dataset.g : input.value);
    });
    input.addEventListener("focus", () => openSugg());
    input.addEventListener("click", () => { if (ui.sugg.hidden) openSugg(); });
    input.addEventListener("input", () => openSugg());

    root.addEventListener("click", onUiClick);
    tune.querySelector(".sw.custom input").addEventListener("input", (e) => applyBg(e.target.value));
    box.addEventListener("click", (e) => { if (e.target === box || e.target.tagName === "IMG") closeLightbox(); });

    if (!keyGuard) {
      keyGuard = true;
      // keep Pinterest's own keyboard shortcuts from eating what you type in our UI
      for (const t of ["keydown", "keyup", "keypress"]) {
        addEventListener(t, (e) => {
          if (!host) return;
          const path = e.composedPath();
          if (!path.some((n) => n === ui.dock || n === ui.corner || n === ui.sel || n === ui.box || n === ui.menu || n === ui.tune || n === ui.boards || n === ui.sugg)) return;
          // stopping here also stops listeners inside our own UI, so the search box's keys are handled first
          if (t === "keydown" && path[0] === ui.dock.querySelector("input")) searchKey(e);
          e.stopPropagation();
        }, true);
      }
    }

    field = new Field(root, {
      quickEl: qa,
      onNeedMore: needMore,
      onOpen: (pin, tile) => (selecting ? toggleSelect(pin) : openBox(pin, tile)),
      onQuick: (name, pin, tile, btn) => (selecting ? toggleSelect(pin) : quick(name, pin, tile, btn)),
      isSelected: (id) => selected.has(id),
      onHover: dressQuick,
      onCamera: (c) => { const r = routes.get(cur); if (r) r.camera = { x: c.x, y: c.y, z: c.z }; },
      onMove: (m) => {
        root.toggleAttribute("data-moving", m);
        // scrolling the field: popovers close, and an open pin steps aside so the grid around it comes clear
        // the cards around an open pin come clear as soon as you move the field
        if (m) { closePops(); field && field.stage.removeAttribute("data-focus"); }
      },
      onLevel: (l) => { root.dataset.ql = String(l); },
    });
    root.insertBefore(field.stage, root.firstChild);
    field.setQuality(lsGet(LS.q, "auto"));
    markQuality();
    if (!canSave()) dock.querySelector('[data-a="boards"]').hidden = true;
    else dressAccount();
    markNav();
    renderGuides();
    document.documentElement.appendChild(host);
    sel.style.setProperty("--cw", corner.offsetWidth + "px");
    renderSel();
    moveLens();
    hidePage(true);
  }

  function unmount() {
    if (!host) return;
    boxPin = null; openHere = null;
    selecting = false; selected.clear(); clearTimeout(selT); selNote = null;
    field.destroy();
    host.remove();
    host = field = null;
    ui = {};
    for (const r of routes.values()) r.world = null;
    hidePage(false);
  }

  let hideStyle = null;
  function hidePage(on) {
    if (on && !hideStyle) {
      hideStyle = document.createElement("style");
      hideStyle.textContent = "body{visibility:hidden!important}html{scrollbar-width:none}";
      document.documentElement.appendChild(hideStyle);
    } else if (!on && hideStyle) { hideStyle.remove(); hideStyle = null; }
    sleepPage();
  }
  // Once Pinfield can load this feed's next pages itself, Pinterest's hidden page has nothing left to do:
  // skip its layout, painting and image decoding entirely (it was rendering a second copy of the feed under the field).
  const feedKeys = new Set();
  let sleepStyle = null;
  function sleepPage() {
    const on = !!host && feedKeys.has(cur);
    if (on && !sleepStyle) {
      sleepStyle = document.createElement("style");
      sleepStyle.textContent = "body{content-visibility:hidden!important}body *{animation:none!important;transition:none!important}";
      document.documentElement.appendChild(sleepStyle);
    } else if (!on && sleepStyle) { sleepStyle.remove(); sleepStyle = null; }
  }
  // put it to sleep only once loading pages directly has been seen to work for this page; wake it if that stops
  function feedWorks(key, ok) {
    if (ok) feedKeys.add(key); else feedKeys.delete(key);
    sleepPage();
  }

  // ---------- UI events ----------
  function onUiClick(e) {
    const t = e.target;
    const bg = t.closest("[data-bg]");
    if (bg) return applyBg(bg.dataset.bg);
    const qm = t.closest("[data-qm]");
    if (qm) { lsSet(LS.q, qm.dataset.qm); field.setQuality(qm.dataset.qm); return markQuality(); }
    const mi = t.closest("[data-mi]");
    if (mi) return menuAction(mi.dataset.mi);
    const bd = t.closest("[data-board]");
    if (bd) return pickBoard(bd.dataset.board === "" ? null : bd.dataset.board, bd.dataset.name || null);
    const gd = t.closest("[data-g]");
    if (gd) return search(gd.dataset.g);
    const rm = t.closest("[data-forget]");
    if (rm) { forgetRecent(); return openSugg(); }
    const xg = t.closest("[data-xg]");
    if (xg) { closeAll(); return search(xg.dataset.xg); }
    const xp = t.closest("[data-xp]");
    if (xp) { const p = exFresh[+xp.dataset.xp]; if (p) { toggleBoards(false); openBox(p); } return; }
    const bc = t.closest("[data-bc]");
    if (bc) { closeAll(); return goTo(bc.dataset.bc); }
    const a = t.closest("[data-a]");
    if (!a) return;
    const act = a.dataset.a;
    if (act === "home") { closeAll(); goTo("/"); }
    else if (act === "explore") toggleExplore();
    else if (act === "ex-field") { closeAll(); goTo("/ideas/"); }
    else if (act === "back") { closeAll(); history.back(); }
    else if (act === "boards") toggleBoards();
    else if (act === "create") { setOn(false); location.assign("/pin-creation-tool/"); }
    else if (act === "native") setOn(false);
    else if (act === "tune") togglePop(ui.tune, a);
    else if (act === "sel-on") setSelecting(true);
    else if (act === "sel-off") setSelecting(false);
    else if (act === "sel-dl") downloadSelected();
    else if (act === "lb-close") closeLightbox();
    else if (act.startsWith("box-")) boxAction(act.slice(4), a);
    else if (act === "acct-created") { closeAll(); goTo("/" + account.username + "/_created/"); }
    else if (act === "acct-share") {
      const url = "https://www.pinterest.com/" + account.username + "/";
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast("Profile link copied"), () => toast("Couldn't copy the link"));
    }
    else if (act === "acct-native" || act === "acct-create") { setOn(false); location.assign("/" + account.username + "/"); }
  }

  function markQuality() {
    const m = lsGet(LS.q, "auto");
    for (const b of ui.tune.querySelectorAll("[data-qm]")) b.setAttribute("aria-pressed", String(b.dataset.qm === m));
  }
  // ---------- search: Pinterest's autocomplete as you type; its refinements and your recent searches on focus ----------
  const LS_RECENT = "pinfield:recent";
  const recent = () => lsJson(LS_RECENT, []).filter((x) => typeof x === "string").slice(0, 8);
  const forgetRecent = () => lsSet(LS_RECENT, "[]");
  // a search on its way: fade the old results and show the dots until the new ones are in
  let busyT = 0;
  function setBusy(on) {
    if (!ui.root) return;
    clearTimeout(busyT);
    ui.root.toggleAttribute("data-busy", on);
    if (on) { ui.load.hidden = false; busyT = setTimeout(() => setBusy(false), 12000); }
  }
  function search(q) {
    q = String(q || "").trim();
    if (!q) return;
    lsSet(LS_RECENT, JSON.stringify([q, ...recent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8)));
    closeSugg();
    const input = ui.dock.querySelector("input");
    input.value = q;
    input.blur();
    closeAll();
    const path = "/search/pins/?q=" + encodeURIComponent(q);
    setBusy(true);
    // in-app through Pinterest's own search box (no reload); a normal page load if that doesn't work
    api("search", { q }).catch(() => goTo(path));
  }

  let suggSeq = 0, suggT = 0;
  function openSugg() {
    const input = ui.dock.querySelector("input");
    const term = input.value.trim();
    const here = new URLSearchParams(location.search).get("q") || "";
    clearTimeout(suggT);
    if (term && term.toLowerCase() !== here.toLowerCase()) {
      // typing: ask Pinterest, but only once the typing pauses, and ignore answers that arrive late
      const seq = ++suggSeq;
      suggT = setTimeout(() => {
        api("typeahead", { term }).then((items) => {
          if (seq !== suggSeq || document.activeElement !== host || !items.length) return;
          drawSugg(`<h3>Suggestions</h3>` + items.map((x) => `<button class="sg" role="option" data-g="${esc(x.query)}">${I.search}<span>${boldMatch(x.label, term)}</span></button>`).join(""));
        }, () => {});
      }, 140);
      return;
    }
    ++suggSeq;
    const guides = location.pathname.startsWith("/search") ? route(cur).guides : null;
    const rec = recent();
    let html = "";
    if (guides && guides.length) {
      html += `<h3>Refine "${esc(here)}"</h3><div class="chips">` +
        guides.slice(0, 12).map((x) => `<button class="chip" role="option" data-g="${esc(x.term)}"><i style='background-image:${cssUrl(x.img)};${x.color ? "background-color:" + x.color : ""}'></i>${esc(x.label)}</button>`).join("") + `</div>`;
    }
    if (rec.length) {
      html += `<h3>Recent searches</h3>` + rec.map((q) => `<button class="sg" role="option" data-g="${esc(q)}">${I.back}<span>${esc(q)}</span></button>`).join("") +
        `<button class="sg" data-forget="1"><span style="color:var(--muted)">Clear recent searches</span></button>`;
    }
    html ? drawSugg(html) : closeSugg();
  }
  function searchKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSugg(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Escape") { closeSugg(); e.target.blur(); }
  }
  function boldMatch(label, term) {
    const i = label.toLowerCase().indexOf(term.toLowerCase());
    if (i < 0) return esc(label);
    return esc(label.slice(0, i)) + esc(label.slice(i, i + term.length)) + "<b>" + esc(label.slice(i + term.length)) + "</b>";
  }
  function drawSugg(html) {
    const s = ui.sugg, input = ui.dock.querySelector("input");
    s.innerHTML = html;
    s.hidden = false;
    input.setAttribute("aria-expanded", "true");
    const r = input.getBoundingClientRect();
    const w = s.offsetWidth;
    s.style.left = Math.min(innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2)) + "px";
    s.style.top = Math.max(12, r.top - s.offsetHeight - 14) + "px";
  }
  function closeSugg() {
    if (!ui.sugg) return;
    ++suggSeq;
    clearTimeout(suggT);
    ui.sugg.hidden = true;
    ui.dock.querySelector("input").setAttribute("aria-expanded", "false");
  }
  function moveSugg(d) {
    const items = [...ui.sugg.querySelectorAll("[data-g]")];
    if (ui.sugg.hidden || !items.length) return;
    let i = items.findIndex((x) => x.getAttribute("aria-selected") === "true");
    if (i >= 0) items[i].removeAttribute("aria-selected");
    i = (i + d + items.length + 1) % (items.length + 1); // one past the end = back to what you typed
    if (i < items.length) { items[i].setAttribute("aria-selected", "true"); items[i].scrollIntoView({ block: "nearest" }); }
  }
  addEventListener("pointerdown", (e) => {
    if (!ui.sugg || ui.sugg.hidden) return;
    const p = e.composedPath();
    if (!p.includes(ui.sugg) && !p.includes(ui.dock.querySelector("form"))) closeSugg();
  }, true);

  function renderGuides() {
    // refinements now live in the search box's dropdown; refresh it if it's open
    if (ui.sugg && !ui.sugg.hidden && !ui.dock.querySelector("input").value.trim().length) openSugg();
  }

  function markNav() {
    if (!ui.dock) return;
    const p = location.pathname;
    const set = (a, on) => { const b = ui.dock.querySelector(`[data-a="${a}"]`); if (b) on ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"); };
    const mode = ui.boards && !ui.boards.hidden ? ui.boards.dataset.mode : null;
    set("home", p === "/" && !mode);
    set("explore", mode === "explore" || (!mode && p.startsWith("/ideas")));
    if (mode !== "account") ui.dock.querySelector('[data-a="boards"]').removeAttribute("aria-current");
    const board = /^\/[^/]+\/[^/]+\/$/.test(p) && !/^\/(search|ideas|today|pin|settings|_)/.test(p);
    ui.dock.querySelector('[data-a="back"]').hidden = !(pinIdOf(p) || board) || history.length < 2;
    const q = new URLSearchParams(location.search).get("q");
    const input = ui.dock.querySelector("input");
    if (p.startsWith("/search") && q && document.activeElement !== input) input.value = q;
    moveLens();
  }

  // the selected tab sits on a darker glass lens that slides, and stretches a little, between tabs
  function moveLens() {
    const g = ui.dock.querySelector(".tabbar"), lens = g.querySelector(".lens");
    if (!g.isConnected) return; // measured once the dock is on the page
    const a = g.querySelector(".ib[aria-current]:not([hidden])");
    if (!a) { lens.classList.remove("on"); return; }
    const x = a.offsetLeft;
    const from = lens.dataset.x;
    if (lens.classList.contains("on") && from != null && +from !== x && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      lens.animate([
        { transform: `translateX(${from}px)` },
        { transform: `translateX(${(+from + x) / 2}px) scale(1.28,.9)`, offset: 0.45 },
        { transform: `translateX(${x}px)` },
      ], { duration: 420, easing: "cubic-bezier(.3,.7,.2,1)" });
    }
    lens.style.transform = `translateX(${x}px)`;
    lens.dataset.x = String(x);
    lens.classList.add("on");
  }

  // ---------- popovers ----------
  let popAnchor = null;
  function placePop(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    pop.hidden = false;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let x = Math.min(innerWidth - pw - 12, Math.max(12, r.left + r.width / 2 - pw / 2));
    let y = r.top - ph - 10;
    if (y < 12) y = Math.min(innerHeight - ph - 12, r.bottom + 10);
    pop.style.left = x + "px";
    pop.style.top = y + "px";
  }
  function togglePop(pop, anchor, force) {
    const open = force === undefined ? pop.hidden || popAnchor !== anchor : force;
    for (const p of [ui.tune, ui.menu]) if (p !== pop) p.hidden = true;
    if (!open) { pop.hidden = true; popAnchor = null; return; }
    popAnchor = anchor;
    placePop(pop, anchor);
    if (anchor.hasAttribute("aria-expanded")) anchor.setAttribute("aria-expanded", "true");
    const f = pop.querySelector("input:not([type=color]),[aria-pressed=true],button,.mi,.bd");
    if (f) f.focus({ preventScroll: true });
  }
  function closePops() {
    if (!ui.tune) return;
    ui.tune.hidden = ui.menu.hidden = true;
    popAnchor = null;
    const t = ui.corner.querySelector('[data-a="tune"]');
    t && t.setAttribute("aria-expanded", "false");
  }
  addEventListener("wheel", (e) => {
    if (!ui.tune || !popAnchor) return;
    const path = e.composedPath();
    if (!path.includes(ui.tune) && !path.includes(ui.menu)) closePops();
  }, { capture: true, passive: true });
  addEventListener("pointerdown", (e) => {
    if (!ui.tune || !popAnchor) return;
    const path = e.composedPath();
    if (!path.includes(ui.tune) && !path.includes(ui.menu) && !path.includes(popAnchor)) closePops();
  }, true);

  function toast(msg, thumb) {
    const t = ui.toast;
    if (!t) return;
    t.innerHTML = (thumb ? `<i style='background-image:${cssUrl(thumb)}'></i>` : "") + `<span>${esc(msg)}</span>`;
    t.hidden = false;
    clearTimeout(t.__h);
    t.__h = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- quick actions ----------
  let menuPin = null, menuTile = null;
  const lastBoard = () => lsJson(LS.board, null);

  function dressQuick(pin) {
    const qa = ui.qa;
    const signed = canSave() && /^\d+$/.test(pin.id);
    const b = qa.querySelector('[data-q="board"]'), s = qa.querySelector('[data-q="save"]');
    b.hidden = s.hidden = !signed;
    if (signed) {
      const lb = lastBoard();
      b.querySelector("span").textContent = lb ? lb.name : "Profile";
      s.textContent = saved.has(pin.id) ? "Saved" : "Save";
      s.toggleAttribute("data-done", saved.has(pin.id));
    }
    qa.querySelector('[data-q="visit"]').hidden = !pin.link;
    qa.querySelector('[data-q="share"]').hidden = !/^\d+$/.test(pin.id);
  }

  function quick(name, pin, tile, btn) {
    if (name === "save") return saved.has(pin.id) ? unsavePin(pin) : savePin(pin, lastBoard());
    if (name === "board") return openBoardPicker(pin, btn);
    if (name === "visit") return pin.link && window.open(pin.link, "_blank", "noopener,noreferrer");
    if (name === "share") return copyLink(pin);
    if (name === "more") {
      if (!ui.menu.hidden && popAnchor === btn) return closePops(); // the same button again closes it
      menuPin = pin; menuTile = tile;
      ui.menu.innerHTML = [
        `<button class="mi" data-mi="similar" role="menuitem">${I.similar}More like this</button>`,
        `<button class="mi" data-mi="download" role="menuitem">${I.download}Download image</button>`,
        /^\d+$/.test(pin.id) ? `<button class="mi" data-mi="copy" role="menuitem">${I.link}Copy link</button>` : "",
        `<button class="mi" data-mi="hide" role="menuitem">${I.hide}Hide this pin</button>`,
      ].join("");
      togglePop(ui.menu, btn, true);
    }
  }

  function menuAction(id) {
    const pin = menuPin, tile = menuTile;
    closePops();
    if (!pin) return;
    if (id === "similar") openSimilar(pin, tile);
    else if (id === "download") download(pin);
    else if (id === "copy") copyLink(pin);
    else if (id === "hide") hidePin(pin, tile);
  }

  function copyLink(pin) {
    const url = "https://www.pinterest.com/pin/" + pin.id + "/";
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(() => toast("Link copied"), () => toast("Couldn't copy the link"));
  }

  function download(pin) {
    api("download", { url: pin.src.o || pin.src.l, name: "pin-" + pin.id })
      .catch(() => api("download", { url: pin.src.l, name: "pin-" + pin.id }))
      .then(() => toast("Downloaded"), () => toast("Couldn't download this one"));
  }

  // ---------- select mode: pick pins, then save them all into one folder ----------
  function setSelecting(on) {
    if (!field) return;
    selecting = on;
    if (!on) selected.clear();
    clearTimeout(selT);
    selNote = null;
    field.stage.toggleAttribute("data-select", on);
    field.markSelected();
    if (on) closePops();
    renderSel();
  }

  function toggleSelect(pin) {
    if (selNote) return; // saving
    const p = seen.get(pin.id) || pin;
    if (selected.has(p.id)) selected.delete(p.id);
    else selected.set(p.id, p);
    field.markSelected();
    renderSel();
  }

  function renderSel() {
    const s = ui.sel;
    if (!s) return;
    const inner = s.querySelector(".in");
    const root = s.getRootNode();
    const hadFocus = !!root.activeElement && s.contains(root.activeElement);
    const n = selected.size;
    let say;
    if (selNote) {
      say = selNote.text;
      inner.innerHTML = `<span class="lbl">${selNote.icon || ""}${esc(say)}</span>`;
    } else if (!selecting) {
      say = "";
      inner.innerHTML = `<button class="sb" data-a="sel-on" title="Select pins to download">${I.check}Select</button>`;
    } else {
      say = n ? n + " selected" : "Click pins to select them";
      inner.innerHTML = `<span class="lbl">${n ? n + " selected" : "Click pins"}</span>` +
        (n ? `<button class="sb dl" data-a="sel-dl" title="Save the selected pins into one folder">${I.download}Download</button>` : "") +
        `<span class="sep" aria-hidden="true"></span><button class="sb" data-a="sel-off" title="Cancel (Esc)">Cancel</button>`;
    }
    // one live region that stays put, so screen readers hear each change
    let live = s.querySelector(".sr");
    if (!live) { live = el("span", "sr"); live.setAttribute("role", "status"); s.append(live); }
    live.textContent = say;
    s.style.width = inner.offsetWidth + 10 + "px"; // + the group's padding; a fixed width is what lets it animate
    if (hadFocus) {
      const b = inner.querySelector('[data-a="sel-dl"],[data-a="sel-off"],[data-a="sel-on"]');
      if (b) b.focus({ preventScroll: true });
      else field && field.stage.focus({ preventScroll: true });
    }
  }

  // the folder inside Downloads/Pinfield: the board or search you're on, and when
  function batchFolder() {
    const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
    const path = location.pathname, pid = pinIdOf(path);
    let name = "";
    if (path.startsWith("/search/")) name = new URLSearchParams(location.search).get("q") || "";
    else if (pid) name = "pin " + pid;
    else {
      const m = path.match(/^\/([\w.-]+)\/([\w%.-]+)\/?$/); // /username/board/
      if (m && m[1] !== "ideas" && !m[2].startsWith("_")) { try { name = decodeURIComponent(m[2]).replace(/-/g, " "); } catch {} }
    }
    return (name ? name.trim().slice(0, 60) + " " : "") + stamp;
  }

  // the largest picture there is: the original if Pinterest has one for this pin, else 736px
  const pinimg = (u) => typeof u === "string" && /^https:\/\/i\.pinimg\.com\//.test(u);
  async function bestUrl(p) {
    const o = pinimg(p.src.o) ? p.src.o : null, l = pinimg(p.src.l) ? p.src.l : null;
    if (!o || o === l) return l;
    if (!l) return o;
    try { return (await api("probe", { url: o })) ? o : l; } catch { return o; }
  }
  async function eachLimit(xs, n, fn) {
    const out = new Array(xs.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); }
    }));
    return out;
  }

  const ext = globalThis.browser || globalThis.chrome;
  async function downloadSelected() {
    const pins = [...selected.values()];
    if (!pins.length || selNote) return;
    selNote = { text: "Saving " + pins.length + "…" };
    renderSel();
    let res = null;
    try {
      // video pins: their cover picture is saved (p.src), not the video
      const files = (await eachLimit(pins, 4, async (p) => ({ id: p.id, url: await bestUrl(p) }))).filter((f) => f.url);
      res = await ext.runtime.sendMessage({ type: "pf:download", folder: batchFolder(), files });
    } catch {}
    if (!selecting) return; // left select mode (or Pinfield) meanwhile
    const ok = (res && res.ok) || 0, failed = pins.length - ok;
    selNote = !ok ? { text: "Couldn't download these" }
      : { icon: I.check, text: failed ? `Saved ${ok}, ${failed} didn't download` : `Saved ${ok} to Downloads/Pinfield` };
    renderSel();
    // saved: a moment to read it, then select mode ends. Nothing saved: back to the selection to try again
    selT = setTimeout(() => { if (ok) setSelecting(false); else { selNote = null; renderSel(); } }, ok ? 2200 : 2600);
  }

  function hidePin(pin, tile) {
    hidden.add(pin.id);
    lsSet(LS.hidden, JSON.stringify([...hidden].slice(-2000)));
    const r = routes.get(cur);
    if (r) { r.ids.delete(pin.id); r.pins = r.pins.filter((p) => p.id !== pin.id); }
    const w = r && r.world;
    if (w && tile && w.replace(tile.i)) field.refreshIndex(tile.i);
    else if (tile && field) for (const e of field.live.values()) if (e.item.id === pin.id) e.el.style.opacity = "0";
    toast("Pin hidden");
  }

  async function savePin(pin, board) {
    if (!canSave()) return toast("Sign in to Pinterest to save");
    try {
      const res = await api("save", { pinId: pin.id, boardId: board ? board.id : null });
      const where = board ? board.name : res.board || "Profile";
      savedMap.set(pin.id, { id: res.id, board: where });
      keepSaved();
      if (board) lsSet(LS.board, JSON.stringify(board));
      noteBoard(board ? board.id : null);
      afterSaveChange(pin, "Saved to " + where);
    } catch (err) {
      toast("Couldn't save: " + (err.message || "try again"));
    }
  }
  // a second press on a saved pin takes it back off the board, as on Pinterest
  async function unsavePin(pin) {
    const s = savedMap.get(pin.id);
    if (!s) return;
    try {
      await api("unsave", { savedId: s.id });
      savedMap.delete(pin.id);
      keepSaved();
      afterSaveChange(pin, "Removed from " + s.board);
    } catch (err) {
      toast("Couldn't remove it: " + (err.message || "try again"));
    }
  }
  function afterSaveChange(pin, msg) {
    if (field) field.rehover();
    // on an open pin the note slides out beside the pin button, then goes; elsewhere it's a toast
    if (boxPin && boxPin.id === pin.id) { renderBoxActions(); flashRail(msg); }
    else toast(msg, pin.src.s);
  }
  let flashT = 0;
  function flashRail(msg) {
    const btn = field && field.hero && field.hero.querySelector('[data-a="box-save"]');
    if (!btn) return toast(msg);
    const acts = btn.closest(".acts");
    let tag = acts.querySelector(".tag");
    if (!tag) { tag = el("span", "tag glass"); tag.setAttribute("role", "status"); acts.append(tag); }
    tag.textContent = msg;
    tag.style.top = btn.closest(".grp").offsetTop + btn.offsetTop + 6 + "px";
    tag.classList.remove("on");
    void tag.offsetWidth;
    tag.classList.add("on");
    clearTimeout(flashT);
    flashT = setTimeout(() => tag.classList.remove("on"), 2400);
  }

  // ---------- enlarge: the pin full size, over everything ----------
  function openLightbox(p) {
    const b = ui.box;
    b.innerHTML = "";
    const img = el("img");
    img.alt = p.title || "";
    img.src = p.src.l;
    const big = new Image();
    big.src = p.src.o;
    big.decode().then(() => { if (img.isConnected) img.src = p.src.o; }, () => {});
    const x = el("button", "ib glass", I.close);
    x.dataset.a = "lb-close";
    x.title = "Close (Esc)";
    x.setAttribute("aria-label", "Close");
    b.append(img, x);
    b.setAttribute("role", "dialog");
    b.setAttribute("aria-label", "Enlarged pin");
    b.hidden = false;
    x.focus({ preventScroll: true });
  }
  function closeLightbox() {
    if (!ui.box || ui.box.hidden) return false;
    ui.box.hidden = true;
    ui.box.innerHTML = "";
    return true;
  }

  // ---------- boards ----------
  let boardsCache = null;
  function loadBoards() {
    if (!account.username) return Promise.reject(new Error("no username"));
    if (!boardsCache) boardsCache = api("boards", { username: account.username }).catch((e) => { boardsCache = null; throw e; });
    return boardsCache;
  }

  let pickPin = null;
  // when you last saved to each board here (Pinterest's list order isn't "last saved to")
  const LS_BT = "pinfield:boardtimes";
  const boardTimes = () => lsJson(LS_BT, {});
  function noteBoard(id) { const t = boardTimes(); t[id || "profile"] = Date.now(); lsSet(LS_BT, JSON.stringify(t)); }
  const lastSaved = (b, t) => Math.max(t[b.id] || 0, Date.parse(b.last || "") || 0);
  function openBoardPicker(pin, anchor) {
    // the same button again closes it
    if (!ui.menu.hidden && popAnchor === anchor && pickPin === pin) return closePops();
    pickPin = pin;
    const m = ui.menu;
    m.innerHTML = `<div class="bp"><input type="search" placeholder="Search boards" aria-label="Search boards"><div class="list" role="listbox"><div class="load" style="position:static;height:60px"><i></i><i></i><i></i></div></div></div>`;
    togglePop(m, anchor, true);
    const list = m.querySelector(".list"), input = m.querySelector("input");
    const draw = (all) => {
      const q = input.value.trim().toLowerCase();
      const t = boardTimes();
      // last saved to first, like a stack; Profile takes its place by when you last saved there
      const rows = [{ id: "", name: "Profile", profile: true }, ...all]
        .map((b, i) => ({ b, i, at: b.profile ? t.profile || 0 : lastSaved(b, t) }))
        .filter((x) => !q || x.b.name.toLowerCase().includes(q))
        .sort((x, y) => y.at - x.at || x.i - y.i)
        .map((x) => x.b);
      list.innerHTML = rows.map((b) => b.profile
        ? `<button class="bd" data-board="" data-name="Profile" role="option"><i>${I.native}</i><span>Profile</span></button>`
        : `<button class="bd" data-board="${esc(b.id)}" data-name="${esc(b.name)}" role="option"><i style='background-image:${cssUrl(b.cover)}'></i><span>${esc(b.name)}</span></button>`).join("");
    };
    loadBoards().then((all) => { input.oninput = () => draw(all); draw(all); placePop(m, anchor); },
      () => { list.innerHTML = `<button class="bd" data-board="" data-name="Profile"><i>${I.native}</i><span>Profile</span></button>`; });
  }
  function pickBoard(id, name) {
    closePops();
    if (pickPin) savePin(pickPin, id ? { id, name } : null);
  }

  // ---------- account page: your profile and boards ----------
  let profileCache = null;
  function loadProfile() {
    if (!account.username) return Promise.reject(new Error("no username"));
    if (!profileCache) profileCache = api("profile", { username: account.username }).catch((e) => { profileCache = null; throw e; });
    return profileCache;
  }
  // the dock's account button shows your own picture once Pinterest tells us what it is
  function dressAccount() {
    const b = ui.dock && ui.dock.querySelector('[data-a="boards"]');
    if (!b || !canSave()) return;
    loadProfile().then((p) => { if (p.avatar && b.isConnected) b.innerHTML = `<span class="me" style='background-image:${cssUrl(p.avatar)}'></span>`; }, () => {});
  }

  const SORTS = { last: "Last saved to", az: "A to Z", most: "Most pins" };
  function toggleBoards(force) {
    const b = ui.boards;
    const open = force === undefined ? b.hidden || b.dataset.mode !== "account" : force;
    b.hidden = !open;
    ui.dock.querySelector('[data-a="boards"]').toggleAttribute("aria-current", open);
    if (!open) { delete b.dataset.mode; return markNav(); }
    b.dataset.mode = "account";
    markNav();
    b.innerHTML = `<div class="load"><i></i><i></i><i></i></div>`;
    Promise.all([loadProfile().catch(() => null), loadBoards()]).then(([p, all]) => drawAccount(p, all), () => {
      b.innerHTML = `<div class="note"><p>Couldn't load your boards</p><button class="btn" data-a="native">Open Pinterest</button></div>`;
    });
  }

  function drawAccount(p, all) {
    const b = ui.boards, u = account.username;
    const sort = lsGet("pinfield:bsort", "last");
    const list = all.filter((x) => x.url).slice();
    if (sort === "az") list.sort((a, c) => a.name.localeCompare(c.name));
    else if (sort === "most") list.sort((a, c) => c.count - a.count);
    const n = (v) => Number(v || 0).toLocaleString();
    b.innerHTML = `
      <header class="acct">
        <div class="av" ${p && p.avatar ? `style='background-image:${cssUrl(p.avatar)}'` : ""}>${p && p.avatar ? "" : I.person}</div>
        <h2>${esc((p && p.name) || u)}</h2>
        <div class="handle">@${esc(u)}</div>
        ${p ? `<div class="stats">${n(p.followers)} followers · ${n(p.following)} following</div>` : ""}
        <div class="row">
          <button class="btn" data-a="acct-share">Share</button>
          <button class="btn" data-a="acct-native">Edit profile</button>
        </div>
      </header>
      <nav class="tabs" aria-label="Profile">
        <button class="tab" data-a="acct-created">Created</button>
        <button class="tab" aria-current="page">Saved</button>
      </nav>
      <div class="tools">
        <label><span class="sr">Sort boards</span><select data-sort>${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === sort ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <button class="btn" data-a="acct-create" title="Create a board on Pinterest">+ Create board</button>
      </div>
      <div class="bgrid">${list.map(boardCard).join("")}</div>`;
    b.querySelector("[data-sort]").addEventListener("change", (e) => { lsSet("pinfield:bsort", e.target.value); drawAccount(p, all); });
    const first = b.querySelector(".cover");
    first && first.focus({ preventScroll: true });
  }

  // one board, as drawn: big cover, name with Public/Secret, then a strip of its pins and "View all"
  function boardCard(x) {
    const url = esc(x.url), name = esc(x.name);
    // previews other than the cover; when Pinterest sends none, the strip keeps only "View all"
    const rest = x.thumbs.filter((t) => t !== x.cover);
    const stack = rest.slice(0, 5).map((t) => `<b style='background-image:${cssUrl(t)}'></b>`).join("");
    return `<article class="bcard">
      <button class="cover" data-bc="${url}" aria-label="${name}" style='background-image:${cssUrl(x.cover)}'></button>
      <div class="meta"><span class="nm">${name}</span><span class="badge">${x.privacy}</span></div>
      <div class="strip">
        ${stack ? `<button class="stack" data-bc="${url}" aria-label="Pins in ${name}" tabindex="-1">${stack}</button>` : ""}
        <button class="all" data-bc="${url}">${I.create}<span>View all<small>${x.count.toLocaleString()} pins</small></span></button>
      </div>
    </article>`;
  }

  // ---------- explore: what Pinterest's own Explore page shows ----------
  // Today's stories (signed in), trending topics, interests, Pinterest's curated boards, what's new.
  let exploreCache = null, exFresh = [];
  function loadExplore() {
    if (!exploreCache || Date.now() - exploreCache.t > 10 * 60 * 1000) {
      const p = api("explore", { signed: canSave() });
      exploreCache = { t: Date.now(), p: p.catch((e) => { exploreCache = null; throw e; }) };
    }
    return exploreCache.p;
  }
  function toggleExplore(force) {
    const b = ui.boards;
    const open = force === undefined ? b.hidden || b.dataset.mode !== "explore" : force;
    if (!open) return toggleBoards(false);
    closePops();
    b.hidden = false;
    b.dataset.mode = "explore";
    markNav();
    b.scrollTop = 0;
    b.innerHTML = `<div class="load"><i></i><i></i><i></i></div>`;
    loadExplore().then((d) => { if (b.dataset.mode === "explore") drawExplore(d); }, () => {
      if (b.dataset.mode !== "explore") return;
      b.innerHTML = `<div class="note"><p>Couldn't load Explore</p><button class="btn" data-a="ex-field">Browse ideas in the field</button></div>`;
    });
  }
  function drawExplore(d) {
    const b = ui.boards;
    exFresh = d.fresh || [];
    const day = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    const tile = (x, cls) => `<button class="${cls}" data-xg="${esc(x.title)}" aria-label="${esc(x.title)}"><i style='background-image:${cssUrl(x.img)};background-color:${/^#[0-9a-f]{6}$/i.test(x.color || "") ? x.color : "var(--ph)"}'></i><span>${esc(x.title)}</span></button>`;
    const sec = (title, body) => (body ? `<section><h3>${title}</h3>${body}</section>` : "");
    b.innerHTML = `<div class="ex">
      <header class="exh"><div class="day">${esc(day)}</div><h2>Stay inspired</h2></header>
      ${d.interests.length ? `<nav class="ints" aria-label="Interests">${d.interests.map((x) => `<button class="chip" data-xg="${esc(x.name)}">${esc(x.name)}</button>`).join("")}</nav>` : ""}
      ${d.stories.length ? `<div class="stories">${d.stories.map((x) => tile(x, "story")).join("")}</div>` : ""}
      ${sec("Popular on Pinterest", d.popular.length ? `<div class="pops">${d.popular.map((x) => tile(x, "topic")).join("")}</div>` : "")}
      ${sec("Explore featured boards", d.featured.length ? `<div class="fgrid">${d.featured.map(featCard).join("")}</div>` : "")}
      ${sec("What's new on Pinterest", exFresh.length ? `<div class="fresh">${exFresh.map((p, i) => `<button class="fp" data-xp="${i}" aria-label="Open pin" style='aspect-ratio:${p.w}/${p.h};background-image:${cssUrl(p.src.m)};background-color:${/^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : "var(--ph)"}'></button>`).join("")}</div>` : "")}
      <div class="exf"><button class="btn" data-a="ex-field">Browse ideas in the field</button></div>
    </div>`;
  }
  // Pinterest's featured-board card: one big picture beside two small ones
  function featCard(x) {
    const url = esc(x.url), name = esc(x.name);
    const imgs = [x.cover, ...x.thumbs.filter((t) => t !== x.cover)].slice(0, 3);
    return `<button class="fb" data-bc="${url}" aria-label="${name}">
      <span class="col">${imgs.map((t) => `<b style='background-image:${cssUrl(t)}'></b>`).join("")}</span>
      <span class="nm">${name}</span>
      <small>${x.owner ? esc(x.owner) + " · " : ""}${x.count.toLocaleString()} pins</small>
    </button>`;
  }

  // ---------- pin view ----------
  // An open pin is part of the grid: a big card at the centre, lined up with the bottom bar, its buttons in a
  // rail beside it, and Pinterest's related pins packed around both like any other cards. The cards around it
  // stay faded until you move the field. Signed in, this is the pin's own page (related pins from Pinterest);
  // signed out, Pinterest can't open pin pages, so the feed you're on is laid out around it instead.
  const RAIL_GAP = 14, RAIL_W = 58;
  let openHere = null; // signed out: the world to go back to on close

  function railButtons(p) {
    const num = /^\d+$/.test(p.id), signed = canSave() && num;
    const groups = [
      [["close", I.close, "Close (Esc)"]],
      signed ? [["save", I.pin, saved.has(p.id) ? "Saved to " + savedMap.get(p.id).board + ". Press to remove" : "Save"], ["board", I.boards, "Save to a board"]] : [],
      [
        num && ["share", I.share, "Copy link"],
        ["download", I.download, "Download image"],
        p.link && ["visit", I.visit, "Visit site"],
        num && ["native", I.native, "Open on Pinterest (comments and more)"],
      ].filter(Boolean),
    ].filter((g) => g.length);
    return groups;
  }
  const railHeight = (groups) => groups.reduce((h, g) => h + 10 + g.length * 48 + (g.length - 1) * 4, 0) + 10 * (groups.length - 1);

  function heroLayout(p) {
    const ratio = p.w > 0 && p.h > 0 ? p.h / p.w : 1.25;
    const maxH = innerHeight - 96 - 48; // between the top edge and the bottom bar
    // exactly three columns wide (one on a narrow window), so the grid's gaps around it stay even;
    // a tall pin is shown whole inside that, over a soft blur of itself
    const w = innerWidth >= 1000 ? 2 * 252 + 236 : 236;
    const h = Math.round(Math.max(Math.min(w * ratio, maxH), Math.min(360, w * ratio)));
    const rh = railHeight(railButtons(p));
    const card = { x0: -w / 2, x1: w / 2, y0: -h / 2, y1: h / 2 };
    const ry0 = Math.max(card.y0, -rh / 2);
    const rail = { x0: w / 2 + RAIL_GAP, x1: w / 2 + RAIL_GAP + RAIL_W, y0: ry0, y1: ry0 + rh };
    // the visible middle sits above the bottom bar, so the camera looks a little below the card's centre
    return { w, h, card, rail, focus: { x: 0, y: 45 } };
  }

  function heroWorld(p, pins, open) {
    const w = new World(salt ^ hashStr("pin:" + p.id));
    const L = heroLayout(p);
    w.block(L.card);
    w.block(L.rail);
    w.focus = L.focus;
    w.hero = { pin: p, L };
    w.open = open;
    w.add(pins.filter((x) => x.id !== p.id && !hidden.has(x.id)));
    w.seedSpiral(Math.min(w.items.length, 120));
    return w;
  }

  function heroEl(p, L) {
    const h = el("div", "hero");
    h.style.width = L.w + "px";
    h.style.height = L.h + "px";
    const card = el("div", "card");
    card.setAttribute("aria-label", p.title || "Pin");
    const media = el("div", "media");
    if (p.color) media.style.background = p.color;
    const ratio = p.w > 0 && p.h > 0 ? p.h / p.w : 1.25;
    if (Math.abs(L.h / L.w - ratio) > 0.02) {
      const bg = el("img", "bg");
      bg.alt = "";
      bg.src = p.src.m;
      media.append(bg);
    }
    const img = el("img");
    img.alt = p.title || "";
    img.src = p.src.l;
    media.append(img);
    if (p.video) {
      const v = el("video");
      v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.controls = true;
      v.poster = p.src.l;
      v.src = p.video.url;
      v.addEventListener("loadeddata", () => img.remove());
      v.addEventListener("error", () => v.remove());
      media.prepend(v);
    } else {
      const big = new Image();
      big.decoding = "async";
      big.src = p.src.o;
      big.decode().then(() => { if (img.isConnected) img.src = p.src.o; }, () => {});
    }
    const zoom = el("button", "ib glass zoom", I.expand);
    zoom.dataset.ui = "";
    zoom.dataset.a = "box-zoom";
    zoom.title = "Enlarge";
    zoom.setAttribute("aria-label", "Enlarge");
    card.append(media, zoom);
    const acts = el("div", "acts");
    acts.dataset.ui = "";
    acts.setAttribute("role", "toolbar");
    acts.setAttribute("aria-label", "Pin actions");
    acts.style.left = L.w + RAIL_GAP + "px";
    acts.style.top = L.rail.y0 - L.card.y0 + "px";
    h.append(card, acts);
    return h;
  }

  function showHero(w) {
    if (!field || !w.hero) return;
    const { pin, L } = w.hero;
    boxPin = pin;
    field.setHero(heroEl(pin, L), L.card.x0, L.card.y0);
    renderBoxActions();
  }

  function openBox(pin) {
    closePops();
    const p = seen.get(pin.id) || pin;
    if (/^\d+$/.test(p.id)) {
      if (pinIdOf(location.pathname) === p.id) return;
      boxPin = p;
      return goTo("/pin/" + p.id + "/"); // the pin's page: built the moment we get there, related pins fill in
    }
    const r = route(cur);
    if (!openHere) openHere = { key: cur, world: r.world, camera: field.camera() };
    const w = heroWorld(p, r.pins, false);
    field.setWorld(w, {});
    showHero(w);
  }

  function renderBoxActions() {
    const side = field && field.hero && field.hero.querySelector(".acts");
    if (!side || !boxPin) return;
    side.innerHTML = railButtons(boxPin).map((g) => `<div class="glass grp">` + g.map(([a, icon, title]) =>
      `<button class="ib${a === "save" ? " save" : ""}" data-a="box-${a}" title="${esc(title)}" aria-label="${esc(title)}" ${a === "save" && saved.has(boxPin.id) ? "data-done" : ""}>${icon}</button>`).join("") + `</div>`).join("");
  }

  function boxAction(a, btn) {
    const p = boxPin;
    if (!p) return;
    if (a === "close") closeBox();
    else if (a === "save") saved.has(p.id) ? unsavePin(p) : savePin(p, lastBoard());
    else if (a === "zoom") openLightbox(p);
    else if (a === "board") openBoardPicker(p, btn);
    else if (a === "share") copyLink(p);
    else if (a === "download") download(p);
    else if (a === "visit") window.open(p.link, "_blank", "noopener,noreferrer");
    else if (a === "native") { setOn(false); goTo("/pin/" + p.id + "/"); }
  }

  // close: back to where you were (the feed, at the same spot)
  function closeBox() {
    if (!boxPin) return;
    boxPin = null;
    if (openHere) {
      const o = openHere;
      openHere = null;
      if (field && o.key === cur && o.world) field.setWorld(o.world, { camera: o.camera });
      return;
    }
    if (pinIdOf(location.pathname)) {
      if (lastFeed || history.length > 1) history.back();
      else goTo("/");
    }
  }

  function openSimilar(pin) { openBox(pin); }

  function closeAll() {
    closePops();
    if (openHere) { openHere = null; boxPin = null; }
    if (ui.boards && !ui.boards.hidden) toggleBoards(false);
  }

  // ---------- worlds ----------
  function maybeBoot() {
    if (!field) return;
    const r = route(cur);
    if (r.world) return;
    const pinId = pinIdOf(location.pathname);
    // a pin's page opens at once around the pin itself; its related pins fill in as Pinterest sends them
    const ready = r.pins.length >= BOOT_MIN || (pinId && seen.has(pinId));
    if (!ready) {
      if (!bootTimer) bootTimer = setTimeout(() => { bootTimer = 0; build(true); }, BOOT_WAIT);
      needMore();
      return;
    }
    build(false);
  }

  function build(force) {
    clearTimeout(bootTimer); bootTimer = 0;
    if (!field) return;
    const r = route(cur);
    if (r.world) return;
    const pinId = pinIdOf(location.pathname);
    if (!r.pins.length && !(pinId && seen.has(pinId))) {
      if (force) { setBusy(false); ui.load.hidden = true; ui.note.hidden = false; }
      return;
    }
    ui.note.hidden = true;
    const open = !(feedState.get(cur) || {}).end;
    let w;
    if (pinId && seen.has(pinId)) w = heroWorld(seen.get(pinId), r.pins, open);
    else {
      w = new World(salt ^ hashStr(cur));
      w.open = open;
      w.add(r.pins);
      w.seedSpiral(Math.min(w.items.length, 120));
    }
    r.world = w;
    ui.load.hidden = true;
    field.setWorld(w, { camera: r.camera, rise: !!pinId && !r.camera });
    if (w.hero) showHero(w);
    setBusy(false);
  }

  // More pins: replay Pinterest's own next-page request for this feed (its hidden page then doesn't have to
  // scroll and render). Only when no such request has been seen yet, scroll the hidden page once so Pinterest sends one.
  const feedState = new Map();
  function needMore() {
    const key = cur;
    let st = feedState.get(key);
    if (!st) feedState.set(key, (st = { end: false, empty: 0, scrolls: 0, busy: false, t: 0, len: -1 }));
    if (st.end || st.busy) return;
    const t = Date.now();
    // one page at a time (each answer carries the bookmark for the next). Back to back while spots on screen are
    // waiting or few pins are left; otherwise about one a second, like scrolling Pinterest quickly.
    const w = route(key).world;
    const hungry = !w || w.waiting() > 0 || w.remaining() < 80;
    if (t - st.t < (hungry ? 100 : 900)) return;
    st.t = t;
    st.busy = true;
    const r = route(key), before = r.pins.length;
    api("more", { key }).then((res) => {
      st.busy = false;
      if (host) host.dataset.feed = res && res.none ? "scroll" : (res && res.name) + " +" + (r.pins.length - before);
      if (res && res.none) return scrollFeed(key, st);
      const grew = r.pins.length - before;
      // a page that brings almost nothing new: the request isn't really this feed, so let Pinterest scroll again
      st.thin = grew >= 5 ? 0 : (st.thin || 0) + 1;
      feedWorks(key, st.thin < 2);
      if (st.thin >= 2 && !res.end) scrollFeed(key, st);
      st.empty = grew > 0 ? 0 : st.empty + 1;
      // nothing more this way: let Pinterest's page scroll for it, and only call the feed over when that stalls too
      if ((res && res.end) || st.empty >= 3) { feedWorks(key, false); scrollFeed(key, st); }
      else if (key === cur && r.world && (r.world.waiting() > 0 || r.world.remaining() < 300)) setTimeout(needMore, r.world.waiting() > 0 || r.world.remaining() < 80 ? 100 : 950);
    }, (err) => {
      st.busy = false;
      if (host) host.dataset.feed = "error " + String(err && err.message).slice(0, 60);
      feedWorks(key, false);
      scrollFeed(key, st);
    });
  }
  function scrollFeed(key, st) {
    if (key !== cur) return;
    const r = route(key), t = Date.now();
    if (t - (st.st || 0) < 1200) return; // give Pinterest time to answer the last scroll
    st.st = t;
    st.scrolls = r.pins.length === st.len ? st.scrolls + 1 : 0;
    st.len = r.pins.length;
    if (st.scrolls > 6) return endFeed(key, st);
    const se = document.scrollingElement || document.documentElement;
    se.scrollTop = se.scrollHeight;
  }
  // Pinterest has nothing more for this page: from here on the field may repeat pins, away from their copies
  function endFeed(key, st) {
    st.end = true;
    const w = route(key).world;
    // a pin with few related pins: fill the rest of the field from the feed you came from
    if (w && w.hero && w.items.length < 60 && lastFeed && routes.get(lastFeed)) w.add(routes.get(lastFeed).pins.filter((p) => p.id !== w.hero.pin.id && !hidden.has(p.id)));
    if (w && w.open) { w.open = false; if (key === cur && field) field.refresh(); }
  }

  // Use Pinterest's own in-app navigation when it has a link for the place (no page reload).
  function goTo(path) {
    const id = pinIdOf(path);
    let a = null;
    if (id) a = document.querySelector(`a[href^="/pin/${id}/"],a[href^="/pin/${id}?"]`);
    else if (path === "/" || path === "/ideas/") a = document.querySelector(`a[href="${path}"]`);
    else if (/^\/[\w.-]+\/[\w%.-]+\/$/.test(path)) a = document.querySelector(`a[href="${path}"]`);
    if (a && !(host && host.contains(a))) return a.click();
    location.assign(path);
  }

  function onNav() {
    const k = routeKey();
    if (k === cur) return;
    if (!pinIdOf(location.pathname)) lastFeed = null;
    if (!pinIdOf(cur)) lastFeed = cur;
    cur = k;
    sleepPage();
    openHere = null;
    if (!pinIdOf(location.pathname)) boxPin = null;
    if (ui.boards && !ui.boards.hidden) toggleBoards(false);
    markNav();
    renderGuides();
    if (!field) return;
    const r = route(cur);
    if (r.world) {
      ui.load.hidden = true; ui.note.hidden = true;
      field.setWorld(r.world, { camera: r.camera });
      if (r.world.hero) showHero(r.world);
      setBusy(false);
    }
    else { ui.load.hidden = false; ui.note.hidden = true; maybeBoot(); setTimeout(scanDom, 800); }
  }
  document.addEventListener("pf:nav", () => setTimeout(onNav, 0));
  addEventListener("popstate", () => setTimeout(onNav, 0));

  // ---------- on/off ----------
  let pill = null;
  function setOn(on) {
    lsSet(LS.on, on ? "1" : "0");
    if (on) {
      mount();
      ui.load.hidden = !!route(cur).world;
      maybeBoot();
      field.stage.focus({ preventScroll: true });
    } else unmount();
    renderPill();
  }
  function renderPill() {
    if (!pill) {
      pill = document.createElement("pinfield-toggle");
      const sh = pill.attachShadow({ mode: "open" });
      sh.innerHTML = `<style>button{position:fixed;left:50%;translate:-50% 0;bottom:18px;z-index:2147483647;height:48px;padding:0 20px;border:0;border-radius:999px;background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(16px) saturate(1.8);backdrop-filter:blur(16px) saturate(1.8);color:#111;font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:inset 0 1px 0 rgba(255,255,255,.9),inset 0 0 0 .5px rgba(255,255,255,.4),0 0 0 .5px rgba(0,0,0,.07),0 8px 28px rgba(0,0,0,.16);cursor:pointer;display:flex;align-items:center;gap:8px;transition:scale .25s cubic-bezier(.2,.8,.2,1)}button:hover{background:rgba(255,255,255,.75)}button:active{scale:1.08}button:focus-visible{outline:3px solid #0074e8;outline-offset:2px}svg{width:18px;height:18px;fill:currentColor}</style><button title="Alt+Shift+F">${I.boards}Field view</button>`;
      sh.querySelector("button").addEventListener("click", () => setOn(true));
      document.documentElement.appendChild(pill);
    }
    pill.style.display = host ? "none" : "";
  }

  addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyF") { e.preventDefault(); setOn(!host); return; }
    if (e.key !== "Escape" || !host) return;
    if (ui.sugg && !ui.sugg.hidden) closeSugg();
    else if (popAnchor) closePops();
    else if (closeLightbox()) {}
    else if (selecting) { if (!selNote) setSelecting(false); } // not while it's saving
    else if (boxPin) closeBox();
    else if (ui.boards && !ui.boards.hidden) toggleBoards(false);
  }, true);

  if (isOn()) setOn(true); else renderPill();
  setTimeout(scanDom, 600);
})();

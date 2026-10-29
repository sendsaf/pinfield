// The renderer.
//
// The rule it is built around: while the field MOVES, a frame does nothing but move one layer (a compositor-only
// transform). Building tiles, starting downloads, decoding, sharpening, video and hover chrome all wait until motion
// stops, then catch up in small time-sliced chunks. A wide band around the screen is prepared while you're still,
// and the speed cap keeps a fling inside that band, so moving rarely has anything new to show.
//
// Other things that keep it light:
//  - each tile is its own GPU layer, so panning re-uses pixels instead of re-painting them
//  - one shared hover overlay and a small pool of <video> elements, instead of per-tile copies
//  - after a zoom settles, the layer is re-rasterised once at the new scale (zoomed out = far fewer pixels)
//  - a quality governor watches frame times and steps down (fewer loads, smaller images, no autoplay) on slow machines
(function () {
  "use strict";
  const g = globalThis;
  if (g.__pfField) return;
  const { W } = g.__pfLayout;

  const ZMAX = 2.2;
  // quality levels: 0 sharp, 1 balanced, 2 light ("potato")
  const LEVELS = [
    { loads: 8, videos: 3, dpr: 2, margin: 900, zmin: 0.45, warm: 4, upgrade: true, rise: true },
    { loads: 5, videos: 1, dpr: 1.25, margin: 700, zmin: 0.5, warm: 3, upgrade: true, rise: false },
    { loads: 3, videos: 0, dpr: 1, margin: 480, zmin: 0.6, warm: 0, upgrade: false, rise: false },
  ];
  const MAXV = 34; // fling/scroll cap, world units per 60Hz frame at zoom <= 1 (keeps a fling inside the prepared band)
  const DECAY = 0.95;
  const SETTLE_MS = 110; // stillness before deferred work starts
  const AHEAD_MS = 600;
  const LITE_Z = 0.62; // below this zoom, no hover chrome
  const VARIANTS = ["s", "m", "l"];
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, m) => (v > m ? m : v < -m ? -m : v);
  const now = () => performance.now();
  const idle = (fn, timeout) =>
    window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60);

  function hardwareLevel() {
    const c = navigator.hardwareConcurrency || 4, m = navigator.deviceMemory || 4;
    if (c <= 2 || m <= 2) return 2;
    if (c <= 4 || m <= 4) return 1;
    return 0;
  }

  class Field {
    constructor(root, cb) {
      this.cb = cb;
      this.qa = cb.quickEl || null;
      this.stage = document.createElement("div");
      this.stage.className = "stage";
      this.stage.setAttribute("role", "application");
      this.stage.setAttribute("aria-label", "Pin field. Drag or scroll to move, Ctrl and scroll to zoom.");
      this.stage.tabIndex = 0;
      this.layer = document.createElement("div");
      this.layer.className = "layer";
      this.stage.appendChild(this.layer);
      root.appendChild(this.stage);

      this.cam = { x: 0, y: 0, z: 1 };
      this.tz = 1;
      this.goal = { x: 0, y: 0 };
      this.vel = { x: 0, y: 0 };
      this.anchor = null;
      this.glide = null;
      this.size = { w: innerWidth, h: innerHeight };
      this.live = new Map();
      this.free = [];
      this.scratch = [];
      this.aheadScratch = [];
      this.pending = [];
      this.lastQ = null;
      this.drawn = null;
      this.raf = 0;
      this.prev = 0;
      this.ptrs = new Map();
      this.drag = null;
      this.pinch = null;
      this.ptr = null; // last pointer position, for re-hover after motion
      this.wheelT = 0;
      this.loadQ = [];
      this.loading = 0;
      this.warm = new Map();
      this.warmQ = [];
      this.warming = 0;
      this.vpool = [];
      this.hovered = null;
      this.moving = false;
      this.activeT = 0;
      this.zoomedSinceSettle = false;
      this.lite = false;
      this.stats = { n: 0, slow: 0 };
      this.world = null;
      this.setQuality("auto");
      this._bind();
    }

    // ---------- public ----------
    setWorld(world, { camera, rise, pivotKey } = {}) {
      for (const e of this.live.values()) this._release(e);
      this.live.clear();
      this.pending.length = 0;
      this.setHero(null);
      this.world = world;
      this.lastQ = null;
      this.drawn = null;
      this.vel.x = this.vel.y = 0;
      this.glide = null;
      const o = camera || world.origin();
      this.cam.x = this.goal.x = o.x;
      this.cam.y = this.goal.y = o.y;
      if (camera && camera.z) this.cam.z = this.tz = Math.max(camera.z, this.L.zmin);
      else if (world.focus) this.cam.z = this.tz = 1; // an open pin is laid out for 1:1
      this.rise = rise && this.L.rise && !reduced();
      this.riseN = 0;
      this.stage.toggleAttribute("data-pivot", !!pivotKey);
      this.pivotKey = pivotKey || null;
      if (!rise && !reduced() && this.level < 2) {
        this.layer.classList.remove("enter");
        void this.layer.offsetWidth;
        this.layer.classList.add("enter");
      }
      this._wake();
    }

    refresh() { this.lastQ = null; this._wake(); }

    // An open pin lives in the grid: one element placed in world units, moving and zooming with the cards.
    setHero(el, x, y) {
      if (this.hero && this.hero !== el) this.hero.remove();
      this.hero = el || null;
      if (!el) return;
      el.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
      this.layer.appendChild(el);
    }
    camera() { return { x: this.cam.x, y: this.cam.y, z: this.cam.z }; }

    centerOn(x, y, ms = 260) {
      this.vel.x = this.vel.y = 0;
      this.glide = { fx: this.cam.x, fy: this.cam.y, tx: x, ty: y, t0: now(), ms: reduced() ? 1 : ms };
      this.kick();
    }

    pivot(key) {
      this.pivotKey = key;
      this.stage.toggleAttribute("data-pivot", !!key);
      for (const e of this.live.values()) e.el.toggleAttribute("data-seed", e.key === key);
    }

    // "auto" starts from the machine's hints and steps down if frames run long; "smooth" and "sharp" are fixed.
    setQuality(mode) {
      this.mode = mode;
      this._level(mode === "sharp" ? 0 : mode === "smooth" ? 2 : hardwareLevel());
    }

    _level(l) {
      this.level = l;
      this.L = LEVELS[l];
      this.stage.dataset.ql = String(l);
      if (this.cb.onLevel) this.cb.onLevel(l);
      if (this.tz < this.L.zmin) this._zoomAt(this.size.w / 2, this.size.h / 2, this.L.zmin / this.tz);
      this.stats.n = this.stats.slow = 0;
      this.refresh();
    }

    // The item at world index i changed (e.g. hidden and replaced): redraw tiles showing it.
    refreshIndex(i) {
      const want = this._variant();
      for (const [key, e] of [...this.live]) {
        if (e.tile.i !== i) continue;
        const t = e.tile;
        t.item = this.world.items[i];
        this._release(e);
        this.live.set(key, this._acquire(t, want));
      }
      this._pump();
    }

    rehover() {
      if (this.hovered && this.cb.onHover) this.cb.onHover(this.hovered.item, this.hovered.tile);
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      this._unbind();
      for (const e of this.live.values()) if (e.vid) this._unvideo(e);
      this.stage.remove();
      this.warm.clear();
    }

    // ---------- frame loop ----------
    kick() {
      if (!this.raf) this.raf = requestAnimationFrame((t) => this._frame(t));
    }

    // input that doesn't move the camera itself (resize, world change): still run the deferred work
    _wake() { this.activeT = now(); this.moving = true; this.kick(); }

    _frame(t) {
      this.raf = 0;
      const dt = this.prev ? Math.min(64, t - this.prev) : 16.7;
      this.prev = t;
      const k = dt / 16.7;
      const c = this.cam;
      const vmax = (MAXV * k) / Math.max(1, c.z);
      let busy = false;

      if (this.glide) {
        const gl = this.glide;
        const p = Math.min(1, (t - gl.t0) / gl.ms), e = 1 - (1 - p) ** 3;
        c.x = gl.fx + (gl.tx - gl.fx) * e;
        c.y = gl.fy + (gl.ty - gl.fy) * e;
        this.goal.x = c.x; this.goal.y = c.y;
        if (p >= 1) this.glide = null; else busy = true;
      } else if (!this.drag) {
        const dx = this.goal.x - c.x, dy = this.goal.y - c.y;
        if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
          const a = 1 - Math.pow(1 - 0.16, k);
          c.x += clamp(dx * a, vmax); c.y += clamp(dy * a, vmax); busy = true;
        }
        if (Math.abs(this.vel.x) > 0.03 || Math.abs(this.vel.y) > 0.03) {
          c.x += clamp(this.vel.x * k, vmax); c.y += clamp(this.vel.y * k, vmax);
          this.goal.x = c.x; this.goal.y = c.y;
          const f = Math.pow(DECAY, k);
          this.vel.x *= f; this.vel.y *= f; busy = true;
        }
      }

      const dz = this.tz - c.z;
      if (Math.abs(dz) > 4e-4) {
        c.z += dz * (1 - Math.pow(1 - 0.22, k));
        if (this.anchor) {
          const a = this.anchor;
          c.x = this.goal.x = a.wx - (a.px - this.size.w / 2) / c.z;
          c.y = this.goal.y = a.wy - (a.py - this.size.h / 2) / c.z;
        }
        this.zoomedSinceSettle = true;
        busy = true;
      } else if (this.anchor) this.anchor = null;

      const dr = this.drawn;
      const moved = !dr || c.x !== dr.x || c.y !== dr.y || c.z !== dr.z;
      if (moved) {
        this.drawn = { x: c.x, y: c.y, z: c.z };
        // the only per-frame DOM write while moving
        this.layer.style.transform =
          `translate3d(${this.size.w / 2 - c.x * c.z}px,${this.size.h / 2 - c.y * c.z}px,0) scale(${c.z})`;
      }

      const active = busy || !!this.drag || !!this.pinch || t - this.wheelT < 80;
      if (active) {
        this.activeT = t;
        // (a refresh also marks the field busy, so "moving" alone can't tell whether you started moving it)
        if (!this.mvShown && moved) this._startMoving();
      }
      if (this.moving && moved && active) this._stat(dt);
      const still = !active && t - this.activeT > SETTLE_MS;
      if (this.moving && still) this._settle();

      if (moved || !this.lastQ) this._sync();
      if (this.pending.length) this._mount();

      const more = this.pending.length && (!this.moving || this.pending[0].central);
      if (active || this.moving || more || !still) this.kick();
      else this.prev = 0;
    }

    _startMoving() {
      this.moving = true;
      this.mvShown = true;
      this.layer.classList.add("mv"); // no hit-testing or hover while moving
      if (this.cb.onMove) this.cb.onMove(true);
      this._hover(null);
      for (const e of this.live.values()) if (e.vid && !e.vid.paused) e.vid.pause();
    }

    _settle() {
      this.moving = false;
      this.mvShown = false;
      this.layer.classList.remove("mv");
      if (this.cb.onMove) this.cb.onMove(false);
      const c = this.cam;
      const lite = c.z < LITE_Z;
      if (lite !== this.lite) { this.lite = lite; this.stage.toggleAttribute("data-lite", lite); }
      if (this.zoomedSinceSettle) {
        this.zoomedSinceSettle = false;
        // re-rasterise at the scale we stopped on (will-change pins the raster scale while moving)
        this.layer.style.willChange = "auto";
        requestAnimationFrame(() => { this.layer.style.willChange = "transform"; });
        if (this.L.upgrade) this._upgrade();
      }
      this.lastQ = null; // full re-query with the wide band
      this._sync();
      this._pump();
      this._videos();
      if (this.ptr) this._hoverAt(this.ptr.x, this.ptr.y);
      if (this.cb.onCamera) this.cb.onCamera(c);
    }

    // quality governor: sample frame times while moving; step down when too many run long
    _stat(dt) {
      const s = this.stats;
      s.n++;
      if (dt > 24) s.slow++;
      if (s.n < 60) return;
      if (this.mode === "auto" && this.level < 2 && s.slow / s.n > 0.25) this._level(this.level + 1);
      s.n = s.slow = 0;
    }

    // ---------- visibility ----------
    _view() {
      const c = this.cam;
      const hw = this.size.w / 2 / c.z, hh = this.size.h / 2 / c.z;
      return { x0: c.x - hw, x1: c.x + hw, y0: c.y - hh, y1: c.y + hh };
    }

    _variant() {
      const px = W * this.cam.z * Math.min(devicePixelRatio || 1, this.L.dpr);
      return px <= 250 ? 0 : px <= 490 ? 1 : 2;
    }

    _sync() {
      const w = this.world;
      if (!w || !w.items.length) return;
      const c = this.cam;
      const q = this.lastQ, step = 60 / c.z;
      if (q && Math.abs(q.x - c.x) < step && Math.abs(q.y - c.y) < step && Math.abs(q.z - c.z) / c.z < 0.03) return;
      const t = now();
      const mvx = q ? (c.x - q.x) / Math.max(t - q.t, 16) : 0;
      const mvy = q ? (c.y - q.y) / Math.max(t - q.t, 16) : 0;
      this.lastQ = { x: c.x, y: c.y, z: c.z, t };

      const view = this._view();
      const ax = mvx * AHEAD_MS, ay = mvy * AHEAD_MS;
      const ahead = { x0: view.x0 + ax, x1: view.x1 + ax, y0: view.y0 + ay, y1: view.y1 + ay };
      const seenRect = {
        x0: Math.min(view.x0, ahead.x0), x1: Math.max(view.x1, ahead.x1),
        y0: Math.min(view.y0, ahead.y0), y1: Math.max(view.y1, ahead.y1),
      };
      const m = this.L.margin; // world units: the band prepared around the screen
      const rect = { x0: view.x0 - m, x1: view.x1 + m, y0: view.y0 - m, y1: view.y1 + m };
      const tiles = this.scratch;
      const maxSeen = w.query(rect, seenRect, tiles);

      const keep = new Set();
      this.pending.length = 0;
      for (const tl of tiles) {
        keep.add(tl.key);
        const dx = tl.x - c.x, dy = tl.y + tl.h / 2 - c.y;
        tl.d = Math.hypot(dx, dy) - (dx * mvx + dy * mvy) * 300;
        tl.central = tl.x + tl.w / 2 > view.x0 && tl.x - tl.w / 2 < view.x1 && tl.y + tl.h > view.y0 && tl.y < view.y1;
        const e = this.live.get(tl.key);
        if (e && e.item.pending && !tl.item.pending) { this._release(e); this.live.delete(tl.key); } // its pin arrived
        else if (e) {
          e.d = tl.d; e.pri = tl.central ? 0 : 1;
          if (tl.central && !e.ld && !e.img.classList.contains("in") && e.item) { e.ld = true; e.el.setAttribute("data-ld", ""); }
          continue;
        }
        this.pending.push(tl);
      }
      // a moving field keeps tiles it may come straight back to; only ones far behind are let go
      if (!this.moving) {
        for (const [key, e] of this.live) if (!keep.has(key)) { this._release(e); this.live.delete(key); }
      } else if (this.live.size > tiles.length * 1.5) {
        const far = m * 2.2;
        let n = 0;
        for (const [key, e] of this.live) {
          if (keep.has(key)) continue;
          const t = e.tile;
          if (t.x < view.x0 - far || t.x > view.x1 + far || t.y + t.h < view.y0 - far || t.y > view.y1 + far) {
            this._release(e); this.live.delete(key);
            if (++n > 24) break;
          }
        }
      }
      this.pending.sort((a, b) => (a.central === b.central ? a.d - b.d : a.central ? -1 : 1));

      // ask early: a zoomed-out screen holds ~100 pins, and a page from Pinterest is ~25
      // keep ~300 pins in hand: a zoomed-out screen holds ~100, and a page from Pinterest is ~25
      if (this.cb.onNeedMore && (w.waiting() > 0 || w.remaining() < 300 || maxSeen > 0.6 * w.items.length)) this.cb.onNeedMore();
      // "nearby" for repeats covers the whole screen and the band around it, however far you zoom out
      w.reach.cols = Math.ceil((view.x1 - view.x0 + 2 * m) / 2 / 252) + 1;
      w.reach.r = Math.max(1700, (view.y1 - view.y0) / 2 + m);
      if (!this.moving && (ax || ay) && this.L.warm) this._predict(ahead);
    }

    // time-sliced: a few in-view tiles per frame while moving, a bigger slice when still
    _mount() {
      const t0 = now(), budget = this.moving ? 2.5 : 6, maxN = this.moving ? 6 : 80;
      const want = this._variant();
      let n = 0;
      while (this.pending.length && n < maxN && now() - t0 < budget) {
        const t = this.pending[0];
        if (this.moving && !t.central) break;
        this.pending.shift();
        if (this.live.has(t.key)) continue;
        this.live.set(t.key, this._acquire(t, want));
        n++;
      }
      this._pump();
    }

    _acquire(t, want) {
      let e = this.free.pop();
      if (!e) {
        const el = document.createElement("a");
        el.className = "t";
        el.draggable = false;
        const ph = document.createElement("span");
        ph.className = "ph";
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.decoding = "async";
        const dots = document.createElement("span");
        dots.className = "dots";
        dots.innerHTML = "<i></i><i></i><i></i>";
        ph.append(img, dots);
        el.append(ph);
        e = { el, ph, img };
        img.addEventListener("load", () => { img.classList.add("in"); el.removeAttribute("data-ld"); this._done(e); });
        img.addEventListener("error", () => {
          el.removeAttribute("data-ld");
          this._done(e);
          if (e.variant > 0 && !e.fellBack) { e.fellBack = true; e.variant = 0; this._enqueue(e); }
        });
        this.layer.appendChild(el);
      }
      const p = t.item;
      e.key = t.key; e.tile = t; e.item = p; e.ld = !!t.central;
      if (p.pending) return this._waitTile(e, t); e.variant = -1; e.fellBack = false; e.d = t.d; e.pri = t.central ? 0 : 1;
      e.token = (e.token || 0) + 1;
      const el = e.el;
      el.hidden = false;
      el.href = "/pin/" + p.id + "/";
      el.dataset.key = t.key;
      el.setAttribute("aria-label", p.title || "Pin");
      // translate3d on purpose: each tile becomes its own GPU layer, rastered once and then only moved.
      // Measured: one shared layer had to re-raster as you panned and dropped twice as many frames zoomed out.
      el.style.cssText = `transform:translate3d(${Math.round(t.x - t.w / 2)}px,${Math.round(t.y)}px,0);width:${t.w}px;height:${t.h}px`;
      e.ph.style.background = p.color || "var(--ph)";
      el.toggleAttribute("data-seed", t.key === this.pivotKey);
      if (this.rise) {
        el.classList.add("rise");
        el.style.setProperty("--d", Math.min(this.riseN++ * 16, 520) + "ms");
      } else el.classList.remove("rise");
      e.img.classList.remove("in");
      // dots only on tiles on screen: animating them off screen would cost the GPU for nothing
      el.toggleAttribute("data-ld", !!t.central);
      e.img.fetchPriority = t.central ? "high" : "low";
      e.variant = want;
      this._enqueue(e);
      return e;
    }

    // a spot whose pin hasn't arrived: an empty tile in the placeholder colour, nothing to load or click
    _waitTile(e, t) {
      e.variant = -1; e.token = (e.token || 0) + 1;
      const el = e.el;
      el.hidden = false;
      el.removeAttribute("href");
      el.dataset.key = t.key;
      el.setAttribute("aria-label", "Loading pin");
      el.style.cssText = `transform:translate3d(${Math.round(t.x - t.w / 2)}px,${Math.round(t.y)}px,0);width:${t.w}px;height:${t.h}px`;
      e.ph.style.background = "var(--ph)";
      el.classList.remove("rise");
      e.img.classList.remove("in");
      el.toggleAttribute("data-ld", !!t.central);
      return e;
    }

    _release(e) {
      e.token++;
      if (this.hovered === e) this._hover(null);
      if (e.vid) this._unvideo(e);
      if (e.inflight) this._done(e);
      e.queued = false;
      e.img.removeAttribute("src"); // cancels an in-flight download for a tile we passed
      e.el.removeAttribute("data-ld");
      e.img.classList.remove("in");
      e.el.hidden = true;
      if (this.free.length < 320) this.free.push(e);
      else e.el.remove();
    }

    // ---------- image scheduler ----------
    _enqueue(e) {
      const url = e.item.src[VARIANTS[e.variant]];
      if (this.warm.has(url)) { e.img.src = url; e.img.classList.add("in"); e.el.removeAttribute("data-ld"); return; }
      if (!e.queued) { e.queued = true; this.loadQ.push(e); }
    }

    _pump() {
      if (this.loading >= this.L.loads || !this.loadQ.length) return;
      this.loadQ = this.loadQ.filter((e) => e.queued);
      this.loadQ.sort((a, b) => a.pri - b.pri || a.d - b.d);
      let i = 0;
      while (this.loading < this.L.loads && i < this.loadQ.length) {
        const e = this.loadQ[i];
        if (this.moving && e.pri > 0) { i++; continue; } // off-screen images wait for stillness
        this.loadQ.splice(i, 1);
        e.queued = false;
        e.inflight = true;
        this.loading++;
        e.img.src = e.item.src[VARIANTS[e.variant]];
      }
    }

    _done(e) {
      if (!e.inflight) return;
      e.inflight = false;
      this.loading--;
      this._pump();
    }

    _upgrade() {
      const want = this._variant();
      let n = 0;
      for (const e of this.live.values()) {
        if (e.variant >= want || !e.img.classList.contains("in")) continue;
        const tok = e.token, url = e.item.src[VARIANTS[want]];
        setTimeout(() => {
          if (e.token !== tok || this.moving) return;
          const im = new Image();
          im.decoding = "async";
          im.fetchPriority = "low";
          im.src = url;
          im.decode().then(() => { if (e.token === tok) { e.variant = want; e.img.src = url; } }, () => {});
        }, (n++ >> 3) * 50);
      }
    }

    _predict(ahead) {
      const n = navigator.connection;
      if (n && (n.saveData || /(^|-)2g$/.test(n.effectiveType || ""))) return;
      const v = this._variant();
      const tiles = this.aheadScratch;
      this.world.query(ahead, ahead, tiles);
      for (const t of tiles) {
        if (this.live.has(t.key) || t.item.pending) continue;
        const url = t.item.src[VARIANTS[v]];
        if (!this.warm.has(url) && !this.warmQ.includes(url)) this.warmQ.push(url);
      }
      if (this.warmQ.length > 48) this.warmQ.splice(0, this.warmQ.length - 48);
      const limit = Math.min(this.L.warm, n && n.effectiveType === "3g" ? 2 : 4);
      const pump = () => {
        while (this.warming < limit && this.warmQ.length && this.loading < this.L.loads && !this.moving) {
          const url = this.warmQ.pop();
          this.warming++;
          const im = new Image();
          im.decoding = "async";
          im.fetchPriority = "low";
          im.src = url;
          im.decode().then(
            () => {
              this.warm.set(url, im);
              if (this.warm.size > 200) this.warm.delete(this.warm.keys().next().value);
            },
            () => {},
          ).finally(() => { this.warming--; pump(); });
        }
      };
      idle(pump, 300);
    }

    // ---------- video: a few nearest the centre autoplay, muted, only while still ----------
    _videos() {
      const K = this.L.videos;
      const view = this._view();
      const keep = new Set();
      if (K > 0 && !this.lite) {
        const c = [];
        for (const e of this.live.values()) {
          const t = e.tile;
          if (!e.item.video || e.item.videoBad) continue;
          if (t.x + t.w / 2 < view.x0 || t.x - t.w / 2 > view.x1 || t.y + t.h < view.y0 || t.y > view.y1) continue;
          c.push(e);
        }
        c.sort((a, b) => a.d - b.d);
        for (const e of c.slice(0, K)) keep.add(e);
      }
      if (this.hovered && this.hovered.item.video && !this.hovered.item.videoBad) keep.add(this.hovered);
      for (const e of this.live.values()) if (e.vid && !keep.has(e)) this._unvideo(e);
      for (const e of keep) this._playVideo(e);
    }

    _playVideo(e) {
      if (!e.vid) {
        let v = this.vpool.pop();
        if (!v) {
          v = document.createElement("video");
          v.className = "vid";
          v.muted = true;
          v.defaultMuted = true;
          v.loop = true;
          v.playsInline = true;
          v.setAttribute("playsinline", "");
          v.disablePictureInPicture = true;
          v.preload = "auto";
          v.addEventListener("playing", () => v.classList.add("on"));
          v.addEventListener("error", () => {
            const owner = v.__owner;
            if (owner && owner.vid === v) { owner.item.videoBad = true; this._unvideo(owner); }
          });
        }
        v.__owner = e;
        v.src = e.item.video.url;
        e.vid = v;
        e.ph.insertBefore(v, e.ph.children[1] || null); // above the image, below the hover overlay
      }
      if (!this.moving) e.vid.play().catch(() => {});
    }

    _unvideo(e) {
      const v = e.vid;
      if (!v) return;
      e.vid = null;
      v.__owner = null;
      v.pause();
      v.classList.remove("on");
      v.removeAttribute("src");
      v.load(); // frees the decoder
      v.remove();
      if (this.vpool.length < 6) this.vpool.push(v);
    }

    // ---------- hover: one shared overlay moves to whichever tile is under the pointer ----------
    _hover(e) {
      if (this.hovered === e) return;
      const prev = this.hovered;
      this.hovered = e;
      if (this.qa) this.qa.remove();
      if (prev && prev.vid && this.L.videos === 0) this._unvideo(prev);
      if (!e) return;
      if (this.qa && !this.lite) {
        e.ph.appendChild(this.qa);
        if (this.cb.onHover) this.cb.onHover(e.item, e.tile);
      }
      if (e.item.video && !e.item.videoBad) this._playVideo(e);
    }

    _hoverAt(x, y) {
      if (this.moving || this.drag) return;
      const root = this.stage.getRootNode();
      const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : null;
      const a = hit && hit.closest ? hit.closest("a.t") : null;
      const e = a ? this.live.get(a.dataset.key) || null : null;
      this._hover(e && !e.item.pending ? e : null);
    }

    // ---------- input ----------
    _bind() {
      this._h = {
        down: (e) => this._down(e),
        move: (e) => this._move(e),
        up: (e) => this._up(e),
        wheel: (e) => this._wheel(e),
        key: (e) => this._key(e),
        click: (e) => {
          const a = e.realTarget.closest && e.realTarget.closest("a.t");
          if (!a) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let new-tab clicks through
          e.preventDefault();
          if (e.detail === 0) this._activate(a, e.realTarget); // keyboard Enter
        },
        resize: () => { this.size = { w: innerWidth, h: innerHeight }; this.refresh(); },
        outside: (e) => { if (!e.composedPath().includes(this.stage)) { this.ptr = null; this._hover(null); } },
      };
      // listen on window in the capture phase and claim only events aimed at the field
      // buttons inside the field (an open pin's rail) are the UI's, not a drag or a tile click
      const mine = (e) => { const p = e.composedPath(); return p.includes(this.stage) && !p.some((n) => n.dataset && n.dataset.ui != null); };
      const route = (fn) => (e) => {
        if (!mine(e)) return;
        e.stopPropagation();
        e.realTarget = e.composedPath()[0];
        fn(e);
      };
      this._win = [
        ["pointerdown", route(this._h.down)],
        ["pointermove", route(this._h.move)],
        ["pointerup", route(this._h.up)],
        ["pointercancel", route(this._h.up)],
        ["wheel", route(this._h.wheel), { capture: true, passive: false }],
        ["keydown", route(this._h.key)],
        ["click", route(this._h.click)],
        ["dragstart", route((e) => e.preventDefault())],
        ["pointermove", this._h.outside],
      ];
      for (const [t, f, o] of this._win) addEventListener(t, f, o || true);
      addEventListener("resize", this._h.resize);
    }

    _unbind() {
      removeEventListener("resize", this._h.resize);
      for (const [t, f, o] of this._win) removeEventListener(t, f, o || true);
    }

    _activate(tileEl, target) {
      const e = this.live.get(tileEl.dataset.key);
      if (!e || e.item.pending) return;
      const q = target && target.closest ? target.closest("[data-q]") : null;
      if (q) this.cb.onQuick && this.cb.onQuick(q.dataset.q, e.item, e.tile, q);
      else this.cb.onOpen && this.cb.onOpen(e.item, e.tile);
    }

    _down(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.glide = null;
      try { this.stage.setPointerCapture(e.pointerId); } catch {}
      if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        this.pinch = Math.hypot(b.x - a.x, b.y - a.y);
        this.drag = null;
        this.vel.x = this.vel.y = 0;
      } else if (this.ptrs.size === 1) {
        this.vel.x = this.vel.y = 0;
        this.drag = { x: e.clientX, y: e.clientY, t: now(), moved: false, target: e.realTarget };
      }
    }

    _move(e) {
      this.ptr = { x: e.clientX, y: e.clientY };
      const p = this.ptrs.get(e.pointerId);
      if (!p) {
        // plain hover
        if (!this.moving && e.pointerType !== "touch") {
          const a = e.realTarget.closest ? e.realTarget.closest("a.t") : null;
          this._hover(a ? this.live.get(a.dataset.key) || null : null);
        }
        return;
      }
      p.x = e.clientX; p.y = e.clientY;
      if (this.ptrs.size >= 2 && this.pinch) {
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        this._zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.pinch);
        this.pinch = d;
        return;
      }
      const d = this.drag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      if (!d.moved) { d.moved = true; this.stage.dataset.panning = "1"; }
      const t = now(), dt = Math.max(t - d.t, 1), z = this.cam.z;
      const dx = (e.clientX - d.x) / z, dy = (e.clientY - d.y) / z;
      this.cam.x -= dx; this.cam.y -= dy; // the hand is followed 1:1
      this.goal.x = this.cam.x; this.goal.y = this.cam.y;
      const f = 16.7 / dt;
      this.vel.x = 0.35 * this.vel.x - dx * f * 0.65;
      this.vel.y = 0.35 * this.vel.y - dy * f * 0.65;
      d.x = e.clientX; d.y = e.clientY; d.t = t;
      this.kick();
    }

    _up(e) {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.delete(e.pointerId);
      try { this.stage.releasePointerCapture(e.pointerId); } catch {}
      if (this.ptrs.size === 1) {
        const [p] = [...this.ptrs.values()];
        this.pinch = null;
        this.drag = { x: p.x, y: p.y, t: now(), moved: true, target: null };
        return;
      }
      if (this.ptrs.size) return;
      this.pinch = null;
      const d = this.drag;
      this.drag = null;
      delete this.stage.dataset.panning;
      if (!d) return;
      if (now() - d.t > 90 || reduced()) this.vel.x = this.vel.y = 0; // held still before release: no fling
      if (e.type === "pointerup" && !d.moved && d.target) {
        const a = d.target.closest && d.target.closest("a.t");
        if (a) this._activate(a, d.target);
      }
      this.kick();
    }

    _zoomAt(sx, sy, factor) {
      const z = this.cam.z;
      this.anchor = {
        wx: this.cam.x + (sx - this.size.w / 2) / z,
        wy: this.cam.y + (sy - this.size.h / 2) / z,
        px: sx, py: sy,
      };
      this.tz = Math.min(ZMAX, Math.max(this.L.zmin, this.tz * factor));
      this.kick();
    }

    _wheel(e) {
      e.preventDefault();
      this.wheelT = now();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.size.h : 1;
      if (e.ctrlKey || e.metaKey) {
        this._zoomAt(e.clientX, e.clientY, Math.exp(-0.0022 * e.deltaY * unit));
        return;
      }
      this.vel.x = this.vel.y = 0;
      this.glide = null;
      const lim = (this.size.h * 1.2) / this.cam.z;
      this.goal.x = this.cam.x + clamp(this.goal.x - this.cam.x + (e.deltaX * unit) / this.cam.z, lim);
      this.goal.y = this.cam.y + clamp(this.goal.y - this.cam.y + (e.deltaY * unit) / this.cam.z, lim);
      this.kick();
    }

    _key(e) {
      const step = 160 / this.cam.z;
      const k = e.key;
      if (k === "ArrowLeft") this.goal.x -= step;
      else if (k === "ArrowRight") this.goal.x += step;
      else if (k === "ArrowUp") this.goal.y -= step;
      else if (k === "ArrowDown") this.goal.y += step;
      else if (k === "+" || k === "=") return this._zoomAt(this.size.w / 2, this.size.h / 2, 1.2);
      else if (k === "-" || k === "_") return this._zoomAt(this.size.w / 2, this.size.h / 2, 1 / 1.2);
      else if (k === "0") return this._zoomAt(this.size.w / 2, this.size.h / 2, 1 / this.tz);
      else return;
      e.preventDefault();
      this.wheelT = now();
      this.kick();
    }
  }

  g.__pfField = { Field };
})();

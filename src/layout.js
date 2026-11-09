// The world: an endless staggered field whose geometry is a pure function of (column, row).
// Nothing about off-screen space is stored until you look at it, so memory stays flat however far you pan.
(function () {
  "use strict";
  const g = globalThis;
  if (g.__pfLayout) return;

  const COL = 252; // column pitch (Pinterest: 236 wide + 16 gutter)
  const W = 236; // tile width
  const GAP = 16; // vertical gap
  const JITTER = 520; // max column stagger

  // 32-bit integer hash -> [0,1). Cheap, branchless, good avalanche.
  function hash(a, b, s) {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // n -> (col,row) on a square spiral out from the origin, so rank 0 sits dead centre.
  function spiralAt(n) {
    if (n === 0) return [0, 0];
    const r = Math.ceil((Math.sqrt(n + 1) - 1) / 2);
    const side = 2 * r;
    let k = n - (2 * r - 1) ** 2;
    if (k < side) return [r, -r + 1 + k];
    k -= side;
    if (k < side) return [r - 1 - k, r];
    k -= side;
    if (k < side) return [-r, r - 1 - k];
    k -= side;
    return [-r + 1 + k, -r];
  }

  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  // a spot waiting for a pin Pinterest hasn't sent yet: shown as an empty tile, filled when it arrives
  const WAIT = Object.freeze({ pending: true, id: "", color: null, title: "", src: Object.freeze({}) });

  class World {
    constructor(salt) {
      this.salt = salt >>> 0;
      this.items = []; // ranked pins
      this.ids = new Set();
      this.next = 0; // queue head: first item not yet placed on screen
      this.fallback = null; // extra pins to use before repeating (e.g. the feed you came from)
      this.fbNext = 0;
      this.cells = new Map(); // "c,r" -> item index (memo: a cell never changes once seen)
      this.cols = new Map(); // c -> { down: [{y,h,i}], up: [{y,h,i}] }
      this.repeats = 0;
      this.open = true; // Pinterest may still have more pins: wait for them instead of repeating
      this.spots = 0; // waiting spots made so far (ids -1, -2, ...)
      this.fill = new Map(); // waiting spot -> the pin that filled it (or a repeat, once the feed has ended)
      this.reach = { cols: 4, r: 1700 }; // how far "nearby" reaches, set from the zoom so repeats stay off screen
      this.blocks = []; // rects the grid flows around (an open pin and its buttons), world units
    }

    // Reserve space in the grid: columns that cross a rect start below it and grow up from above it,
    // so the rect sits in the grid like any card, just bigger.
    block(rect) { this.blocks.push(rect); this.cols.clear(); this.cells.clear(); }
    _blockFor(c) {
      const x0 = c * COL - W / 2, x1 = c * COL + W / 2;
      let b = null;
      for (const r of this.blocks) {
        if (r.x1 <= x0 || r.x0 >= x1) continue;
        b = b ? { y0: Math.min(b.y0, r.y0), y1: Math.max(b.y1, r.y1) } : { y0: r.y0, y1: r.y1 };
      }
      return b;
    }

    add(pins) {
      let n = 0;
      for (const p of pins) {
        if (this.ids.has(p.id)) continue;
        this.ids.add(p.id);
        this.items.push(p);
        n++;
      }
      return n;
    }

    // Place the first `k` items on the spiral before any geometry exists, so the best pins land in the middle.
    seedSpiral(k) {
      for (let n = 0; n < k && this.next < this.items.length; n++) {
        const [c, r] = spiralAt(n);
        const key = c + "," + r;
        if (!this.cells.has(key)) this.cells.set(key, this.next++);
      }
    }

    remaining() { return this.items.length - this.next; }
    waiting() { return this.spots - this.fill.size; }
    // The pin a spot shows. A waiting spot takes the next arrived pin only once it is on (or about to come on)
    // screen, so new pins land where you're looking, not in spots made earlier off screen. Once the feed has
    // ended, a spot still waiting gets a repeat chosen away from its copies. -1 = still waiting.
    at(i, c, y, onScreen, h) {
      if (i >= 0) return i;
      let f = this.fill.get(i);
      if (f !== undefined) return f;
      if (!onScreen) return -1;
      if (this.next < this.items.length) f = this.fitNext(h);
      else if (!this.open) f = this.repeatFor(c, Math.floor(y / 300), y);
      else return -1;
      this.fill.set(i, f);
      return f;
    }

    imgH(i) {
      // a spot still waiting for its pin borrows the shape of a pin already here, so the field keeps the feed's
      // real mix of tall, square and wide boxes (it used to make every waiting spot portrait)
      const n = this.items.length;
      const p = i >= 0 ? this.items[i] : n ? this.items[Math.floor(hash(i, 7, this.salt) * n)] : null;
      const ratio = p && p.w > 0 && p.h > 0 ? p.h / p.w : 1.25 + hash(i, 7, this.salt) * 0.4;
      return Math.round(W * Math.min(2.6, Math.max(0.45, ratio)));
    }

    height(i) { return this.imgH(i); }

    // Fill a waiting spot of height h: of the next few pins in the queue, the one whose shape fits the box best
    // moves to the front, so a wide picture isn't squeezed into a tall box. Unplaced pins only, so nothing moves.
    fitNext(h) {
      const a = this.next, end = Math.min(this.items.length, a + 12);
      let best = a, bd = Infinity;
      if (h > 0) for (let k = a; k < end; k++) {
        const d = Math.abs(Math.log(this.imgH(k) / h));
        if (d < bd) { bd = d; best = k; }
      }
      if (best !== a) { const t = this.items[best]; this.items[best] = this.items[a]; this.items[a] = t; }
      return this.next++;
    }

    // Swap a pin out of the world (e.g. hidden) without moving anything: the next unplaced pin takes its box.
    replace(i) {
      // only an unplaced pin (index >= next) can move in, so nothing already on screen jumps
      const N = this.items.length;
      if (i >= this.next || N < 2) return false;
      if (this.next < N) { this.items[i] = this.items.pop(); return true; }
      // every pin is already out (the field is repeating): borrow another one so no hole is left
      let j = Math.floor(hash(i, N, this.salt + 7) * N);
      if (j === i) j = (i + 1) % N;
      this.items[i] = this.items[j];
      return true;
    }

    // Item indexes already placed near (c, y): this column and four either side, within ~2 screens vertically.
    // Rows don't line up across columns (they're staggered), so nearness has to be measured in y, not row numbers.
    near(c, y, out) {
      const R = this.reach.r, C = this.reach.cols;
      for (let dc = -C; dc <= C; dc++) {
        const col = this.cols.get(c + dc);
        if (!col) continue;
        const d = col.down, u = col.up;
        // binary search to the first relevant entry: columns get long after a long pan
        let lo = 0, hi = d.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (d[m].y + d[m].h <= y - R) lo = m + 1; else hi = m; }
        for (let k = lo; k < d.length && d[k].y <= y + R; k++) out.add(this.real(d[k].i));
        lo = 0; hi = u.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (u[m].y >= y + R) lo = m + 1; else hi = m; }
        for (let k = lo; k < u.length && u[k].y + u[k].h >= y - R; k++) out.add(this.real(u[k].i));
      }
      return out;
    }

    real(i) { return i >= 0 ? i : this.fill.has(i) ? this.fill.get(i) : -1; }

    // Only used once every pin is already out: a full-cycle walk (stride coprime to N), nudged until the pick
    // isn't already anywhere near this spot.
    repeatFor(c, r, y) {
      const N = this.items.length;
      if (N < 2) return 0;
      const lap = this.repeats++;
      let stride = 1 + 2 * Math.floor(hash(lap >> 6, 17, this.salt) * (N / 2));
      while (gcd(stride, N) !== 1) stride++;
      let i = (Math.floor(hash(c, r, this.salt + 41) * N) * stride) % N;
      const near = this.near(c, y, new Set());
      for (let t = 0; t < N && near.has(i); t++) i = (i + stride) % N;
      return i;
    }

    assign(c, r, y) {
      const key = c + "," + r;
      let i = this.cells.get(key);
      if (i !== undefined) return i;
      // pins are short: spots off screen wait, so the few pins in hand go where you're looking
      const v = this.view, h = this.height(this.next);
      const off = v && !(c * COL + W / 2 > v.x0 && c * COL - W / 2 < v.x1 && y + h > v.y0 && y < v.y1);
      if (this.next < this.items.length && !(off && this.open && !this.fallback && this.remaining() < 60)) i = this.next++;
      else if (this.open && !this.fallback) i = -++this.spots; // a waiting spot, filled when a pin arrives
      else if (this.fallback && this.fbNext < this.fallback.length) {
        // on a pin page: use the feed you came from before repeating anything
        while (this.fbNext < this.fallback.length && this.ids.has(this.fallback[this.fbNext].id)) this.fbNext++;
        if (this.fbNext < this.fallback.length) { this.add([this.fallback[this.fbNext++]]); i = this.next++; }
        else i = this.repeatFor(c, r, y);
      } else if (this.items.length) i = this.repeatFor(c, r, y);
      else i = -++this.spots; // nothing at all to show yet
      this.cells.set(key, i);
      return i;
    }

    colOffset(c) { return (hash(c, 0, this.salt) - 0.5) * JITTER; }

    column(c) {
      let col = this.cols.get(c);
      if (!col) this.cols.set(c, (col = { down: [], up: [] }));
      return col;
    }

    // Grow column c until it covers [y0, y1]. Cells grown while inside `view` take fresh pins.
    grow(c, y0, y1) {
      const col = this.column(c);
      const d = col.down, u = col.up;
      if (col.block === undefined) col.block = this._blockFor(c);
      const bl = col.block;
      while (!d.length || d[d.length - 1].y + d[d.length - 1].h < y1) {
        const r = d.length;
        const y = r ? d[r - 1].y + d[r - 1].h + GAP : bl ? bl.y1 + GAP : this.colOffset(c);
        const i = this.assign(c, r, y);
        d.push({ y, h: this.height(i), i, r });
      }
      while (!u.length || u[u.length - 1].y > y0) {
        const r = -1 - u.length;
        const top = u.length ? u[u.length - 1].y : bl ? bl.y0 : d[0].y;
        const i = this.assign(c, r, top);
        const h = this.height(i);
        u.push({ y: top - GAP - h, h, i, r });
      }
      return col;
    }

    // All tiles intersecting rect (world units). view = the actual on-screen rect (no overscan).
    query(rect, view, out) {
      out.length = 0;
      this.view = view;
      const c0 = Math.floor((rect.x0 + W / 2) / COL), c1 = Math.ceil((rect.x1 - W / 2) / COL) + 1;
      let maxSeen = 0;
      for (let c = c0; c <= c1; c++) {
        const col = this.grow(c, rect.y0, rect.y1);
        for (const list of [col.down, col.up]) {
          // lists are monotonic in y: binary search the first tile below rect.y0
          const asc = list === col.down;
          let lo = 0, hi = list.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const t = list[mid];
            const before = asc ? t.y + t.h < rect.y0 : t.y > rect.y1;
            if (before) lo = mid + 1; else hi = mid;
          }
          for (let k = lo; k < list.length; k++) {
            const t = list[k];
            if (asc ? t.y > rect.y1 : t.y + t.h < rect.y0) break;
            if (t.i > maxSeen) maxSeen = t.i; // waiting spots are negative and don't count
            const j = t.i >= 0 ? t.i : this.at(t.i, c, t.y, c * COL + W / 2 > view.x0 && c * COL - W / 2 < view.x1 && t.y + t.h > view.y0 && t.y < view.y1, t.h);
            out.push({ key: c + "," + t.r, c, x: c * COL, y: t.y, w: W, h: t.h, i: j < 0 ? t.i : j, item: j < 0 ? WAIT : this.items[j] });
          }
        }
      }
      return maxSeen;
    }

    // World-space centre of the rank-0 tile, for opening the camera on it.
    origin() {
      if (this.focus) return { x: this.focus.x, y: this.focus.y };
      const col = this.grow(0, -1, 1);
      const t = col.down[0];
      return { x: 0, y: t.y + t.h / 2 };
    }
  }

  g.__pfLayout = { World, hash, spiralAt, COL, W, GAP };
})();

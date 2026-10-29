// Shared by both worlds: turns any Pinterest JSON payload into a flat, ordered list of pins.
// It walks the tree instead of knowing resource names, so it survives Pinterest renaming endpoints.
(function () {
  "use strict";
  const g = globalThis;
  if (g.__pfExtract) return;

  const SIZE_RE = /\/(\d+x(?:\d+)?|originals)\//;
  const sized = (url, size) => (typeof url === "string" && SIZE_RE.test(url) ? url.replace(SIZE_RE, "/" + size + "/") : url || null);

  // Pinterest lists HLS and MP4 renditions; browsers play MP4 without a player library, so take the MP4.
  function findVideo(o) {
    const stack = [[o, 0]];
    let budget = 400;
    while (stack.length && budget-- > 0) {
      const [v, d] = stack.pop();
      if (!v || typeof v !== "object" || d > 7) continue;
      if (v.video_list && typeof v.video_list === "object") {
        let best = null;
        for (const r of Object.values(v.video_list)) {
          if (!r || typeof r.url !== "string" || !/^https:\/\/[\w.-]*pinimg\.com\/.+\.mp4(\?|$)/.test(r.url)) continue;
          if (!best || Math.abs((r.width || 720) - 480) < Math.abs((best.width || 720) - 480)) best = r;
        }
        if (best) return { url: best.url, w: best.width || 0, h: best.height || 0 };
      }
      for (const k in v) if (k !== "images" && v[k] && typeof v[k] === "object") stack.push([v[k], d + 1]);
    }
    return null;
  }

  function normalize(o) {
    const im = o.images;
    if (!im || typeof im !== "object" || Array.isArray(im)) return null;
    if (o.type && o.type !== "pin") return null;
    if (o.is_promoted === true) return null; // ads stay on Pinterest; the field is your feed only
    const id = String(o.id);
    if (!/^[\w-]{1,120}$/.test(id)) return null; // numeric when logged in, opaque "e1_..." when logged out
    const s = im["236x"], m = im["474x"], l = im["736x"], orig = im.orig || im.originals;
    const any = [s, m, l, orig].find((v) => v && typeof v.url === "string");
    if (!any) return null;
    const ref = [orig, l, m, s].find((v) => v && v.width > 0 && v.height > 0) || any;
    return {
      id,
      w: +ref.width || 0,
      h: +ref.height || 0,
      color: typeof o.dominant_color === "string" ? o.dominant_color : null,
      title: String(o.grid_title || o.title || o.auto_alt_text || "").slice(0, 140),
      link: typeof o.link === "string" && /^https?:\/\//.test(o.link) ? o.link : null,
      video: findVideo(o),
      src: {
        s: (s && s.url) || sized(any.url, "236x"),
        m: (m && m.url) || sized(any.url, "474x"),
        l: (l && l.url) || sized(any.url, "736x"),
        o: (orig && orig.url) || sized(any.url, "originals"),
      },
    };
  }

  // Iterative DFS in document order. Bounded so a pathological payload can't stall the page.
  function collect(root, out, seen) {
    const stack = [root];
    let budget = 300000;
    while (stack.length && budget-- > 0) {
      const v = stack.pop();
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i] === "object") stack.push(v[i]);
        continue;
      }
      if (v.images && v.id != null) {
        const p = normalize(v);
        if (p) {
          if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
          continue; // a pin's own subtree (board, pinner, rich metadata) is big and holds no feed pins
        }
      }
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        const c = v[keys[i]];
        if (c && typeof c === "object") stack.push(c);
      }
    }
    return out;
  }

  // Pinterest's own refinements for a search ("rankedGuides"): a term plus a small picture of it.
  function guidesFrom(root) {
    const stack = [root];
    let budget = 20000;
    while (stack.length && budget-- > 0) {
      const v = stack.pop();
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v.rankedGuides)) {
        return v.rankedGuides
          .filter((x) => x && typeof x.term === "string" && x.term.length < 120)
          .slice(0, 24)
          .map((x) => ({
            term: x.term,
            label: typeof x.display === "string" ? x.display.slice(0, 60) : x.term,
            img: typeof x.image_medium_url === "string" && /^https:\/\/i\.pinimg\.com\//.test(x.image_medium_url) ? x.image_medium_url : null,
            color: typeof x.dominant_color === "string" && /^#[0-9a-f]{6}$/i.test(x.dominant_color) ? x.dominant_color : null,
          }));
      }
      for (const k in v) if (k !== "results" && v[k] && typeof v[k] === "object") stack.push(v[k]);
    }
    return null;
  }

  g.__pfExtract = { collect, normalize, sized, guidesFrom };
})();

// Page world. Listens to the responses Pinterest already asks for and passes the pins on.
// It never changes a response. Its own requests are the ones Pinterest's page would send anyway: the next page of
// the feed you're on (see `more`), and the buttons you press.
(function () {
  "use strict";
  if (window.__pfHook) return;
  window.__pfHook = 1;
  const X = window.__pfExtract;
  const ric = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 400 }) : (f) => setTimeout(f, 0);
  const wanted = (u) => typeof u === "string" && /\/resource\/|\/_ngjs\/|\/v3\//.test(u);

  // `at` is the page the request was made from, so a late answer for the old page isn't filed under the new one
  const emit = (pins, req, at) => {
    if (!pins.length) return;
    document.dispatchEvent(new CustomEvent("pf:pins", { detail: JSON.stringify({ pins, req, at }) }));
  };
  const here = () => location.pathname + location.search;
  // same page key as the field uses (main.js norm), so a feed is found again under the page it belongs to
  function norm(u) {
    let x;
    try { x = new URL(u, location.origin); } catch { return null; }
    const p = x.pathname.replace(/\/+$/, "") + "/";
    if (p.startsWith("/search/")) return p + "?q=" + (x.searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ");
    return p;
  }
  // Each feed's own next-page request, as Pinterest last sent it, with the bookmark its answer gave back.
  // Replaying it asks for exactly the page Pinterest's own scrolling would, without its hidden page rendering it.
  const feeds = new Map();
  function noteFeed(url, headers, json, n) {
    const rr = json && json.resource_response;
    if (!rr || typeof rr.bookmark !== "string" || typeof url !== "string" || !/\/resource\/\w+\/get\/\?/.test(url)) return;
    let src = null;
    try { src = new URL(url, location.origin).searchParams.get("source_url"); } catch {}
    const k = src && norm(src);
    if (!k || n < 8) return; // a side request (a carousel, a board picker) isn't the feed
    const name = (url.match(/\/resource\/(\w+)\//) || [])[1] || "";
    const old = feeds.get(k);
    // the page's feed is the request that brings the most pins; a later page of the same feed replaces it
    if (old && old.name !== name && old.n > n) return;
    feeds.set(k, { url, headers: headers || {}, bookmark: rr.bookmark, name, n });
  }
  const plainHeaders = (h) => {
    const o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === "function" && !Array.isArray(h)) h.forEach((v, k) => { o[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) o[k] = v;
      else for (const k of Object.keys(h)) o[k] = String(h[k]);
    } catch {}
    return o;
  };
  // Parse off the critical path: Pinterest has already rendered by the time we look.
  const fromText = (req, text, at, headers) => {
    if (!text || text.indexOf('"images"') < 0) return;
    ric(() => {
      let json;
      try { json = JSON.parse(text); } catch { return; }
      const pins = X.collect(json, [], new Set());
      if (pins.length) noteFeed(req, headers, json, pins.length);
      emit(pins, req, at);
      if (text.indexOf('"rankedGuides"') >= 0) {
        const guides = X.guidesFrom(json);
        if (guides && guides.length) document.dispatchEvent(new CustomEvent("pf:guides", { detail: JSON.stringify({ guides, req, at }) }));
      }
    });
  };

  const nativeFetch = window.fetch;
  window.fetch = function (input) {
    const p = nativeFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (wanted(url)) {
        const at = here();
        const init = arguments[1];
        const headers = plainHeaders((init && init.headers) || (typeof input === "object" && input.headers));
        p.then((r) => {
          if (r.ok && (r.headers.get("content-type") || "").includes("json")) r.clone().text().then((t) => fromText(url, t, at, headers), () => {});
        }, () => {});
      }
    } catch {}
    return p;
  };

  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, setH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__pfUrl = String(url);
    this.__pfH = {};
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__pfH) this.__pfH[k] = String(v); } catch {}
    return setH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (wanted(this.__pfUrl)) {
      const at = here();
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") fromText(this.__pfUrl, this.responseText, at, this.__pfH);
          else if (this.responseType === "json" && this.response) emit(X.collect(this.response, [], new Set()), this.__pfUrl, at);
        } catch {}
      });
    }
    return send.apply(this, arguments);
  };

  // Route changes inside Pinterest's single-page app.
  const nav = () => document.dispatchEvent(new CustomEvent("pf:nav"));
  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      nav();
      return r;
    };
  }
  window.addEventListener("popstate", nav);

  // ---------- actions the field asks for (only when you press a button) ----------
  // Same requests Pinterest's own buttons send, from Pinterest's own page with your session.
  const csrf = () => (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
  async function resource(name, action, options, sourceUrl) {
    const token = csrf();
    if (!token) throw new Error("not signed in");
    const body = "source_url=" + encodeURIComponent(sourceUrl) + "&data=" + encodeURIComponent(JSON.stringify({ options, context: {} }));
    const r = await nativeFetch.call(window, "/resource/" + name + "/" + action + "/", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": token,
        "X-Requested-With": "XMLHttpRequest",
        "X-Pinterest-PWS-Handler": "www/[username]/[slug].js",
      },
      body,
    });
    let j = null;
    try { j = await r.json(); } catch {}
    const rr = j && j.resource_response;
    if (!r.ok || !rr) throw new Error((rr && rr.error && rr.error.message) || "HTTP " + r.status);
    return { data: rr.data, bookmark: rr.bookmark || null };
  }
  const digits = (v) => typeof v === "string" && /^\d{1,30}$/.test(v);
  const pinimg = (u) => typeof u === "string" && /^https:\/\/i\.pinimg\.com\//.test(u);

  // A read-only GET, the same shape Pinterest's own page uses for these.
  async function getRes(name, options, src) {
    const data = JSON.stringify({ options, context: {} });
    const r = await nativeFetch.call(window, "/resource/" + name + "/get/?source_url=" + encodeURIComponent(src) + "&data=" + encodeURIComponent(data) + "&_=" + Date.now(), {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest", "X-Pinterest-Source-Url": src, "X-Pinterest-PWS-Handler": "www/ideas.js" },
    });
    const j = await r.json();
    return j && j.resource_response && j.resource_response.data;
  }

  function boardOf(b) {
    // Pinterest puts a board's pin previews in different fields depending on the field set,
    // so take whichever ones this response carries (the custom cover is kept apart).
    const pick = (v) => (typeof v === "string" ? v : v && (v.url || (v["236x"] && v["236x"].url) || (v.orig && v.orig.url)));
    const pool = [];
    if (Array.isArray(b.pin_thumbnail_urls)) pool.push(...b.pin_thumbnail_urls);
    if (b.images && typeof b.images === "object") for (const k of Object.keys(b.images)) if (Array.isArray(b.images[k])) pool.push(...b.images[k]);
    const thumbs = [...new Set(pool.map(pick).filter(pinimg))];
    const owner = b.owner && typeof b.owner === "object" ? b.owner : null;
    return {
      id: String(b.id),
      name: String(b.name || "").slice(0, 80),
      url: typeof b.url === "string" ? b.url : null,
      cover: [b.image_cover_hd_url, b.image_cover_url, thumbs[0]].find(pinimg) || null,
      thumbs: thumbs.slice(0, 6),
      count: b.pin_count || 0,
      sections: b.section_count || 0,
      privacy: b.privacy === "secret" || b.privacy === "protected" ? "Secret" : "Public",
      owner: owner ? String(owner.full_name || owner.username || "").slice(0, 60) : null,
      last: b.board_order_modified_at || b.last_pinned_to || null,
    };
  }

  // Pinterest server-renders its Explore data into the page as Relay payloads.
  function relayFrom(html) {
    const out = [];
    const re = /__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\("[^"]*",\s*(\{[\s\S]*?\})\)\s*;?\s*<\/script>/g;
    let m;
    while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1])); } catch {} }
    return out;
  }
  // ...and the page's own initial state, where older pages keep theirs
  function pwsFrom(html) {
    const out = [];
    for (const id of ["__PWS_DATA__", "__PWS_INITIAL_PROPS__"]) {
      const m = html.match(new RegExp('<script[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</script>'));
      if (m) { try { out.push(JSON.parse(m[1])); } catch {} }
    }
    return out;
  }
  const grabHtml = async (path) => {
    const r = await nativeFetch.call(window, path, { credentials: "include", headers: { Accept: "text/html" } });
    return { html: await r.text(), at: new URL(r.url).pathname };
  };
  const textOf = (t) => (typeof t === "string" ? t : t && typeof t.format === "string" ? t.format : "");
  // Signed in, Explore is Pinterest's "Today" page of stories. Its shape isn't known here, so look for
  // anything story-like: a title with a picture.
  function storiesFrom(roots) {
    const out = [], seenT = new Set(), stack = [...roots];
    let budget = 60000;
    while (stack.length && budget-- > 0) {
      const v = stack.pop();
      if (!v || typeof v !== "object") continue;
      const kind = String(v.__typename || v.type || "");
      const title = textOf(v.title);
      if (/article|story|today/i.test(kind) && title && title.length < 120 && !seenT.has(title)) {
        const img = findImg(v);
        if (img) { seenT.add(title); out.push({ title, img, color: (Array.isArray(v.dominant_colors) && v.dominant_colors[0]) || null }); continue; }
      }
      for (const k in v) if (v[k] && typeof v[k] === "object") stack.push(v[k]);
    }
    return out.slice(0, 16);
  }
  function findImg(o) {
    const stack = [[o, 0]];
    let budget = 200;
    while (stack.length && budget-- > 0) {
      const [v, d] = stack.pop();
      if (typeof v === "string") { if (pinimg(v) && /\.(jpe?g|png|webp)/.test(v)) return v; continue; }
      if (!v || typeof v !== "object" || d > 5) continue;
      for (const k of ["474x", "400x", "564x", "750x", "736x", "237x", "236x", "url", "image_url"]) {
        const x = v[k];
        if (pinimg(x)) return x;
        if (x && pinimg(x.url)) return x.url;
      }
      for (const k in v) stack.push([v[k], d + 1]);
    }
    return null;
  }

  const ops = {
    // the next page of the feed you're on, by replaying Pinterest's own request for it with the newer bookmark
    async more({ key }) {
      const f = feeds.get(key);
      if (!f) return { none: true };
      if (!f.bookmark || f.bookmark === "-end-") return { end: true, n: 0 };
      const u = new URL(f.url, location.origin);
      const data = JSON.parse(u.searchParams.get("data") || "{}");
      data.options = data.options || {};
      data.options.bookmarks = [f.bookmark];
      u.searchParams.set("data", JSON.stringify(data));
      u.searchParams.set("_", String(Date.now()));
      const req = u.pathname + u.search;
      const r = await nativeFetch.call(window, req, { credentials: "include", headers: f.headers });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const rr = j && j.resource_response;
      const pins = X.collect(j, [], new Set());
      f.url = req;
      f.bookmark = rr && typeof rr.bookmark === "string" ? rr.bookmark : "-end-";
      emit(pins, req, key);
      return { n: pins.length, end: f.bookmark === "-end-", name: f.name };
    },
    // Pinterest's Explore page: trending topics, interests, its curated boards and what's new.
    async explore({ signed }) {
      const [ideas, boards, tab, today] = await Promise.all([
        grabHtml("/ideas/").catch(() => null),
        getRes("BoardsFeedResource", { field_set_key: "profile_grid_item", filter_stories: false, sort: "last_pinned_to", username: "pinterest", page_size: 12 }, "/ideas/").catch(() => null),
        getRes("SearchTabResource", {}, "/ideas/").catch(() => null),
        signed ? grabHtml("/today/").catch(() => null) : null,
      ]);
      const relay = ideas ? relayFrom(ideas.html) : [];
      let interests = [], fresh = [];
      for (const j of relay) {
        const d = j && j.data;
        if (!d) continue;
        const iq = d.v3IdeasRootPageInterestsQuery;
        if (iq && Array.isArray(iq.data)) interests = iq.data.filter((x) => x && typeof x.name === "string").map((x) => ({ name: x.name.slice(0, 40), url: typeof x.url === "string" ? x.url : null }));
        const tq = d.v3GetTier1CandidatesQuery;
        const edges = tq && tq.data && tq.data.connection && tq.data.connection.edges;
        if (Array.isArray(edges)) for (const e of edges) {
          const n = e && e.node;
          if (!n || n.__typename !== "Pin") continue;
          const s = n.images_236x, m = n.images_474x, l = n.images_736x, o = n.images_orig;
          const ref = [o, l, m, s].find((x) => x && x.width > 0 && x.height > 0);
          if (!ref || !s || !pinimg(s.url)) continue;
          const id = String(n.entityId || "");
          if (!/^[\w-]{1,120}$/.test(id)) continue;
          fresh.push({ id, w: ref.width, h: ref.height, color: s.dominantColor || null, title: "", link: null, video: null,
            src: { s: s.url, m: (m && m.url) || s.url, l: (l && l.url) || s.url, o: (o && o.url) || (l && l.url) || s.url } });
        }
      }
      const popular = [];
      for (const st of Array.isArray(tab) ? tab : []) for (const o of (st && st.objects) || []) {
        if (!o || o.type !== "explorearticle") continue;
        const title = textOf(o.title), c = Array.isArray(o.cover_images) && o.cover_images[0];
        const img = c && [c["400x"], c["474x"], c["237x"], c["750x"]].map((x) => x && x.url).find(pinimg);
        if (title && img) popular.push({ title: title.slice(0, 80), img, color: (Array.isArray(o.dominant_colors) && o.dominant_colors[0]) || null });
      }
      const featured = (Array.isArray(boards) ? boards : []).filter((b) => b && b.type === "board" && b.url).map(boardOf);
      // signed out, /today/ sends you to /ideas/, so only count it when it stayed on /today/
      const stories = today && today.at.startsWith("/today") ? storiesFrom([...relayFrom(today.html), ...pwsFrom(today.html)]) : [];
      return { interests, fresh: fresh.slice(0, 30), popular, featured, stories };
    },
    // type into Pinterest's own (hidden) search box so it searches in-app, without reloading the page
    async search({ q }) {
      if (typeof q !== "string" || !q.trim() || q.length > 200) throw new Error("bad query");
      const input = document.querySelector('input[name="searchBoxInput"],input[data-test-id="search-box-input"]');
      if (!input) throw new Error("no search box");
      const before = location.href;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, q.trim());
      input.dispatchEvent(new Event("input", { bubbles: true }));
      for (const type of ["keydown", "keypress", "keyup"]) {
        input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      for (let i = 0; i < 15 && location.href === before; i++) await new Promise((r) => setTimeout(r, 100));
      if (location.href === before) throw new Error("search box didn't navigate");
      return true;
    },
    // Pinterest's own search autocomplete, the same request its search box sends as you type
    async typeahead({ term }) {
      if (typeof term !== "string" || !term.trim() || term.length > 100) return [];
      const data = JSON.stringify({ options: { pin_scope: "pins", autocomplete_request_surface: 0, count: 8, term: term.trim() }, context: {} });
      const src = location.pathname + location.search;
      const r = await nativeFetch.call(window, "/resource/AdvancedTypeaheadResource/get/?source_url=" + encodeURIComponent(src) + "&data=" + encodeURIComponent(data) + "&_=" + Date.now(), {
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest", "X-Pinterest-PWS-Handler": "www/search/[scope].js", "X-Pinterest-Source-Url": src },
      });
      const j = await r.json();
      const items = (j && j.resource_response && j.resource_response.data && j.resource_response.data.items) || [];
      return items
        .filter((x) => x && x.type === "query" && typeof x.query === "string")
        .slice(0, 8)
        .map((x) => ({ query: x.query.slice(0, 120), label: String(x.label || x.query).slice(0, 120) }));
    },
    async boards({ username }) {
      if (!/^[\w.-]{1,40}$/.test(username || "")) throw new Error("no username");
      const out = [];
      let bookmark = null;
      for (let page = 0; page < 6; page++) {
        const options = { username, sort: "last_pinned_to", privacy_filter: "all", field_set_key: "profile_grid_item", page_size: 50 };
        if (bookmark) options.bookmarks = [bookmark];
        const { data, bookmark: next } = await resource("BoardsResource", "get", options, "/" + username + "/");
        const list = Array.isArray(data) ? data : (data && data.results) || [];
        for (const b of list) {
          if (!b || !b.id || b.type === "story") continue;
          out.push(boardOf(b));
        }
        if (!next || next === "-end-" || !list.length) break;
        bookmark = next;
      }
      return out;
    },
    async profile({ username }) {
      if (!/^[\w.-]{1,40}$/.test(username || "")) throw new Error("no username");
      const { data: u } = await resource("UserResource", "get", { username, field_set_key: "profile" }, "/" + username + "/");
      if (!u) throw new Error("no profile");
      return {
        username: u.username || username,
        name: String(u.full_name || u.first_name || username).slice(0, 80),
        avatar: u.image_xlarge_url || u.image_large_url || u.image_medium_url || null,
        followers: u.follower_count || 0,
        following: u.following_count || 0,
        pins: u.pin_count || 0,
        boards: u.board_count || 0,
      };
    },
    // no board_id: Pinterest files it under your profile (Quick Saves)
    // a new board, as Pinterest's own "Create board" sends it
    async createBoard({ name, secret }) {
      name = typeof name === "string" ? name.trim() : "";
      if (!name || name.length > 100) throw new Error("bad name");
      const options = { name, description: "", category: "other", privacy: secret ? "secret" : "public", layout: "default", collab_board_email: false, collaborator_invites_enabled: true };
      const { data } = await resource("BoardResource", "create", options, "/");
      if (!data || !data.id) throw new Error("Pinterest didn't create the board");
      return boardOf(data);
    },
    async save({ pinId, boardId }) {
      if (!digits(pinId) || (boardId != null && !digits(boardId))) throw new Error("bad id");
      const options = { pin_id: pinId };
      if (boardId) options.board_id = boardId;
      const { data } = await resource("RepinResource", "create", options, "/pin/" + pinId + "/");
      if (!data || !data.id) throw new Error("Pinterest didn't confirm the save");
      return { id: String(data.id), board: (data.board && data.board.name) || null };
    },
    // undo a save: delete the copy that saving made (Pinterest's own "remove" does the same)
    async unsave({ savedId }) {
      if (!digits(savedId)) throw new Error("bad id");
      await resource("PinResource", "delete", { id: savedId }, "/pin/" + savedId + "/");
      return true;
    },
    async download({ url, name }) {
      if (typeof url !== "string" || !/^https:\/\/i\.pinimg\.com\//.test(url)) throw new Error("bad url");
      const r = await nativeFetch.call(window, url, { credentials: "omit" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (name || "pin").replace(/[^\w.-]+/g, "_") + "." + ((blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg"));
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return true;
    },
    // select mode: does this size exist? (some pins have no "originals"; i.pinimg.com answers 403 for those)
    // asked from here because i.pinimg.com only lets pinterest.com read its answers
    async probe({ url }) {
      if (typeof url !== "string" || !/^https:\/\/i\.pinimg\.com\//.test(url)) throw new Error("bad url");
      const r = await nativeFetch.call(window, url, { method: "HEAD", credentials: "omit" });
      return r.ok;
    },
  };
  document.addEventListener("pf:api", async (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch { return; }
    const fn = ops[req && req.op];
    let res;
    try { res = { id: req.id, ok: true, data: fn ? await fn(req.args || {}) : null }; }
    catch (err) { res = { id: req.id, ok: false, error: String((err && err.message) || err) }; }
    document.dispatchEvent(new CustomEvent("pf:api:res", { detail: JSON.stringify(res) }));
  });
})();

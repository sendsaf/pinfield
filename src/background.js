// Background: saves the pins you selected into one folder with the browser's downloads API (content scripts
// can't call it). A service worker in Chrome, an event page in Firefox: the same file works as both.
(function () {
  "use strict";
  const api = globalThis.browser || globalThis.chrome;

  const URL_RE = /^https:\/\/i\.pinimg\.com\/[\w./-]+$/;
  const ID_RE = /^[\w-]{1,120}$/;
  // a folder name every OS accepts: no path characters, no control characters, no leading or trailing dots
  const cleanFolder = (s) =>
    String(s || "").replace(/[\u0000-\u001f<>:"/\\|?*~]+/g, " ").replace(/\s+/g, " ").trim()
      .replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80) || "Pinfield";
  const extOf = (url) => ((url.match(/\.(jpe?g|png|gif|webp)$/i) || [])[1] || "jpg").toLowerCase().replace("jpeg", "jpg");

  // download id -> callback, resolved when the browser finishes (or gives up on) that file
  const waiting = new Map();
  api.downloads.onChanged.addListener((d) => {
    const done = waiting.get(d.id);
    if (!done || !d.state) return;
    if (d.state.current === "complete") done(true);
    else if (d.state.current === "interrupted") done(false);
  });
  function finished(id) {
    return new Promise((resolve) => {
      // shortcut: a file still going after 2 minutes counts as saved; it stays in the browser's download list
      const t = setTimeout(() => end(true), 120000);
      const end = (ok) => { clearTimeout(t); waiting.delete(id); resolve(ok); };
      waiting.set(id, end);
      // a small file can finish before we start listening
      api.downloads.search({ id }).then(([d]) => {
        if (d && d.state === "complete") end(true);
        else if (d && d.state === "interrupted") end(false);
      }, () => {});
    });
  }

  async function saveAll({ folder, files }) {
    const dir = "Pinfield/" + cleanFolder(folder) + "/";
    const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.url === "string" && URL_RE.test(f.url) && ID_RE.test(String(f.id))).slice(0, 500);
    const width = String(list.length).length;
    const started = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const filename = dir + String(i + 1).padStart(width, "0") + "-" + f.id + "." + extOf(f.url);
      try {
        const id = await api.downloads.download({ url: f.url, filename, conflictAction: "uniquify", saveAs: false });
        started.push(finished(id));
      } catch { started.push(Promise.resolve(false)); }
    }
    const ok = (await Promise.all(started)).filter(Boolean).length;
    const asked = Array.isArray(files) ? Math.min(files.length, 500) : 0;
    return { ok, failed: asked - ok, folder: dir };
  }

  api.runtime.onMessage.addListener((msg, sender, reply) => {
    // only Pinfield's own script on a Pinterest tab may ask
    if (!msg || msg.type !== "pf:download" || sender.id !== api.runtime.id || !sender.tab) return;
    if (!/^https:\/\/([\w-]+\.)*pinterest\.[a-z.]+\//.test(sender.url || "")) return;
    saveAll(msg).then(reply, (err) => reply({ ok: 0, failed: 0, error: String((err && err.message) || err) }));
    return true; // the answer comes later
  });
})();

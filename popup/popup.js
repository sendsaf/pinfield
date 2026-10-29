// Toolbar popup: who made Pinfield and where to send feedback.
// If Pinfield goes open source, set REPO to the public repository: issues and feature
// requests then open GitHub's issue form, and the GitHub row points at the repository.
// While REPO is empty, both go to email and the GitHub row points at the profile.
const LINKS = {
  site: "https://designedbysaf.site",
  email: "work@designedbysaf.site",
  profile: "https://github.com/sendsaf",
  REPO: "https://github.com/sendsaf/pinfield",
};

const api = globalThis.browser || globalThis.chrome;
const version = api.runtime.getManifest().version;
const ua = navigator.userAgent;
const ff = ua.match(/Firefox\/([\d.]+)/), cr = ua.match(/Chrome\/([\d.]+)/);
const browserName = ff ? `Firefox ${ff[1]}` : cr ? `Chrome ${cr[1]}` : "Unknown browser";
const env = `Pinfield ${version} · ${browserName} · ${navigator.platform || ""}`.trim();

const $ = (id) => document.getElementById(id);
$("ver").textContent = `Version ${version}`;
$("site").href = LINKS.site;

function feedback(kind) {
  const bug = kind === "bug";
  const title = bug ? "Bug: " : "Idea: ";
  const body = bug
    ? `What happened:\n\n\nWhat you expected:\n\n\nPage (home, search, board, pin...):\n\n\n${env}`
    : `What you'd like Pinfield to do:\n\n\nWhy it would help:\n\n\n${env}`;
  if (LINKS.REPO) {
    const q = new URLSearchParams({ title, body, labels: bug ? "bug" : "enhancement" });
    return `${LINKS.REPO}/issues/new?${q}`;
  }
  const subject = bug ? "Pinfield: issue report" : "Pinfield: feature request";
  return `mailto:${LINKS.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
$("bug").href = feedback("bug");
$("idea").href = feedback("idea");
$("gh").href = LINKS.REPO || LINKS.profile;

// links from a popup open in a new tab; close the popup after, so it doesn't sit over the page
for (const a of document.querySelectorAll("a[href]")) {
  a.addEventListener("click", () => setTimeout(() => window.close(), 50));
}

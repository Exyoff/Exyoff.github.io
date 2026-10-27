// THE GAME OFFLINE (the user, 2026-10-27: "make the game cache-able via
// android and apple's guidelines so it can load the game offline").
//
// The service worker the page registers once its game has run
// (tools/web_template/index.html, keepOffline). tools/build_web.py copies it
// beside the page as it is: it names no build, so a publish that changes only
// the game leaves it alone, and a browser installs it again only when THIS
// file changes. What it keeps is told it by the page.
//
// ONE WHOLE BUILD, kept in a cache named for its stamp -- the ?v= on every
// file the page asks for (build_web.py's build_stamp) -- "minioutbreak-<stamp>":
// the page, the engine (love.js, love.wasm), the game (game.js, game.data),
// the manifest and the icons, 24 MB. Nothing else of the site's.
//
// A BUILD IS KEPT WHOLE OR NOT AT ALL, and only once it has run. Each file of
// a build that comes through here is put in its build's cache as it streams
// past to the page, so a new build is downloaded once, not once for the page
// and again for the cache. But only a cache with the page in it is ever
// opened offline, and the page goes in when the page itself says its game is
// on the screen, handing over its files and their SHA-256s: each is checked
// -- fetched now if it never came through here, as on the first visit, which
// loads before this is installed -- the page fetched afresh beside them, and
// every other build's cache deleted. A download cut off, or a build that
// never booted, never takes the place of the one that did.
//
// THE PAGE COMES FROM THE NETWORK FIRST, so a phone that is online opens the
// newest build, as it did before this; from the kept build when the network
// fails, or has not answered in PAGE_WAIT -- a connection that is up and
// carries nothing hangs a fetch for a minute. The kept page asks for the kept
// build's files only, and every one of them is here.
//
// A file of a build is answered from whichever cache holds it, and from the
// network when none does. Anything without a ?v=, and anything not this
// site's, is left to the browser as if this were not here.

"use strict";

const PREFIX = "minioutbreak-";

// How long the network has to answer for the page before the kept one is
// opened. A page that is online answers GitHub Pages in well under a second.
const PAGE_WAIT = 4000;

// The page's own address: this worker's scope, the folder the page is served
// from. Opened as "./", "index.html" or "?dpr=1", it is kept under this one.
const PAGE = self.registration.scope;
const PAGE_PATHS = [new URL(PAGE).pathname, new URL("index.html", PAGE).pathname];

self.addEventListener("install", (event) => {
  // Nothing to fetch: the page hands over its build once it has run. In at
  // once -- nothing here belongs to one build, so an older copy of this file
  // has nothing to finish.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // The page's request sent while this worker starts, not after: a phone
    // can take a few hundred milliseconds to start one.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* asked for afresh */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    if (PAGE_PATHS.indexOf(url.pathname) !== -1) event.respondWith(openPage(event));
    return;
  }
  const build = url.searchParams.get("v");
  if (build) event.respondWith(buildFile(event, build));
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "keep" || !/^[0-9a-f]{6,64}$/.test(String(data.build))) return;
  if (!Array.isArray(data.files)) return;
  // Kept or not, the game goes on: a build not kept now is asked again at the
  // next load that reaches the network.
  event.waitUntil(keep(data.build, data.files).catch(() => {}));
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPage(event) {
  const network = Promise.resolve(event.preloadResponse)
    .then((preloaded) => preloaded || fetch(event.request));
  // Never left to dangle: a preload nobody waits on is cancelled, with a
  // warning in the console.
  event.waitUntil(network.catch(() => {}));
  const answer = await Promise.race([network.catch(() => null), wait(PAGE_WAIT).then(() => null)]);
  if (answer && answer.ok) return answer;
  const kept = await keptPage();
  if (kept) return kept;
  // Nothing kept: the network's own answer, however long it takes, whatever
  // it is -- what the browser would have shown with no worker.
  return answer || network;
}

// The kept build's page. There is only ever one: keeping a build deletes the
// others, and a cache without the page is a build still coming in.
async function keptPage() {
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const page = await (await caches.open(name)).match(PAGE, { ignoreVary: true });
    if (page) return page;
  }
  return null;
}

async function buildFile(event, build) {
  const request = event.request;
  const kept = await caches.match(request.url, { ignoreVary: true });
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    // Streamed to the page and into the cache at once; a download cut off
    // stores nothing, since a cache entry is written whole or not at all.
    const copy = response.clone();
    event.waitUntil(caches.open(PREFIX + build)
      .then((cache) => cache.put(request.url, copy))
      .catch(() => {}));
  }
  return response;
}

async function sha256(buffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Only what the browser needs to serve it again: the body stands whole in
// the cache, decoded, so the network's length and encoding would be wrong.
function stored(body, from) {
  const type = from.headers.get("Content-Type");
  return new Response(body, { headers: type ? { "Content-Type": type } : {} });
}

async function keep(build, files) {
  const name = PREFIX + build;
  const cache = await caches.open(name);

  // Checked once: a build whose page is here was whole when it went in.
  if (!(await cache.match(PAGE, { ignoreVary: true }))) {
    for (const file of files) {
      const url = new URL(String(file.url), PAGE);
      if (url.origin !== self.location.origin) throw new Error("not this site's: " + url);
      const have = await cache.match(url.href, { ignoreVary: true });
      if (have && (await sha256(await have.arrayBuffer())) === file.sha256) continue;
      // Not through here, or not this build's bytes. The browser's own cache
      // first: on a first visit the page fetched it a moment ago.
      const fetched = await fetch(url.href, { cache: "force-cache" });
      if (!fetched.ok) throw new Error(fetched.status + " for " + url);
      const body = await fetched.arrayBuffer();
      // A file of the same name from a newer publish would mix two builds.
      if ((await sha256(body)) !== file.sha256) throw new Error("another build's " + url);
      await cache.put(url.href, stored(body, fetched));
    }
  }

  // The page, afresh -- a conditional request, nothing sent back when it has
  // not changed -- so that what is kept is the page that ran, not an older
  // copy the browser held. One that asks for another build's files means the
  // site has moved on since this page was loaded: that build is kept when it
  // has run.
  const page = await fetch(PAGE, { cache: "no-cache" });
  if (!page.ok) throw new Error(page.status + " for the page");
  const html = await page.text();
  if (html.indexOf("game.js?v=" + build) === -1) throw new Error("the page is another build's");
  await cache.put(PAGE, stored(html, page));

  for (const other of await caches.keys()) {
    if (other.startsWith(PREFIX) && other !== name) await caches.delete(other);
  }
}

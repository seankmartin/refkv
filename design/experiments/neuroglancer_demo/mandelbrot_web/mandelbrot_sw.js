// Service worker for mandelbrot_pyramid.vzip (see make_mandelbrot_pyramid.py).
//
// Windows. Window (d, ix, iy) is the square of side 4 * 2^-d centred on
// ROOT + (ix, iy) * g_d, with grid step g_d = 4 * 2^-(d + 4) (ix, iy are
// BigInts in the URL). Its 15-level pyramid has level-0 pixels of
// 4 * 2^-(d + 22). Every tile of level L <= 10 of every window then lies on
// one absolute pixel grid per pixel size, so windows at different depths or
// centres share tiles exactly (and the tile cache is keyed absolutely).
//
// 1. Archive: `.../z/<d>/<ix>/<iy>/mandelbrot_pyramid.vzip` is answered with
//    the one static archive (`.../mandelbrot_pyramid.vzip`), so its relative
//    tile URLs carry the window.
// 2. Tiles: `.../[z/<d>/<ix>/<iy>/]mandelbrot_pyramid/L{level}.bin` are
//    virtual files: a row-major sequence of Zarr v3 `sharding_indexed` shards
//    of uint8 pixels (inner 256x256 chunks uncompressed in C order over
//    [x, y], then the index of little-endian uint64 (offset, nbytes) pairs).
//    Range requests are answered by computing the overlapped chunks.
//    Without `z/...` the window is the root window (0, 7, 8).
// 3. Neuroglancer's page gets `mandelbrot_infinite.js` injected, which moves
//    between windows as you zoom and pan.

importScripts("/mandelbrot_tile.js"); // TILE, TILE_BYTES, ROOT_X, ROOT_Y, computeTile

const N0 = 1 << 22;
const SHARD = 16384;
const LEVELS = 15;
const DEFAULT_WINDOW = { d: 0, ix: 7n, iy: 8n }; // centre -0.75 + 0i

function geometry(level) {
  const n = N0 / 2 ** level;
  const s = Math.min(SHARD, n);
  const per = s / TILE;
  const dataBytes = per * per * TILE_BYTES;
  const shardBytes = dataBytes + per * per * 16;
  const ns = n / s;
  return { n, s, per, dataBytes, shardBytes, ns, total: ns * ns * shardBytes };
}

const indexCache = new Map();
function shardIndex(g) {
  let idx = indexCache.get(g.per);
  if (idx === undefined) {
    idx = new Uint8Array(g.per * g.per * 16);
    const v = new DataView(idx.buffer);
    for (let k = 0; k < g.per * g.per; k++) {
      v.setBigUint64(16 * k, BigInt(k * TILE_BYTES), true);
      v.setBigUint64(16 * k + 8, BigInt(TILE_BYTES), true);
    }
    indexCache.set(g.per, idx);
  }
  return idx;
}

// Small LRU of computed tiles.
const tiles = new Map();
const MAX_TILES = 2048;

// Absolute pixel origin (BigInt) of tile (tx, ty) of `level` of window `win`:
// ix * 2^(18 - L) - 2^(21 - L) + 256 * tx, in pixels of size 4 * 2^-e,
// e = d + 22 - L.
function tileOrigin(win, level, tx, ty) {
  const L = BigInt(level);
  const half = 1n << (21n - L);
  return {
    e: win.d + 22 - level,
    x: win.ix * (1n << (18n - L)) - half + BigInt(tx * TILE),
    y: win.iy * (1n << (18n - L)) - half + BigInt(ty * TILE),
  };
}

// Tiles are computed by a pool of workers in a page we control (a service
// worker cannot start workers itself), or here if no page is open. The page
// decides what to compute when: it parks jobs for tiles that are out of view
// (Chrome does not pass a client's abort on to the service worker's
// request.signal, so the view is the only reliable signal), and may give up
// on one with `null`, which fails the request rather than inventing pixels.
const pending = new Map(); // key -> { promise, waiters, id }
let nextJob = 0;

async function poolClient() {
  const all = await self.clients.matchAll({ type: "window" });
  return all.find((c) => c.url.includes("#!") || c.url.endsWith("/")) ?? all[0];
}

async function computeRemote(o, key) {
  const client = await poolClient();
  if (client === undefined) return computeTile(o);
  const id = nextJob++;
  const channel = new MessageChannel();
  const result = new Promise((resolve) => {
    channel.port1.onmessage = (m) => resolve(m.data);
  });
  client.postMessage({ type: "tile", id, key, e: o.e, x: o.x, y: o.y }, [channel.port2]);
  const t = await result; // no timeout: a parked job may wait as long as the view is elsewhere
  return t instanceof Uint8Array ? t : null; // null: the page gave up on it
}

function tile(win, level, tx, ty) {
  const o = tileOrigin(win, level, tx, ty);
  const key = `${o.e}/${o.x}/${o.y}`;
  const t = tiles.get(key);
  if (t !== undefined) {
    tiles.delete(key);
    tiles.set(key, t);
    return Promise.resolve(t);
  }
  let p = pending.get(key);
  if (p === undefined) {
    p = {};
    p.promise = computeRemote(o, key).then((t) => {
      pending.delete(key);
      if (t === null) throw new Error(`tile ${key} dropped`);
      tiles.set(key, t);
      if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
      return t;
    });
    pending.set(key, p);
  }
  return p.promise;
}

async function readRange(win, level, start, end) {
  const g = geometry(level);
  const out = new Uint8Array(end - start);
  let pos = start;
  while (pos < end) {
    const shard = Math.floor(pos / g.shardBytes);
    const shardStart = shard * g.shardBytes;
    const i0 = Math.floor(shard / g.ns);
    const i1 = shard % g.ns;
    const local = pos - shardStart;
    let piece, pieceStart;
    if (local >= g.dataBytes) {
      piece = shardIndex(g);
      pieceStart = shardStart + g.dataBytes;
    } else {
      const k = Math.floor(local / TILE_BYTES);
      piece = await tile(win, level, i0 * g.per + Math.floor(k / g.per), i1 * g.per + (k % g.per));
      pieceStart = shardStart + k * TILE_BYTES;
    }
    const from = pos - pieceStart;
    const n = Math.min(piece.length - from, end - pos);
    out.set(piece.subarray(from, from + n), pos - start);
    pos += n;
  }
  return out;
}

const WINDOW = "/z/(\\d+)/(-?\\d+)/(-?\\d+)";
const TILE_PATH = new RegExp(`^(.*?)(?:${WINDOW})?/mandelbrot_pyramid/L(\\d+)\\.bin$`);
const ARCHIVE_PATH = new RegExp(`^(.*?)${WINDOW}/mandelbrot_pyramid\\.vzip$`);

function parseWindow(m, i) {
  if (m[i] === undefined) return DEFAULT_WINDOW;
  return { d: Number(m[i]), ix: BigInt(m[i + 1]), iy: BigInt(m[i + 2]) };
}

async function serveTiles(request, m) {
  const win = parseWindow(m, 2);
  const level = Number(m[5]);
  if (win === null || level >= LEVELS) return new Response("bad tile URL", { status: 404 });
  const g = geometry(level);
  const r = (request.headers.get("Range") ?? "").match(/^bytes=(\d+)-(\d+)$/);
  if (!r) return new Response("range requests only", { status: 416 });
  const start = Number(r[1]);
  const end = Math.min(Number(r[2]) + 1, g.total);
  if (start >= end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${g.total}` } });
  }
  let body;
  try {
    body = await readRange(win, level, start, end);
  } catch {
    return Response.error(); // the page dropped the tile: fail, never invent pixels
  }
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${start}-${end - 1}/${g.total}`,
      "Content-Length": String(end - start),
    },
  });
}

async function injectPanel(request) {
  const response = await fetch(request);
  const type = response.headers.get("Content-Type") ?? "";
  if (!response.ok || !type.includes("text/html")) return response;
  const html = await response.text();
  const tag = '<script src="/mandelbrot_infinite.js"></script>';
  return new Response(html.replace("</body>", `${tag}</body>`), {
    status: response.status,
    headers: { "Content-Type": type },
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  let m;
  if ((m = url.pathname.match(TILE_PATH))) {
    event.respondWith(serveTiles(event.request, m));
  } else if ((m = url.pathname.match(ARCHIVE_PATH))) {
    // Same archive for every window; keep the Range header.
    const target = `${m[1]}/mandelbrot_pyramid.vzip`;
    event.respondWith(fetch(target, { method: event.request.method, headers: event.request.headers }));
  } else if (event.request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    event.respondWith(injectPanel(event.request));
  }
});

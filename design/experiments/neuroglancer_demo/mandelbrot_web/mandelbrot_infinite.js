// Seamless deep zoom, injected into Neuroglancer's page by mandelbrot_sw.js.
//
// Windows (see mandelbrot_sw.js): window (d, ix, iy) is the square of side
// 4 * 2^-d centred on ROOT + (ix, iy) * 4 * 2^-(d + 4). Its pyramid has
// 15 levels with level-0 pixels of 4 * 2^-(d + 22) and coordinates centred on
// its centre, so a window seen near its own origin is precise in float32.
// Windows are aligned so that tiles coincide across windows: a window 8
// depths deeper shows exactly the same pixels as levels 0..6 of this one.
//
// The global coordinate frame is one window, the "frame". The state holds
// four layer slots. Besides the frame's layer, slots are prepared, hidden
// behind it (same pixels), for the windows we may move into: the child
// (d + 8) as you zoom in, the parent (d - 8) as you zoom out, a sibling
// (same d, new centre) as you pan away. When the view leaves the frame's
// precise range, the frame switches to a prepared window: in one tick every
// layer's transform, the position and the zoom are rewritten so the picture
// does not move, and the prepared layer already has its chunks.

(() => {
  // ---- tile pool ----------------------------------------------------------
  // The service worker sends tile jobs here; a pool of workers computes them.
  // Chrome does not tell the service worker when Neuroglancer abandons a
  // request, so this page sets priorities from the view instead: every tick,
  // jobs whose tiles are well outside the view (or much finer than the screen)
  // are parked. Parked jobs are low priority, not frozen: Neuroglancer may
  // still be waiting for them (it requests beyond the visible area), so they
  // run when no in-view work is waiting, on all but RESERVED workers. A
  // parked job is never answered with made-up pixels; only when too many pile
  // up are the oldest dropped, which fails their requests.
  const nWorkers = Math.max(2, (navigator.hardwareConcurrency || 4) - 1);
  const idle = [];
  let queue = []; // { id, key, e, x, y, port, t } — worth computing; newest last
  let parked = []; // the same, for tiles nobody is looking at
  const MAX_PARKED = 4000;
  const RESERVED = 2; // workers kept free of background work, for the view
  const running = new Map(); // id -> job
  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker("/mandelbrot_tile_worker.js");
    w.onmessage = ({ data: { id, t, stats } }) => {
      running.get(id)?.port.postMessage(t, [t.buffer]);
      tilesDone++;
      if (stats) lastStats = stats;
      running.delete(id);
      lastBusy = performance.now();
      idle.push(w);
      pump();
    };
    idle.push(w);
  }
  let lastBusy = 0;
  let tilesDone = 0;
  const counts = { jobs: 0, parkedTotal: 0, revived: 0, dropped: 0 };
  let lastStats = null; // what the most recent tile computation did
  // Running jobs for tiles that are in view now (a background job can come into view).
  const foreground = () => [...running.values()].filter((j) => relevant(j)).length;
  function pump() {
    if (queue.length || foreground()) lastBusy = performance.now();
    const start = (job) => {
      running.set(job.id, job);
      idle.pop().postMessage({ id: job.id, e: job.e, x: job.x, y: job.y });
    };
    // In-view work first, newest first: the view has moved on from old jobs.
    while (idle.length && queue.length) start(queue.pop());
    // Then off-screen work, on all but RESERVED workers.
    while (idle.length > RESERVED && parked.length) start(parked.pop());
  }
  // Is this tile worth computing for the current view? Tile (e, X, Y) covers
  // frame pixels [P, P + 256 * 2^k) with k = d + 22 - e and
  // P = X * 2^k - ix * 2^18 (exact in BigInt, then small enough for a Number).
  function relevant(job) {
    if (frame === undefined) return true;
    const k = frame.d + 22 - job.e;
    const toFrame = (X, i) => (k >= 0
      ? Number((X << BigInt(k)) - (i << 18n))
      : Number(X - (i << BigInt(18 - k))) * 2 ** k);
    const size = 256 * 2 ** k;
    const scale = viewer.crossSectionScale.value;
    if (2 ** k < scale / 4) return false; // more than two levels finer than the screen
    const [px, py] = viewer.navigationState.position.value;
    const panel = document.querySelector(".neuroglancer-rendered-data-panel");
    // A square on the panel's larger side, with a 2x margin: Neuroglancer
    // requests well beyond the visible area.
    const hw = (Math.max(panel?.clientWidth ?? 1000, panel?.clientHeight ?? 700) / 2) * scale * 2;
    const hh = hw;
    const x0 = toFrame(BigInt(job.x), frame.ix), y0 = toFrame(BigInt(job.y), frame.iy);
    return x0 < px + hw && x0 + size > px - hw && y0 < py + hh && y0 + size > py - hh;
  }
  function reschedule() {
    const all = queue.concat(parked).sort((a, b) => a.t - b.t);
    queue = [];
    const nowParked = [];
    for (const j of all) {
      if (relevant(j)) { if (j.parked) { counts.revived++; j.parked = false; } queue.push(j); }
      else { if (!j.parked) { counts.parkedTotal++; j.parked = true; } nowParked.push(j); }
    }
    while (nowParked.length > MAX_PARKED) { nowParked.shift().port.postMessage(null); counts.dropped++; }
    parked = nowParked;
    pump();
  }
  navigator.serviceWorker?.addEventListener("message", (m) => {
    const d = m.data;
    if (d?.type === "tile") {
      counts.jobs++;
      const job = { ...d, port: m.ports[0], t: performance.now(), parked: false };
      if (relevant(job)) queue.push(job);
      else { job.parked = true; counts.parkedTotal++; parked.push(job); }
      pump();
    }
  });
  navigator.serviceWorker?.startMessages?.();
  window.mandelbrotParked = () => parked.map((j) => ({ e: j.e, x: String(j.x), y: String(j.y) }));
  window.mandelbrotPool = () => ({ workers: nWorkers, queued: queue.length, parked: parked.length, running: running.size, foreground: foreground(), done: tilesDone, last: lastStats, ...counts });

  const STEP = 8; // depth between parent and child
  // Perturbation keeps tiles exact while float64 can hold the pixel size:
  // level-0 pixels of 4 * 2^-(d + 22) stay above ~1e-300 up to here.
  const MAX_D = 976;
  const HALF = 2 ** 21; // window half-span, in its level-0 pixels
  const ROOT = { d: 0, ix: 7n, iy: 8n };
  const ROOT_X = -2.5, ROOT_Y = -2;

  const key = (w) => `${w.d}/${w.ix}/${w.iy}`;
  const SRC = /\/z\/(\d+)\/(-?\d+)\/(-?\d+)\/mandelbrot_pyramid\.vzip/;

  // Exact transform of window `w` into the frame `f`: frame = s * model + t.
  // Model coordinates of w are its level-0 pixels from its centre.
  function relTransform(w, f) {
    const s = 2 ** (f.d - w.d);
    // t = centre offset in frame pixels = (w.i * 2^(f.d - w.d + 18) - f.i * 2^18)
    const a = f.d - w.d + 18;
    const lo = Math.min(a, 18);
    const t = (wi, fi) => Number((wi << BigInt(a - lo)) - (fi << BigInt(18 - lo))) * 2 ** lo;
    return { s, tx: t(w.ix, f.ix), ty: t(w.iy, f.iy) };
  }

  // The window at depth d whose centre is nearest to frame point (px, py).
  function nearest(d, f, px, py) {
    // Frame point in units of the frame's grid step g_f (= 2^18 frame pixels).
    const conv = (fi, p) => {
      const frac = p / 2 ** 18;
      if (d >= f.d) {
        const k = d - f.d;
        return (fi << BigInt(k)) + BigInt(Math.round(frac * 2 ** k));
      }
      const k = BigInt(f.d - d);
      const q = fi >> k; // floor
      const rem = Number(fi - (q << k));
      return q + BigInt(Math.round((rem + frac) / 2 ** Number(k)));
    };
    return { d, ix: conv(f.ix, px), iy: conv(f.iy, py) };
  }

  function contains(w, f, px, py, halfView, margin = 0.9) {
    const { s, tx, ty } = relTransform(w, f);
    const h = HALF * s * margin;
    return Math.abs(px - tx) + halfView <= h && Math.abs(py - ty) + halfView <= h;
  }

  // ---- layer slots -------------------------------------------------------
  let frame;
  const slots = []; // { ml, win, ready, since }

  function dataSource(ml) {
    return ml.layer?.dataSources?.[0];
  }

  function loaded(ml) {
    const ls = dataSource(ml)?.loadState;
    return ls !== undefined && ls.transform !== undefined ? ls : undefined;
  }

  function setTransform(slot) {
    const ls = loaded(slot.ml);
    if (!ls) return false;
    const { s, tx, ty } = relTransform(slot.win, frame);
    ls.transform.transform = Float64Array.of(s, 0, 0, 0, s, 0, tx, ty, 1);
    return true;
  }

  function assign(slot, win) {
    const ds = dataSource(slot.ml);
    const url = ds.spec.url.replace(/^(.*?)(\/z\/[^/]+\/[^/]+\/[^/]+)?\/mandelbrot_pyramid\.vzip/,
      `$1/z/${win.d}/${win.ix}/${win.iy}/mandelbrot_pyramid.vzip`);
    ds.spec = { ...ds.spec, url, transform: undefined };
    slot.win = win;
    slot.ready = false;
    slot.since = performance.now();
    slot.ml.setVisible(true);
  }

  function release(slot) {
    slot.win = undefined;
    slot.ready = false;
    slot.ml.setVisible(false);
  }

  function switchFrame(slot) {
    const old = frame;
    const pos = viewer.navigationState.position.value;
    const { s, tx, ty } = relTransform(slot.win, old);
    frame = slot.win;
    for (const sl of slots) if (sl.win) setTransform(sl);
    viewer.navigationState.position.value = Float32Array.of((pos[0] - tx) / s, (pos[1] - ty) / s);
    viewer.crossSectionScale.value = viewer.crossSectionScale.value / s;
    switches.push(`${key(old)} -> ${key(frame)}`);
  }

  // ---- policy -------------------------------------------------------------
  const switches = [];
  window.mandelbrotSwitches = switches;

  function viewHalf(scale) {
    const p = document.querySelector(".neuroglancer-rendered-data-panel");
    const w = p ? Math.max(p.clientWidth, p.clientHeight) : 900;
    return (scale * w) / 2;
  }

  function want(scale, px, py, half) {
    const wants = [];
    // child: when within 2 levels of the frame's level 0
    if (scale < 4 && frame.d + STEP <= MAX_D) wants.push({ role: "child", d: frame.d + STEP });
    // parent: 2 levels before switching to it
    if (scale > 2 ** 10 && frame.d >= STEP) wants.push({ role: "parent", d: frame.d - STEP });
    // sibling: when the view nears the frame's edge or float32 coordinates grow
    if (Math.max(Math.abs(px), Math.abs(py)) + half > HALF * 0.25) wants.push({ role: "sibling", d: frame.d });
    return wants;
  }

  function tick() {
    reschedule();
    const scale = viewer.crossSectionScale.value;
    const [px, py] = viewer.navigationState.position.value;
    const half = viewHalf(scale);
    const frameSlot = slots.find((s) => s.win && key(s.win) === key(frame));

    // Apply transforms to slots whose sources finished loading.
    for (const sl of slots) {
      if (sl.win && !sl.ready && setTransform(sl)) sl.ready = true;
    }

    // Keep or prepare the windows we may move into.
    const keep = new Set([frameSlot]);
    for (const w of want(scale, px, py, half)) {
      let sl = slots.find((s) => s.win && s.win.d === w.d && !keep.has(s) &&
        (w.role !== "sibling" || key(s.win) !== key(frame)) && contains(s.win, frame, px, py, half));
      if (!sl) {
        const target = nearest(w.d, frame, px, py);
        if (w.role === "sibling" && key(target) === key(frame)) continue;
        sl = slots.find((s) => s.win && key(s.win) === key(target) && !keep.has(s));
        if (!sl) {
          sl = slots.find((s) => !keep.has(s) && !s.win) ?? slots.find((s) => !keep.has(s) && s !== frameSlot);
          if (!sl) continue;
          assign(sl, target);
        }
      }
      keep.add(sl);
      sl.role = w.role;
    }
    // Slots not wanted are kept loaded (cheap, may be wanted again) unless needed.

    // Switch frames once the target's tiles are in: its source is loaded and
    // the tile pool has been idle for a moment. Past 8x beyond the threshold,
    // switch anyway, before float32 starts to show.
    const idleFor = queue.length || running.size ? 0 : performance.now() - lastBusy;
    const overdue = scale < 1 / 8 || scale > 2 ** 15 || Math.max(Math.abs(px), Math.abs(py)) > HALF * 0.8;
    const ready = (sl) => sl && sl.ready && performance.now() - sl.since > 400 && (idleFor > 250 || overdue);
    const pick = (role) => [...keep].find((s) => s !== frameSlot && s.role === role);
    let target;
    if (scale < 1) target = pick("child");
    else if (scale > 2 ** 12) target = pick("parent");
    else if (Math.max(Math.abs(px), Math.abs(py)) + half > HALF * 0.5) target = pick("sibling");
    if (ready(target)) switchFrame(target);
    // Anything not kept and not the frame goes hidden.
    for (const sl of slots) if (sl.win && !keep.has(sl) && sl !== frameSlot && performance.now() - sl.since > 3000) release(sl);
    nameSlots();
    updatePanel(scale, px, py);
  }

  // Name the slots after what they are doing, so Neuroglancer's layer bar
  // shows the machinery: the frame, windows being prepared, spares.
  function nameSlots() {
    const names = slots.map((sl, i) => {
      if (!sl.win) return `spare ${i + 1}`;
      const role = key(sl.win) === key(frame) ? "frame"
        : sl.win.d > frame.d ? "zoom-in" : sl.win.d < frame.d ? "zoom-out" : "pan";
      return `${role} · depth ${sl.win.d}${sl.ready ? "" : " · loading"}`;
    });
    // Neuroglancer wants unique names; number any repeats.
    const seen = new Map();
    names.forEach((n, i) => { const c = (seen.get(n) ?? 0) + 1; seen.set(n, c); if (c > 1) names[i] = `${n} (${c})`; });
    slots.forEach((sl, i) => { if (sl.ml.name !== names[i]) sl.ml.name = names[i]; });
  }

  // ---- panel --------------------------------------------------------------
  // A compact readout: zoom, view and pixel size, exact centre, which maths
  // is running, and the worker pool. The machinery (frame, slots) is under "details".
  const css = document.createElement("style");
  css.textContent = `
    #mb-panel { position: fixed; right: 14px; bottom: 14px; z-index: 1000; width: 330px; max-width: calc(100vw - 28px);
      background: rgba(12, 11, 18, .82); color: #e7e5ef; border: 1px solid #34313f; border-radius: 4px;
      font: 11.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 8px 10px; }
    #mb-panel .grid { display: grid; grid-template-columns: 44px minmax(0, 1fr); column-gap: 8px; row-gap: 2px; }
    #mb-panel .k { color: #8f8ca0; }
    #mb-panel .v { white-space: pre-wrap; }
    #mb-panel #mb-centre { word-break: break-all; }
    #mb-panel .big { font-size: 15px; font-weight: 600; }
    #mb-panel .deep { color: #a68ef0; }
    #mb-panel .flt { color: #4fc2b2; }
    #mb-panel .bar { letter-spacing: 1px; }
    #mb-panel .dim { color: #8f8ca0; }
    #mb-panel button { all: unset; cursor: pointer; color: #8f8ca0; margin-top: 4px; }
    #mb-panel button:hover { color: #e7e5ef; }
    #mb-panel button:focus-visible { outline: 1px solid #a68ef0; }`;
  const box = document.createElement("div");
  box.id = "mb-panel";
  box.innerHTML = `
    <div class="grid">
      <span class="k">zoom</span><span class="v big" id="mb-zoom"></span>
      <span class="k">view</span><span class="v" id="mb-size"></span>
      <span class="k">c</span><span class="v" id="mb-centre"></span>
      <span class="k">maths</span><span class="v" id="mb-math">–</span>
      <span class="k">tiles</span><span class="v" id="mb-work"></span>
      <span class="k" id="mb-dk" hidden>frame</span><span class="v dim" id="mb-details" hidden></span>
    </div>
    <button id="mb-toggle" aria-expanded="false">details</button>`;
  const $ = (id) => box.querySelector(id);

  const SUP = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
  function sci(v, digits = 2) {
    if (v >= 0.01 && v < 1e4) return v < 10 ? v.toPrecision(3) : Math.round(v).toLocaleString("en");
    const ex = Math.floor(Math.log10(v));
    return `${(v / 10 ** ex).toFixed(digits - 1)}×10${String(ex).replace(/./g, (ch) => SUP[ch])}`;
  }
  const kilo = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  // Exact decimal of a frame point: c = root + i * 2^-(d+2) + p * 2^-(d+20) (BigInt, exact at any depth).
  const FRAC = 16;
  function exactCoord(root2, i, p, digits) {
    const sh = BigInt(frame.d + 20 + FRAC);
    const n = (BigInt(root2) << (sh - 1n)) + (i << BigInt(18 + FRAC)) + BigInt(Math.round(p * 2 ** FRAC));
    const neg = n < 0n, a = neg ? -n : n;
    const scaled = (a * 10n ** BigInt(digits)) >> sh;
    const str = scaled.toString().padStart(digits + 1, "0");
    return `${neg ? "−" : "+"}${str.slice(0, -digits)}.${str.slice(-digits)}`;
  }
  function updatePanel(scale, px, py) {
    const p = 4 * 2 ** -(frame.d + 22);
    const width = 2 * viewHalf(scale) * p;
    $("#mb-zoom").textContent = `${sci(3 / width)}×`;
    $("#mb-size").textContent = `${sci(width)} wide · pixel ${sci(width / (2 * viewHalf(1)))}`;
    const digits = Math.max(4, Math.ceil(-Math.log10(width)) + 3);
    $("#mb-centre").textContent = `${exactCoord(-5, frame.ix, px, digits)}\n${exactCoord(-4, frame.iy, py, digits)} i`;
    const st = lastStats;
    if (st) {
      $("#mb-math").innerHTML = st.method === "float64"
        ? `<span class="flt">float64</span> <span class="dim">· ≤${kilo(st.iters)} iter</span>`
        : `<span class="deep">perturbation</span> <span class="dim">· ${st.bits}-bit ref · ≤${kilo(st.iters)} iter</span>`;
    }
    const fg = foreground(), bg = running.size - fg;
    const bar = "▮".repeat(fg) + `<span class="dim">${"▮".repeat(bg)}</span>` + "▯".repeat(nWorkers - fg - bg);
    $("#mb-work").innerHTML = `<span class="bar">${bar}</span> <span class="dim">${queue.length} in view · ${parked.length} off-screen · ${tilesDone.toLocaleString("en")} done</span>`;
    if (!$("#mb-details").hidden) {
      const roles = slots.filter((s) => s.win).map((s) => `${key(s.win) === key(frame) ? "*" : ""}${s.win.d}${s.ready ? "" : "…"}`).join(" ");
      $("#mb-details").textContent = `${key(frame)}\nslots [${roles}] · ${switches.length} switches`;
    }
  }

  function start() {
    if (typeof viewer === "undefined" || !document.body) return setTimeout(start, 200);
    const layers = viewer.layerManager.managedLayers;
    if (layers.length < 4 || !layers.every((ml) => dataSource(ml))) return setTimeout(start, 200);
    const m = dataSource(layers[0]).spec.url.match(SRC);
    frame = m ? { d: Number(m[1]), ix: BigInt(m[2]), iy: BigInt(m[3]) } : ROOT;
    for (const [i, ml] of layers.slice(0, 4).entries()) {
      const slot = { ml, win: undefined, ready: false, since: 0 };
      slots.push(slot);
      if (i === 0) { slot.win = frame; slot.since = -1e9; } else release(slot);
    }
    // Each window has its own data bounds, so the default bounding-box
    // annotations would come and go with every switch.
    viewer.showDefaultAnnotations.value = false;
    document.head.appendChild(css);
    document.body.appendChild(box);
    $("#mb-toggle").onclick = () => {
      const d = $("#mb-details");
      d.hidden = !d.hidden;
      $("#mb-dk").hidden = d.hidden;
      $("#mb-toggle").textContent = d.hidden ? "details" : "hide details";
      $("#mb-toggle").setAttribute("aria-expanded", String(!d.hidden));
    };
    setInterval(tick, 100);
  }
  // Centre the view on c = cx + i cy, given as numbers or exact decimal strings.
  window.mandelbrotGoto = (cx, cy) => {
    const sh = BigInt(frame.d + 20 + FRAC);
    const toFrame = (dec, root2, i) => {
      const str = String(dec).trim().replace("−", "-");
      const neg = str.startsWith("-");
      const [ip, fp = ""] = str.replace(/^[-+]/, "").split(".");
      const num = BigInt(ip + fp) * (neg ? -1n : 1n), den = 10n ** BigInt(fp.length);
      const base = (BigInt(root2) << (sh - 1n)) + (i << BigInt(18 + FRAC));
      return Number((num << sh) / den - base) / 2 ** FRAC;
    };
    viewer.navigationState.position.value = Float32Array.of(toFrame(cx, -5, frame.ix), toFrame(cy, -4, frame.iy));
  };
  window.mandelbrotDebug = () => ({ frame: key(frame), slots: slots.map((s) => s.win && key(s.win)), detail: slots.map((s) => s.win && `${s.role}:${s.ready}:${Math.round(performance.now() - s.since)}`) });
  start();
})();

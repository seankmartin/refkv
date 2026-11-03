// Mandelbrot tile computation, shared by the service worker
// (mandelbrot_sw.js) and the page's worker pool (mandelbrot_tile_worker.js).
//
// A tile is 256 x 256 pixels of size 4 * 2^-e whose corner is the absolute
// pixel (X, Y) (BigInts): pixel (X + a, Y + b) has its centre at
// ROOT + (X + a + 0.5, Y + b + 0.5) * 4 * 2^-e.
//
// Shallow tiles (e <= DIRECT_MAX_E) iterate z <- z^2 + c in float64.
// Deeper tiles use perturbation theory: one reference orbit Z_n, computed in
// BigInt fixed point at e + 64 bits, and per pixel only the offset
// dz_n = z_n - Z_n in float64:
//
//     dz <- (2 Z_m + dz) dz + dc,       dc = c - c_ref (small, exact)
//
// with rebasing (Zhuoran, 2021): when |Z_m + dz| < |dz|, or the reference
// orbit runs out, continue from the start of the orbit with dz = Z_m + dz
// and m = 0. That keeps dz small relative to z, so no glitch detection is
// needed. float64 still has to hold dc (pixel size 2^-e), so this works down
// to e ~ 1000 (pixels of ~1e-300); beyond that dc needs an extended exponent.

const TILE = 256;
const TILE_BYTES = TILE * TILE;
const ROOT_X = -2.5;
const ROOT_Y = -2;
const DIRECT_MAX_E = 48; // float64 resolves pixels of 4 * 2^-48 near |c| ~ 2
const REF_BLOCK = 22n; // reference point: centre of the aligned 2^22-pixel block
const ITER_CAP = 200000; // reference orbits run this far; deep pixels may too
const LOG2 = Math.log(2);
// What the last computeTile call did, for the page's info panel.
let lastTileStats = null;

function iterationBudget(e) {
  // log2(3 / pixel size): deeper pixels need more iterations.
  const depth = Math.max(0, Math.log2(3) + e - 2);
  return Math.min(100000, Math.round(150 + 110 * depth));
}

// Smooth escape count mapped to 1..255 with a periodic ramp, so colours look
// alike at every depth. 0 is reserved for the interior.
function shade(n, r2) {
  const nu = n + 1 - Math.log(Math.log(r2) / 2 / LOG2) / LOG2;
  const t = Math.sqrt(Math.max(nu, 0)) * 0.45;
  return 1 + Math.floor(254 * (0.5 - 0.5 * Math.cos(t)));
}

function computeTile({ e, x, y }) {
  return e <= DIRECT_MAX_E
    ? computeDirect(e, Number(x), Number(y))
    : computePerturbed(e, BigInt(x), BigInt(y));
}

function computeDirect(e, x0, y0) {
  const out = new Uint8Array(TILE_BYTES);
  const step = 4 * 2 ** -e;
  const maxIter = iterationBudget(e);
  const eps = Math.min(1e-14, step * 1e-3);
  lastTileStats = { e, method: "float64", bits: 53, iters: maxIter };
  for (let a = 0; a < TILE; a++) {
    const cr = ROOT_X + (x0 + a + 0.5) * step;
    for (let b = 0; b < TILE; b++) {
      const ci = ROOT_Y + (y0 + b + 0.5) * step;
      const o = a * TILE + b; // C order over [x, y]
      // Main cardioid and period-2 bulb are interior.
      const q = (cr - 0.25) * (cr - 0.25) + ci * ci;
      if (q * (q + (cr - 0.25)) <= 0.25 * ci * ci || (cr + 1) * (cr + 1) + ci * ci <= 0.0625) {
        out[o] = 0;
        continue;
      }
      let zr = 0, zi = 0, zr2 = 0, zi2 = 0, n = 0;
      let sr = 0, si = 0, period = 8, inside = false;
      while (n < maxIter && zr2 + zi2 <= 65536) {
        zi = 2 * zr * zi + ci;
        zr = zr2 - zi2 + cr;
        zr2 = zr * zr;
        zi2 = zi * zi;
        n++;
        // Periodicity check: a cycle means the point is interior.
        if (Math.abs(zr - sr) < eps && Math.abs(zi - si) < eps) { inside = true; break; }
        if (n === period) { sr = zr; si = zi; period *= 2; }
      }
      out[o] = inside || n >= maxIter ? 0 : shade(n, zr2 + zi2);
    }
  }
  return out;
}

// ---- perturbation ----------------------------------------------------------

const refCache = new Map(); // `${e}/${rx}/${ry}` -> Float64Array [Zr0, Zi0, Zr1, Zi1, ...]
const REF_CACHE_SIZE = 12;

// Reference orbit of c_ref = ROOT + (rx, ry) * 4 * 2^-e, in fixed point with
// P = e + 64 fraction bits, until it escapes or reaches maxIter.
function referenceOrbit(e, rx, ry, maxIter) {
  const key = `${e}/${rx}/${ry}`;
  let ref = refCache.get(key);
  if (ref !== undefined) return ref;
  const P = BigInt(e + 64);
  const shiftC = P - BigInt(e) + 2n; // 4 * 2^-e = 2^(2 - e)
  const cr = (-5n << (P - 1n)) + (rx << shiftC); // -2.5 = -5/2
  const ci = (-2n << P) + (ry << shiftC);
  const down = P - 60n;
  const toD = (v) => Number(v >> down) / 2 ** 60;
  const buf = new Float64Array(2 * (maxIter + 1));
  let zr = 0n, zi = 0n, n = 0;
  for (; n <= maxIter; n++) {
    const dr = toD(zr), di = toD(zi);
    buf[2 * n] = dr;
    buf[2 * n + 1] = di;
    if (dr * dr + di * di > 65536) { n++; break; }
    const zr2 = (zr * zr) >> P;
    const zi2 = (zi * zi) >> P;
    zi = ((zr * zi) >> (P - 1n)) + ci;
    zr = zr2 - zi2 + cr;
  }
  ref = buf.slice(0, 2 * Math.min(n, maxIter + 1));
  refCache.set(key, ref);
  if (refCache.size > REF_CACHE_SIZE) refCache.delete(refCache.keys().next().value);
  return ref;
}

function computePerturbed(e, X, Y) {
  const out = new Uint8Array(TILE_BYTES);
  const maxIter = iterationBudget(e);
  const step = 4 * 2 ** -e;
  const half = 1n << (REF_BLOCK - 1n);
  const rx = ((X >> REF_BLOCK) << REF_BLOCK) + half;
  const ry = ((Y >> REF_BLOCK) << REF_BLOCK) + half;
  const ref = referenceOrbit(e, rx, ry, ITER_CAP);
  const refLen = ref.length / 2;
  // Escape counts near deep structure grow much faster than any fixed rule of
  // depth, so the budget follows the reference: three times its escape count,
  // or the cap if it never escapes (interior pixels then stop on the
  // derivative test).
  const refEscaped = refLen <= ITER_CAP;
  const pixelIter = refEscaped ? Math.min(ITER_CAP, Math.max(maxIter, 3 * refLen)) : ITER_CAP;
  lastTileStats = { e, method: "perturbation", bits: e + 64, iters: pixelIter, refIters: refLen - 1 };
  // dc of the tile's pixel (0, 0) centre; pixel offsets are exact small multiples of step.
  const dcx0 = (Number(X - rx) + 0.5) * step;
  const dcy0 = (Number(Y - ry) + 0.5) * step;
  for (let a = 0; a < TILE; a++) {
    const dcr = dcx0 + a * step;
    for (let b = 0; b < TILE; b++) {
      const dci = dcy0 + b * step;
      let dzr = 0, dzi = 0, m = 0, n = 0;
      let zr = 0, zi = 0, r2 = 0;
      // Derivative d z_n / d z_1 for interior detection: it decays
      // geometrically only on an attracting cycle.
      let der = 1, dei = 0, track = false, useDer = true, inside = false;
      while (n < pixelIter) {
        if (track && useDer) {
          const t = 2 * (zr * der - zi * dei);
          dei = 2 * (zr * dei + zi * der);
          der = t;
        }
        const Zr = ref[2 * m], Zi = ref[2 * m + 1];
        const tr = 2 * Zr + dzr, ti = 2 * Zi + dzi;
        const nr = tr * dzr - ti * dzi + dcr;
        dzi = tr * dzi + ti * dzr + dci;
        dzr = nr;
        m++;
        n++;
        zr = ref[2 * m] + dzr;
        zi = ref[2 * m + 1] + dzi;
        r2 = zr * zr + zi * zi;
        if (r2 > 65536) break;
        track = true;
        if (useDer && (n & 63) === 0 && n >= 512) {
          const d2 = der * der + dei * dei;
          if (d2 < 1e-40) { inside = true; break; }
          if (!(d2 < 1e200)) useDer = false; // diverging: stop tracking
        }
        if (r2 < dzr * dzr + dzi * dzi || m >= refLen - 1) {
          dzr = zr;
          dzi = zi;
          m = 0;
        }
      }
      out[a * TILE + b] = inside || n >= pixelIter ? 0 : shade(n, r2);
    }
  }
  return out;
}

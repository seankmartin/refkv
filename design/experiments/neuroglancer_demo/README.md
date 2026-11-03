# Neuroglancer demos

Both demos use the vzip-enabled Neuroglancer fork,
https://github.com/d-v-b/neuroglancer (branch `vzip`). The scripts look for
it in `$NEUROGLANCER`, by default a clone next to this repository. Build it
first:

```bash
git clone --branch vzip https://github.com/d-v-b/neuroglancer.git ../neuroglancer
(cd ../neuroglancer && npm install && npm run build)
```

`screenshot.mjs` serves the built viewer together with a data directory, opens
a state from `states/` in headless Chromium, and saves a screenshot. It also
logs every data request the viewer makes.

## HDF5 image (local)

`make_hdf5_vzip.py` writes a zlib-chunked netCDF4/HDF5 image and a vzip that
exposes it as a Zarr v3 array. The vzip holds only metadata and 16 references
into `mandelbrot.nc`.

```bash
uv run python design/experiments/neuroglancer_demo/make_hdf5_vzip.py design/experiments/out/ng_demo
node design/experiments/neuroglancer_demo/screenshot.mjs design/experiments/out/ng_demo design/experiments/neuroglancer_demo/states/mandelbrot.json design/experiments/out/ng_demo/neuroglancer_vzip.png
```

`states/mandelbrot_scheme.json` opens the same data with the bare
`vzip://<archive-url>` source.

## Mandelbrot deep zoom computed on demand (local, service worker)

`make_mandelbrot_pyramid.py` writes an 11 MB vzip that holds only metadata: an
OME-NGFF 0.5 multiscales group of 15 levels (4194304² down to 256² uint8
pixels, axes `[x, y]`, centred on 0). Each level is a Zarr v3 array of
`sharding_indexed` 16384² shards with uncompressed 256² chunks. Each of the
87,387 shards is a reference into a virtual file `mandelbrot_pyramid/L{level}.bin`
that does not exist on disk. Nothing is precomputed.

The web side lives in `mandelbrot_web/`:

- `mandelbrot.html` installs the service worker, then opens Neuroglancer.
- `mandelbrot_sw.js`, the service worker, answers range requests for the
  virtual files with computed chunks and shard indexes. It also serves the one
  archive at any window path (below) and injects `mandelbrot_infinite.js` into
  Neuroglancer's page.
- `mandelbrot_infinite.js` runs a pool of tile workers
  (`mandelbrot_tile_worker.js`, with the maths in `mandelbrot_tile.js`). A
  service worker cannot start workers itself, so it sends tile jobs to the page.
  The pool runs jobs newest first and drops jobs whose requests were cancelled.
  The script also moves the view between windows, as described below.

**Windows.** The archive is opened at `data/z/<d>/<ix>/<iy>/mandelbrot_pyramid.vzip`.
Its relative tile URLs inherit that path, so each tile request names its
window: the square of side 4·2⁻ᵈ centred on (−2.5, −2) + (ix, iy)·4·2⁻⁽ᵈ⁺⁴⁾.
`ix` and `iy` are integers of any size. Windows are aligned so that tiles
coincide across them: a window 8 levels deeper shows exactly the same pixels
as levels 0–6 of its parent. The tile cache is keyed by absolute position, so
those tiles are computed once.

**Seamless zoom.** Neuroglancer's positions are float32, so the global
coordinate frame is always one window, centred near the view. The state holds
four layer slots. Besides the frame's window, a slot is prepared for the child
window (d + 8) as you zoom in, the parent (d − 8) as you zoom out, or a
sibling (same d, new centre) as you pan away. Each prepared slot is aligned
with the frame and has the same pixels. When the view leaves the frame's
precise range and the prepared slot's tiles are in, one tick rewrites every
layer's transform, the position and the zoom. The picture does not move, and
no layer reloads. In headless tests, the frames just before and after a switch
were pixel-identical.

**Deep tiles: perturbation theory.** Tiles with pixels down to 4·2⁻⁴⁸ iterate
in plain float64. Deeper tiles (`mandelbrot_tile.js`) compute one reference
orbit per aligned 2²²-pixel block, in BigInt fixed point at the tile's
precision plus 64 bits. Each pixel then iterates only its float64 offset
from that orbit, `δz ← (2Z + δz)·δz + δc`. Rebasing (Zhuoran, 2021) restarts
a pixel from the start of the orbit when `|Z + δz| < |δz|` or the orbit runs
out, so no glitch detection is needed. Iteration budgets follow the reference
(three times its escape count, capped at 200,000), and a derivative test ends
interior pixels early. Window coordinates are BigInts and the panel prints
exact decimals, so the only remaining depth limit is float64 holding the
pixel size: windows go down to d = 976 (pixels of about 10⁻³⁰⁰). In practice
the limit is compute time, because deep tiles take seconds each.

**Info panel.** The bottom-right panel shows:
- the zoom;
- the view's size if the whole set were as wide as the Earth (or the
  observable universe);
- the exact centre coordinate;
- which maths is running, with its precision and iteration budget;
- how busy the workers are.

"Show details" adds the frame window, the layer slots and the switch count.
`mandelbrotGoto(cx, cy)` takes exact decimal strings. Neuroglancer's layer bar names the slots
after what they are doing (`frame · depth 16`, `zoom-in · depth 24 · loading`,
`spare 3`). Default bounding boxes are off, because each window has its own
bounds and they would flicker with every switch.

```bash
uv run python design/experiments/neuroglancer_demo/make_mandelbrot_pyramid.py design/experiments/out/ng_pyramid
node design/experiments/neuroglancer_demo/serve.mjs design/experiments/out/ng_pyramid \
  design/experiments/neuroglancer_demo/states/mandelbrot_pyramid.json 8768 \
  --web design/experiments/neuroglancer_demo/mandelbrot_web --page mandelbrot.html
```

The level layout in the generator and `geometry()` in the worker must match.
`serve.mjs` copies the web files when it starts, so restart it after editing
them. `screenshot.mjs` does not install the worker, so it cannot show this demo.

## OME-Zarr view of an IDR OME-TIFF (remote)

`design/experiments/tiff_to_vzip.py` reads the IFDs of a 487 MB pyramidal OME-TIFF
from IDR over HTTP: study idr0096 (Tratwal et al.,
[doi:10.17867/10000170](https://doi.org/10.17867/10000170), CC BY 4.0). It writes a 622 KB vzip holding an
OME-NGFF 0.5 multiscales group: 9 levels, 5,037 references to JPEG 2000 tiles.
Neuroglancer then reads the tiles straight from `ftp.ebi.ac.uk` and decodes
them with the `imagecodecs_jpeg2k` codec.

```bash
uv run python design/experiments/tiff_to_vzip.py --no-pins \
  'https://ftp.ebi.ac.uk/pub/databases/IDR/idr0096-tratwal-marrowquant/20210609-ftp-ome-tiffs/4000_d11_m5_LT_2%20(20x_01).ome.tiff' \
  design/experiments/out/ng_idr/idr0096_4000_d11_m5_LT_2_unpinned.vzip
node design/experiments/neuroglancer_demo/screenshot.mjs design/experiments/out/ng_idr design/experiments/neuroglancer_demo/states/idr_ome_zarr.json design/experiments/out/ng_idr/neuroglancer_idr_overview.png 25000
node design/experiments/neuroglancer_demo/screenshot.mjs design/experiments/out/ng_idr design/experiments/neuroglancer_demo/states/idr_ome_zarr_detail.json design/experiments/out/ng_idr/neuroglancer_idr_detail.png 25000
```

Notes:

- **Unpinned archive.** The archive is written without pins (`--no-pins`). EBI
  allows cross-origin range requests, but its CORS preflight rejects `If-Match`
  and `If-Unmodified-Since`. It also does not expose `ETag`, `Last-Modified` or
  `Content-Range`. A browser therefore cannot check pins, and pinned reads fail
  closed. The pinned archive (`design/experiments/out/idr0096_4000_d11_m5_LT_2.vzip`,
  from `just archives-idr`) still works outside the browser.
- **Hidden `Content-Range`.** For the same reason, the driver accepts a
  cross-origin `206` whose `Content-Range` is hidden, as long as the body has
  exactly the requested length. This deviates from [spec §5.2](../../../spec/refkv.md#52-reading-over-http).
- **One layer per channel.** Each chunk holds one channel (`[1, 1024, 1024]`).
  Neuroglancer needs a channel dimension to sit within a single chunk, so the
  state shows the three channels as red, green and blue layers with additive
  blending.

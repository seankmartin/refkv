"""Write a vzip holding a re-rootable Mandelbrot pyramid whose pixels are computed on demand.

The archive holds only metadata: an OME-NGFF 0.5 multiscales group of 15
Zarr v3 arrays (4194304^2 down to 256^2 uint8 pixels, axes [x, y]). Each array
is sharded (`sharding_indexed`, 16384^2 shards of 256^2 uncompressed chunks),
and each shard is a vzip reference into a virtual file
`mandelbrot_pyramid/L{level}.bin`, relative to the archive, that does not
exist on disk.

In the browser a service worker (`mandelbrot_web/mandelbrot_sw.js`) answers
the range requests for those files by computing the requested chunks and
shard indexes. Nothing is precomputed.

Windows: the archive does not fix which part of the complex plane it shows.
The service worker serves the same archive at
`.../z/<d>/<ix>/<iy>/mandelbrot_pyramid.vzip`, and the archive's relative tile
URLs then carry the window: the square of side 4 * 2^-d centred on
(-2.5, -2) + (ix, iy) * 4 * 2^-(d + 4). Coordinates are centred on 0
(translation -N0/2) so Neuroglancer's float32 positions stay precise within
a window. `mandelbrot_web/mandelbrot_infinite.js` moves the view between
windows as you zoom and pan, without a visible jump.

The layout below must match `geometry()` in the service worker.

Usage: uv run python design/experiments/neuroglancer_demo/make_mandelbrot_pyramid.py OUT_DIR
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from refkv.vzip.archive import VZipWriter

N0 = 1 << 22  # level-0 width and height of one window, in pixels
LEVELS = 15  # 2^22 ... 2^8
TILE = 256  # inner chunk
SHARD = 16384  # shard (capped at the level size)


def geometry(level: int) -> dict[str, int]:
    n = N0 >> level
    s = min(SHARD, n)
    per = s // TILE  # inner chunks per shard side
    data = per * per * TILE * TILE
    return {"n": n, "s": s, "per": per, "ns": n // s, "shard_bytes": data + per * per * 16}


def array_meta(level: int) -> dict:
    g = geometry(level)
    return {
        "zarr_format": 3,
        "node_type": "array",
        "shape": [g["n"], g["n"]],
        "data_type": "uint8",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [g["s"], g["s"]]}},
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "codecs": [{
            "name": "sharding_indexed",
            "configuration": {
                "chunk_shape": [TILE, TILE],
                "codecs": [{"name": "bytes"}],
                "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
                "index_location": "end",
            },
        }],
        "fill_value": 0,
        "dimension_names": ["x", "y"],
    }


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    group = {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {"ome": {
            "version": "0.5",
            "multiscales": [{
                "name": "mandelbrot (computed on demand by a service worker)",
                "axes": [{"name": "x", "type": "space"}, {"name": "y", "type": "space"}],
                "datasets": [
                    {"path": str(lv), "coordinateTransformations": [
                        {"type": "scale", "scale": [float(1 << lv)] * 2},
                        {"type": "translation", "translation": [-N0 / 2] * 2},
                    ]}
                    for lv in range(LEVELS)
                ],
            }],
        }},
    }
    path = out / "mandelbrot_pyramid.vzip"
    refs = 0
    with open(path, "wb") as fh:
        w = VZipWriter(fh, page_size=1 << 16)
        for lv in range(LEVELS):
            g = geometry(lv)
            url = f"mandelbrot_pyramid/L{lv}.bin"
            for i0 in range(g["ns"]):
                for i1 in range(g["ns"]):
                    off = (i0 * g["ns"] + i1) * g["shard_bytes"]
                    w.add_ref(f"{lv}/c/{i0}/{i1}", url, off, g["shard_bytes"])
                    refs += 1
            w.add_bytes(f"{lv}/zarr.json", json.dumps(array_meta(lv)).encode(), late=True)
        w.add_bytes("zarr.json", json.dumps(group, indent=1).encode(), late=True)
        w.close()
    print(f"wrote {path} ({path.stat().st_size} bytes, {LEVELS} levels, {refs} shard references)")


if __name__ == "__main__":
    main(Path(sys.argv[1]))

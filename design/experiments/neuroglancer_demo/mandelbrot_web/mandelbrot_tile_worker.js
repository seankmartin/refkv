// One worker of the page's tile pool (see mandelbrot_infinite.js).
importScripts("/mandelbrot_tile.js");
onmessage = ({ data: { id, e, x, y } }) => {
  const t0 = performance.now();
  const t = computeTile({ e, x, y });
  postMessage({ id, t, stats: { ...lastTileStats, ms: performance.now() - t0 } }, [t.buffer]);
};

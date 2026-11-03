// Record a smooth zoom through the Mandelbrot deep-zoom demo, frame by frame.
//
// Each frame sets the zoom, then waits until every tile of that view has been
// computed and delivered before taking a screenshot, so the video is seamless
// however long the deep tiles take to compute. Frames go to <out>/frames/,
// and the video is encoded with `ffmpeg` if it is installed (H.264 MP4, plays
// everywhere), otherwise with the ffmpeg that ships with Playwright (VP8 WebM,
// plays in browsers and VLC).
//
// Usage, with serve.mjs running (see README.md):
//   node design/experiments/neuroglancer_demo/record_zoom.mjs <url printed by serve.mjs> <out dir> [plan…] [options]
//
// The plan is a list of steps, run in order from the whole set (zoom ≈ 1×):
//   to:<exp>:<seconds>   zoom smoothly (constant speed) to 10^exp× over that time, in or out
//   hold:<seconds>       keep the picture still
// Default plan: hold:1 to:15:30 hold:1  (a 30-second dive to 10^15×).
//
// Options, to extend an earlier recording without redoing its frames:
//   --from <exp>          first move (without recording) to 10^exp×
//   --start-frame <n>     number new frames from n (frames from n on are replaced; earlier ones kept)
// Example: dive further from the end of a 10^15× dive whose last hold started at frame 930:
//   … --from 15 --start-frame 930 to:20:20 hold:1 to:0:5 hold:1

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const neuroglancer = process.env.NEUROGLANCER ?? path.join(here, "../../../../neuroglancer");
const require = createRequire(path.join(neuroglancer, "package.json"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const fromExp = opt("--from");
const startFrame = Number(opt("--start-frame") ?? 0);
const [url, outDir, ...planArgs] = args;
if (!url || !outDir) {
  console.error("usage: record_zoom.mjs <url> <out dir> [to:<exp>:<s> | hold:<s>]… [--from <exp>] [--start-frame <n>]");
  process.exit(1);
}
const plan = (planArgs.length ? planArgs : ["hold:1", "to:15:30", "hold:1"]).map((step) => {
  const [kind, a, b] = step.split(":");
  if (kind === "to") return { kind, exp: Number(a), seconds: Number(b) };
  if (kind === "hold") return { kind, seconds: Number(a) };
  throw new Error(`unknown plan step ${step}`);
});

const FPS = 30;
const W = 1280, H = 720;
// Seahorse Valley, known to 33 digits.
const TARGET = ["-0.743643887037158704752191506114774", "0.131825904205311970493132056385139"];
const frames = path.join(outDir, "frames");
fs.mkdirSync(frames, { recursive: true });
for (const f of fs.readdirSync(frames)) if (f.endsWith(".jpg") && Number(f.slice(0, 5)) >= startFrame) fs.rmSync(path.join(frames, f));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("pageerror", (e) => console.error("page error:", String(e)));

await page.goto(url);
await page.waitForFunction(() => { try { return !!mandelbrotDebug().frame; } catch { return false; } }, null, { timeout: 60000 });
// A clean picture: no Neuroglancer chrome, crosshair or scale bar; keep the info panel.
await page.evaluate(() => {
  viewer.uiConfiguration.showUIControls.value = false;
  viewer.showAxisLines.value = false;
  viewer.showScaleBar.value = false;
});
await page.addStyleTag({ content: ".neuroglancer-fork-banner, .neuroglancer-display-dimensions-widget, .neuroglancer-data-panel-layout-controls { display: none !important; }" });

// zoom = 3 / view width, view width = crossSectionScale * panel width * frame pixel size
// (frame pixel = 4 * 2^-(d + 22)). Frame switches rescale crossSectionScale, so
// zoom is always computed from the current frame depth.
const zoomNow = () => page.evaluate(() => {
  const d = Number(mandelbrotDebug().frame.split("/")[0]);
  const w = document.querySelector(".neuroglancer-rendered-data-panel").clientWidth;
  return Math.log10(3 / (viewer.crossSectionScale.value * w * 4 * 2 ** -(d + 22)));
});
const zoomBy = (log10Factor) => page.evaluate(([T, f]) => {
  viewer.crossSectionScale.value /= 10 ** f;
  mandelbrotGoto(T[0], T[1]);
}, [TARGET, log10Factor]);

async function settled() {
  // Settled = no in-view tile jobs queued or running, for 3 checks in a row.
  // (Off-screen jobs run in the background and are not waited for.)
  let quiet = 0;
  const t0 = Date.now();
  while (quiet < 3 && Date.now() - t0 < 600000) {
    await page.waitForTimeout(80);
    const p = await page.evaluate(() => mandelbrotPool());
    quiet = p.queued === 0 && p.foreground === 0 ? quiet + 1 : 0;
  }
  await page.waitForTimeout(60); // let the last chunks reach the GPU
}

// Start from the whole set, with a little margin.
await zoomBy(Math.log10(1 / 1.1) - (await zoomNow()));
await settled();
const t0 = Date.now();
if (fromExp !== undefined) {
  // Move to the starting zoom without recording, a factor of 4 at a time,
  // waiting at each step so that frame switches happen as they would live.
  console.log(`moving to 10^${fromExp}× …`);
  for (let z = await zoomNow(); Math.abs(Number(fromExp) - z) > 1e-9; z = await zoomNow()) {
    const step = Math.sign(Number(fromExp) - z) * Math.min(Math.log10(4), Math.abs(Number(fromExp) - z));
    await zoomBy(step);
    await settled();
  }
  console.log(`  there after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

let n = startFrame;
const shot = () => page.screenshot({ path: path.join(frames, `${String(n++).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92 });
for (const step of plan) {
  const count = Math.round(step.seconds * FPS);
  if (step.kind === "hold") {
    await settled();
    for (let i = 0; i < count; i++) await shot();
    continue;
  }
  const per = (step.exp - (await zoomNow())) / count; // log10 of the zoom factor per frame
  for (let f = 0; f < count; f++) {
    await zoomBy(per);
    await settled();
    await shot();
    if (f % FPS === 0) {
      const zoom = await page.evaluate(() => document.querySelector("#mb-zoom")?.textContent);
      console.log(`frame ${n - 1} (to 10^${step.exp}: ${f}/${count})  zoom ${zoom}  elapsed ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  }
}
await browser.close();

// Encode every frame in the folder, including any kept from an earlier run.
const pattern = path.join(frames, "%05d.jpg");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
let video;
if (hasFfmpeg) {
  video = path.join(outDir, "mandelbrot_zoom.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", pattern, "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-crf", "18", "-preset", "slow", "-movflags", "+faststart", video], { stdio: "inherit" });
} else {
  // Playwright's ffmpeg build reads images only through a pipe and encodes only VP8.
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), "Library/Caches/ms-playwright");
  const dir = fs.readdirSync(cache).filter((d) => d.startsWith("ffmpeg-")).sort().pop();
  const pwFfmpeg = path.join(cache, dir, os.platform() === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux");
  video = path.join(outDir, "mandelbrot_zoom.webm");
  const names = fs.readdirSync(frames).filter((f) => f.endsWith(".jpg")).sort();
  const input = Buffer.concat(names.map((f) => fs.readFileSync(path.join(frames, f))));
  execFileSync(pwFfmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "pipe:0",
    "-c:v", "libvpx", "-b:v", "8M", "-crf", "8", "-qmin", "0", "-qmax", "30", "-deadline", "good", video],
  { input, stdio: ["pipe", "inherit", "inherit"], maxBuffer: 1 << 30 });
  console.log("No ffmpeg on PATH, so this is VP8 WebM. For an MP4 that plays everywhere: brew install ffmpeg, then");
  console.log(`  ffmpeg -framerate ${FPS} -i ${pattern} -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart ${path.join(outDir, "mandelbrot_zoom.mp4")}`);
}
const total = fs.readdirSync(frames).filter((f) => f.endsWith(".jpg")).length;
console.log(`${n - startFrame} new frames (${total} in all, ${(total / FPS).toFixed(1)} s) in ${((Date.now() - t0) / 60000).toFixed(1)} min → ${video}`);

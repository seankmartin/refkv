// Serve the vzip-enabled Neuroglancer fork with a data directory, for viewing
// a state in your own browser (screenshot.mjs does the same headlessly).
//
// Usage:
//   node design/experiments/neuroglancer_demo/serve.mjs <data dir> <state.json> [port] [--web <dir> --page <file>]
//
// The built client is served at /, <data dir> at /data/, and the files of
// `--web <dir>` (e.g. a service worker) at /. Prints the URL to open, at
// `--page` (default: Neuroglancer itself) with the state in the hash.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const neuroglancer = process.env.NEUROGLANCER ?? path.join(here, "../../../../neuroglancer");
const require = createRequire(path.join(neuroglancer, "package.json"));
const { createServer } = require("http-server");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const web = opt("--web");
const page = opt("--page") ?? "";
const [dataDir, stateFile, port = "8765"] = args;

const stage = fs.mkdtempSync("/tmp/ng-vzip-serve-");
fs.cpSync(path.join(neuroglancer, "dist/client"), stage, { recursive: true });
if (web) fs.cpSync(web, stage, { recursive: true });
fs.cpSync(dataDir, path.join(stage, "data"), { recursive: true });

const server = createServer({ root: stage, cache: -1, cors: true }).server;
server.listen(Number(port), "127.0.0.1", () => {
  const base = `http://127.0.0.1:${port}`;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8").replaceAll("{base}", base));
  console.log(`${base}/${page}#!${encodeURIComponent(JSON.stringify(state))}`);
});

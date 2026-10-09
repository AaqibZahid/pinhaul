// Builds the unpacked extension into dist/.
//
// Two entry points are bundled with esbuild: the popup page and the Manifest V3
// service worker. The manifest, icons and static popup assets are copied
// verbatim, so dist/ is exactly what Chrome needs to load.

import { build, context } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "dist");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  minify: !watch,
  target: "chrome120",
  legalComments: "none",
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
};

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "popup"), { recursive: true });
await mkdir(path.join(out, "background"), { recursive: true });
await mkdir(path.join(out, "icons"), { recursive: true });

if (watch) {
  const ctx = await context({
    ...shared,
    entryPoints: [path.join(root, "src/popup/popup.ts")],
    outfile: path.join(out, "popup/popup.js"),
    format: "iife",
    loader: { ".css": "css" },
  });
  await ctx.watch();
  const swCtx = await context({
    ...shared,
    entryPoints: [path.join(root, "src/background/service-worker.ts")],
    outfile: path.join(out, "background/service-worker.js"),
    format: "esm",
  });
  await swCtx.watch();
  console.log("watching for changes");
} else {
  await build({
    ...shared,
    entryPoints: [path.join(root, "src/popup/popup.ts")],
    outfile: path.join(out, "popup/popup.js"),
    format: "iife",
    loader: { ".css": "css" },
  });
  await build({
    ...shared,
    entryPoints: [path.join(root, "src/background/service-worker.ts")],
    outfile: path.join(out, "background/service-worker.js"),
    format: "esm",
  });
  for (const file of ["manifest.json", "popup/popup.html", "popup/popup.css", "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png"]) {
    const from = path.join(root, "src", file);
    if (!existsSync(from)) continue;
    await mkdir(path.dirname(path.join(out, file)), { recursive: true });
    await copyFile(from, path.join(out, file));
  }
  console.log(`built ${path.relative(root, out)}`);
}

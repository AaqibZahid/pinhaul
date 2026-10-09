import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const extension = path.resolve(process.env.PINPULL_EXTENSION ?? path.join(root, "dist"));
const port = Number(process.env.PINPULL_PORT ?? 9229);
const chrome = process.env.PINPULL_CHROME ?? findChrome();

if (!existsSync(extension)) throw new Error(`extension directory not found: ${extension}`);
if (!chrome) throw new Error("Set PINPULL_CHROME to Chrome's executable path.");

const profile = await mkdtemp(path.join(os.tmpdir(), "pinpull-smoke-"));
const child = spawn(chrome, [
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extension}`,
  `--load-extension=${extension}`,
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  "about:blank",
], { stdio: "ignore" });
const exited = new Promise((resolve) => child.once("exit", resolve));

try {
  const target = await waitForServiceWorker(port);
  if (!target.url.startsWith("chrome-extension://")) throw new Error(`unexpected service worker target: ${target.url}`);
  console.log(`extension smoke test passed: ${target.url}`);
} finally {
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  await rm(profile, { recursive: true, force: true });
}

async function waitForServiceWorker(debugPort) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const worker = targets.find((target) => target.type === "service_worker");
      if (worker) return worker;
    } catch {
      // Chrome needs a moment to open the debugging endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Chrome opened, but Pinpull's service worker was not found");
}

function findChrome() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

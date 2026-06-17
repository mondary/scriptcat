#!/usr/bin/env node
/**
 * Disk-economy runner for `scriptcat-bisync.mjs`.
 *
 * Installs `playwright-core` into a temp dir, runs bisync with PLAYWRIGHT_NODE_MODULES
 * pointing at that temp `node_modules`, then deletes the temp dir.
 *
 * Usage:
 *   node extensions/chrome/src/scripts/scriptcat-bisync-economy.mjs [--apply] [...other args]
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

const repoRoot = process.cwd();
const bisyncPath = path.resolve(repoRoot, "extensions/chrome/src/scripts/scriptcat-bisync.mjs");

if (!fs.existsSync(bisyncPath)) {
  console.error("Missing bisync script:", bisyncPath);
  process.exit(1);
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "scriptcat-bisync-pw-"));

try {
  // Keep npm chatter off stdout so bisync JSON stays clean when redirected.
  await run("npm", ["init", "-y"], { cwd: tmp, stdio: ["ignore", "ignore", "inherit"] });
  await run("npm", ["i", "-D", "playwright"], { cwd: tmp, stdio: ["ignore", "ignore", "inherit"] });

  const env = { ...process.env, PLAYWRIGHT_NODE_MODULES: path.join(tmp, "node_modules") };
  await run(process.execPath, [bisyncPath, ...process.argv.slice(2)], { env });
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

#!/usr/bin/env node
/**
 * ScriptCat <-> snippets bidirectional sync (macOS Chrome profile).
 *
 * Reads ScriptCat data via chrome.storage.local inside an extension page (Playwright),
 * compares with local `snippets/*.user.js` files, then applies updates both ways.
 *
 * Defaults: dry-run. Use `--apply` to write.
 *
 * Usage:
 *   node extensions/chrome/src/scripts/scriptcat-bisync.mjs
 *   node extensions/chrome/src/scripts/scriptcat-bisync.mjs --apply
 *   node extensions/chrome/src/scripts/scriptcat-bisync.mjs --apply --profile Default
 *   node extensions/chrome/src/scripts/scriptcat-bisync.mjs --apply --snippets ./snippets
 *   node extensions/chrome/src/scripts/scriptcat-bisync.mjs --apply --ext-id <id> --ext-dir <unpacked-extension-dir>
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

function argValue(argv, name, fallback) {
  const idx = argv.indexOf(name);
  if (idx < 0) return fallback;
  const v = argv[idx + 1];
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function normalizeName(name) {
  return (name || "").trim();
}

const HEADER_BLOCK = /\/\/[ \t]*==UserScript==([\s\S]+?)\/\/[ \t]*==\/UserScript==/m;
const META_LINE = /\/\/[ \t]*@(\S+)[ \t]*(.*)$/gm;

function parseMetadata(code) {
  // Some snippet files might have literal "\\n" sequences (single-line file). Try to recover.
  const normalized = code.includes("\\n//") ? code.replaceAll("\\n", "\n") : code;
  const m = HEADER_BLOCK.exec(normalized);
  if (!m) return null;
  const headerContent = m[1];
  const metadata = {};
  META_LINE.lastIndex = 0;
  let mm;
  while ((mm = META_LINE.exec(headerContent)) !== null) {
    const key = String(mm[1]).toLowerCase();
    const val = (mm[2] ?? "").trim();
    (metadata[key] ||= []).push(val);
  }
  if (!metadata.name || Object.keys(metadata).length < 3) return null;
  if (!metadata.namespace) metadata.namespace = [""];
  return metadata;
}

function isHttpUrl(s) {
  return typeof s === "string" && (s.startsWith("http://") || s.startsWith("https://"));
}

function safeUrlHost(origin) {
  try {
    if (!isHttpUrl(origin)) return "";
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

function uuidv4() {
  const wc = globalThis.crypto?.getRandomValues ? globalThis.crypto : webcrypto;
  const b = wc.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseScriptFromCode(code, origin, uuid) {
  const metadata = parseMetadata(code);
  if (!metadata) throw new Error("Invalid userscript metadata block");
  if (!metadata.name?.[0]) throw new Error("Missing @name");
  const now = Date.now();
  const domain = safeUrlHost(origin);
  const checkUpdateUrl = origin && origin.includes("user.js") ? origin.replace("user.js", "meta.js") : origin;
  return {
    uuid: uuid || uuidv4(),
    name: metadata.name[0],
    author: metadata.author?.[0],
    namespace: metadata.namespace?.[0] ?? "",
    originDomain: domain,
    origin: origin || "",
    checkUpdate: true,
    checkUpdateUrl: checkUpdateUrl || "",
    downloadUrl: origin || "",
    config: undefined,
    metadata,
    selfMetadata: {},
    sort: -1,
    type: metadata.crontab ? 2 : metadata.background ? 3 : 1,
    status: metadata.crontab || metadata.background ? 2 : 1,
    runStatus: "complete",
    createtime: now,
    updatetime: now,
    checktime: now,
  };
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await fsp.copyFile(s, d);
  }
}

async function findInstalledScriptCatExtension({ chromeProfileDir }) {
  const extRoot = path.join(chromeProfileDir, "Extensions");
  if (!fs.existsSync(extRoot)) return null;

  const extIds = await fsp.readdir(extRoot).catch(() => []);
  for (const extId of extIds) {
    const extIdDir = path.join(extRoot, extId);
    let versions = [];
    try {
      versions = await fsp.readdir(extIdDir);
    } catch {
      continue;
    }
    for (const versionDirName of versions) {
      const manifestPath = path.join(extIdDir, versionDirName, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const txt = await fsp.readFile(manifestPath, "utf8");
        if (!/scriptcat/i.test(txt)) continue;
        const manifest = JSON.parse(txt);
        if (!manifest?.name) continue;
        if (String(manifest.author || "").toLowerCase().includes("codfrm") || /scriptcat/i.test(txt)) {
          return {
            extId,
            versionDirName,
            extDir: path.join(extIdDir, versionDirName),
          };
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

async function loadSnippets(snippetsDir) {
  const files = (await fsp.readdir(snippetsDir)).filter((f) => f.endsWith(".user.js"));
  const out = [];
  for (const file of files) {
    const filePath = path.join(snippetsDir, file);
    const raw = await fsp.readFile(filePath, "utf8");
    const code = raw.includes("\\n//") ? raw.replaceAll("\\n", "\n") : raw;
    const metadata = parseMetadata(code);
    if (!metadata?.name?.[0]) continue;
    const name = metadata.name[0];
    const namespace = metadata.namespace?.[0] ?? "";
    const stat = await fsp.stat(filePath);
    out.push({
      file,
      filePath,
      mtimeMs: stat.mtimeMs,
      name,
      namespace,
      key: normalizeName(name),
      code,
      metadata,
    });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "--apply");
  const chromeProfileName = argValue(argv, "--profile", "Default");
  const snippetsDir = path.resolve(argValue(argv, "--snippets", path.join(process.cwd(), "snippets")));
  const extIdOverride = argValue(argv, "--ext-id", null);
  const extDirOverride = argValue(argv, "--ext-dir", null);

  const chromeUserDataRoot = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
  const chromeProfileDir = path.join(chromeUserDataRoot, chromeProfileName);
  if (!fs.existsSync(chromeProfileDir)) {
    throw new Error(`Chrome profile not found: ${chromeProfileDir}`);
  }

  let extInfo = await findInstalledScriptCatExtension({ chromeProfileDir });
  if (!extInfo && (!extIdOverride || !extDirOverride)) {
    throw new Error("ScriptCat extension not found in this Chrome profile (use --ext-id + --ext-dir to override)");
  }
  if (extIdOverride || extDirOverride) {
    extInfo = {
      extId: extIdOverride || extInfo?.extId,
      versionDirName: extInfo?.versionDirName || "override",
      extDir: extDirOverride ? path.resolve(extDirOverride) : extInfo?.extDir,
    };
  }
  if (!extInfo?.extId || !extInfo?.extDir) throw new Error("Missing extId/extDir (check --ext-id / --ext-dir)");

  const extSettingsDir = path.join(chromeProfileDir, "Local Extension Settings", extInfo.extId);
  if (!fs.existsSync(extSettingsDir)) {
    throw new Error(`Missing extension settings dir: ${extSettingsDir}`);
  }

  const snippets = await loadSnippets(snippetsDir);
  const snippetsByName = new Map(snippets.map((s) => [s.key, s]));

  let chromium;
  const require = createRequire(import.meta.url);
  const extraPaths = [];
  // Allow an explicit module location for disk-saver mode.
  // Example: export PLAYWRIGHT_NODE_MODULES=/tmp/pw/node_modules
  if (process.env.PLAYWRIGHT_NODE_MODULES) {
    const nm = process.env.PLAYWRIGHT_NODE_MODULES;
    // require.resolve({paths}) expects project roots (parents of node_modules), not node_modules itself.
    extraPaths.push(nm.endsWith(`${path.sep}node_modules`) ? path.dirname(nm) : nm);
  }
  if (process.env.NODE_PATH) extraPaths.push(...process.env.NODE_PATH.split(path.delimiter).filter(Boolean));

  const tryLoad = async (name) => {
    try {
      const m = await import(name);
      return m?.chromium ? m : m?.default ? m.default : m;
    } catch {
      try {
        const resolved = require.resolve(name, { paths: extraPaths.length ? extraPaths : undefined });
        const m = await import(resolved);
        return m?.chromium ? m : m?.default ? m.default : m;
      } catch {
        return null;
      }
    }
  };

  const pwc = await tryLoad("playwright-core");
  const pw = pwc || (await tryLoad("playwright"));
  chromium = pw?.chromium;
  if (!chromium) {
    console.error(
      [
        "Missing dependency: playwright-core (or playwright).",
        "Disk-saver option (no repo node_modules):",
        "  1) mkdir -p /tmp/pw && cd /tmp/pw",
        "  2) npm init -y",
        "  3) npm i -D playwright-core",
        "  4) PLAYWRIGHT_NODE_MODULES=/tmp/pw/node_modules node " + path.resolve(process.cwd(), "extensions/chrome/src/scripts/scriptcat-bisync.mjs"),
      ].join("\n")
    );
    process.exit(1);
  }

  // Use isolated temp profile; copy ScriptCat's Local Extension Settings only.
  const tmpUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "scriptcat-bisync-"));
  const tmpDefault = path.join(tmpUserDataDir, "Default");
  await copyDir(extSettingsDir, path.join(tmpDefault, "Local Extension Settings", extInfo.extId));

  const wantsSystemChrome = hasFlag(argv, "--system-chrome");
  const chromeExe =
    process.platform === "darwin" && fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined;

  const context = await chromium.launchPersistentContext(tmpUserDataDir, {
    headless: false,
    executablePath: wantsSystemChrome ? chromeExe : undefined,
    args: [
      `--disable-extensions-except=${extInfo.extDir}`,
      `--load-extension=${extInfo.extDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extInfo.extId}/src/options.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof chrome !== "undefined" && !!chrome.storage?.local);

  const storage = await page.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get(null, resolve);
      })
  );

  const scripts = [];
  const scriptCodes = new Map();
  for (const [k, v] of Object.entries(storage || {})) {
    if (k.startsWith("script:")) scripts.push(v);
    if (k.startsWith("scriptCode:")) scriptCodes.set(k.slice("scriptCode:".length), v?.code ?? "");
  }

  const installedByName = new Map();
  for (const s of scripts) {
    const key = normalizeName(s?.name);
    if (!key) continue;
    if (!installedByName.has(key)) installedByName.set(key, []);
    installedByName.get(key).push(s);
  }

  const actions = [];

  // Snippets -> Installed
  for (const snip of snippets) {
    const installedList = installedByName.get(snip.key) || [];
    const installed =
      installedList.find((x) => (x?.namespace || "") === (snip.namespace || "")) || installedList[0] || null;
    if (!installed) {
      actions.push({ type: "install_from_snippet", key: snip.key, name: snip.name, file: snip.file });
      continue;
    }
    const installedCode = scriptCodes.get(installed.uuid) ?? "";
    const installedUpdated = Number(installed.updatetime || installed.createtime || 0);
    if (installedCode !== snip.code) {
      if (snip.mtimeMs > installedUpdated) {
        actions.push({ type: "update_installed_from_snippet", key: snip.key, name: snip.name, file: snip.file });
      } else {
        actions.push({ type: "update_snippet_from_installed", key: snip.key, name: snip.name, file: snip.file });
      }
    }
  }

  // Installed -> Snippets (missing files)
  for (const installed of scripts) {
    const key = normalizeName(installed?.name);
    if (!key) continue;
    if (!snippetsByName.has(key)) {
      actions.push({ type: "export_installed_to_snippets", key, name: installed.name });
    }
  }

  const summary = {
    apply,
    chromeProfileDir,
    extId: extInfo.extId,
    extVersion: extInfo.versionDirName,
    snippetsDir,
    installedCount: scripts.length,
    snippetsCount: snippets.length,
    actions,
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    await context.close();
    await fsp.rm(tmpUserDataDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  // Apply phase: mutate extension storage (in temp profile), then write back LevelDB by copying the updated dir.
  const storagePatches = {};
  const snippetWrites = [];

  for (const act of actions) {
    if (act.type === "install_from_snippet") {
      const snip = snippetsByName.get(act.key);
      if (!snip) continue;
      const script = parseScriptFromCode(snip.code, `file://${snip.file}`);
      const uuid = script.uuid;
      storagePatches[`script:${uuid}`] = script;
      storagePatches[`scriptCode:${uuid}`] = { uuid, code: snip.code };
      continue;
    }
    if (act.type === "update_installed_from_snippet") {
      const snip = snippetsByName.get(act.key);
      const installedList = installedByName.get(act.key) || [];
      const installed =
        installedList.find((x) => (x?.namespace || "") === (snip?.namespace || "")) || installedList[0] || null;
      if (!snip || !installed) continue;
      const uuid = installed.uuid;
      storagePatches[`scriptCode:${uuid}`] = { uuid, code: snip.code };
      storagePatches[`script:${uuid}`] = { ...installed, updatetime: Date.now() };
      continue;
    }
    if (act.type === "update_snippet_from_installed") {
      const snip = snippetsByName.get(act.key);
      const installedList = installedByName.get(act.key) || [];
      const installed =
        installedList.find((x) => (x?.namespace || "") === (snip?.namespace || "")) || installedList[0] || null;
      if (!snip || !installed) continue;
      const code = scriptCodes.get(installed.uuid) ?? "";
      if (!code) continue;
      snippetWrites.push({ filePath: snip.filePath, code });
      continue;
    }
    if (act.type === "export_installed_to_snippets") {
      const installed = scripts.find((s) => normalizeName(s?.name) === act.key);
      if (!installed) continue;
      const code = scriptCodes.get(installed.uuid) ?? "";
      if (!code) continue;
      const safeFile =
        String(installed.name || "script")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "") + ".user.js";
      const filePath = path.join(snippetsDir, safeFile);
      snippetWrites.push({ filePath, code });
      continue;
    }
  }

  if (Object.keys(storagePatches).length) {
    await page.evaluate(
      (patches) =>
        new Promise((resolve) => {
          chrome.storage.local.set(patches, resolve);
        }),
      storagePatches
    );
  }

  for (const w of snippetWrites) {
    await fsp.mkdir(path.dirname(w.filePath), { recursive: true });
    await fsp.writeFile(w.filePath, w.code, "utf8");
  }

  await context.close();

  // Copy back updated extension LevelDB to real profile.
  const tmpExtSettings = path.join(tmpDefault, "Local Extension Settings", extInfo.extId);
  if (!fs.existsSync(tmpExtSettings)) throw new Error("Temp extension settings missing");

  const backupDir = path.join(
    chromeProfileDir,
    "Local Extension Settings",
    `${extInfo.extId}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  await copyDir(extSettingsDir, backupDir);
  await fsp.rm(extSettingsDir, { recursive: true, force: true });
  await copyDir(tmpExtSettings, extSettingsDir);

  await fsp.rm(tmpUserDataDir, { recursive: true, force: true }).catch(() => {});

  console.log(JSON.stringify({ ...summary, applied: true, backupDir }, null, 2));
}

main().catch((e) => {
  console.error("ERROR", e?.message || e);
  process.exitCode = 1;
});

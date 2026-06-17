#!/usr/bin/env node
/**
 * Convert Stylus JSON export to ScriptCat-compatible `.user.js` snippets.
 *
 * Writes one userscript per Stylus style into `snippets/` (default).
 *
 * Key difference vs Stylus:
 * - Stylus can apply CSS with higher precedence (user origin).
 * - Userscripts inject <style> (author origin). To approximate Stylus behavior, use `--force-important`.
 *
 * Usage:
 *   node extensions/chrome/src/scripts/stylus-to-snippets.mjs /path/to/stylus-export.json
 *   node extensions/chrome/src/scripts/stylus-to-snippets.mjs /path/to/stylus-export.json --write
 *   node extensions/chrome/src/scripts/stylus-to-snippets.mjs /path/to/stylus-export.json --write --force-important
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function hasFlag(argv, name) {
  return argv.includes(name);
}

function argValue(argv, name, fallback) {
  const idx = argv.indexOf(name);
  if (idx < 0) return fallback;
  const v = argv[idx + 1];
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

function slugify(input) {
  return String(input || "style")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function looksLikeJS(code) {
  const c = String(code || "").trim();
  if (!c) return false;
  if (/^\s*(\/\/|\/\*)/.test(c) && /\bdocument\.querySelector\b/.test(c)) return true;
  if (/\b(document|window)\./.test(c)) return true;
  if (/\bquerySelector(All)?\b/.test(c)) return true;
  if (/\bconst\s+\w+\s*=|=>|function\s*\(/.test(c) && !/[{][^}]*:[^}]*[}]/.test(c)) return true;
  return false;
}

function sectionMatchers(section) {
  return {
    urls: Array.isArray(section.urls) ? section.urls.filter(Boolean) : [],
    urlPrefixes: Array.isArray(section.urlPrefixes) ? section.urlPrefixes.filter(Boolean) : [],
    domains: Array.isArray(section.domains) ? section.domains.filter(Boolean) : [],
    regexps: Array.isArray(section.regexps) ? section.regexps.filter(Boolean) : [],
  };
}

function buildRuntimeMatcher(matchers) {
  const urls = matchers.urls || [];
  const urlPrefixes = matchers.urlPrefixes || [];
  const domains = matchers.domains || [];
  const regexps = matchers.regexps || [];

  const lines = [];
  lines.push("  const href = location.href;");
  lines.push("  const host = location.hostname;");
  lines.push("  const matchAny = (arr, fn) => { for (const v of arr) { if (fn(v)) return true; } return false; };");
  lines.push("  const domainMatches = (d) => host === d || host.endsWith('.' + d);");
  lines.push("  const wildcardToPrefix = (u) => { const i = u.indexOf('*'); return i >= 0 ? u.slice(0, i) : u; };");
  lines.push("  const urlRuleMatches = (u) => href.startsWith(wildcardToPrefix(u));");
  lines.push("  const reMatches = (r) => { try { return new RegExp(r).test(href); } catch { return false; } };");
  lines.push("  const ok = (");
  const parts = [];
  if (urls.length) parts.push(`matchAny(${JSON.stringify(urls)}, urlRuleMatches)`);
  if (urlPrefixes.length) parts.push(`matchAny(${JSON.stringify(urlPrefixes)}, (p) => href.startsWith(p))`);
  if (domains.length) parts.push(`matchAny(${JSON.stringify(domains)}, domainMatches)`);
  if (regexps.length) parts.push(`matchAny(${JSON.stringify(regexps)}, reMatches)`);
  if (!parts.length) parts.push("true");
  lines.push("    " + parts.join(" || "));
  lines.push("  );");
  lines.push("  return ok;");
  return lines.join("\n");
}

function renderUserScript({ name, enabled, sections, styleId, sourceHash, forceImportant }) {
  const scriptName = `Stylus - ${name}`;
  const anyDisabled = enabled === false;

  const sectionEntries = sections.map((sec) => {
    const m = sectionMatchers(sec);
    return {
      matchers: m,
      isJS: looksLikeJS(sec.code),
      code: String(sec.code || ""),
    };
  });

  const allMatchers = { urls: [], urlPrefixes: [], domains: [], regexps: [] };
  for (const s of sectionEntries) {
    allMatchers.urls.push(...s.matchers.urls);
    allMatchers.urlPrefixes.push(...s.matchers.urlPrefixes);
    allMatchers.domains.push(...s.matchers.domains);
    allMatchers.regexps.push(...s.matchers.regexps);
  }

  const matcherFn = buildRuntimeMatcher(allMatchers);

  const bodyLines = [];
  bodyLines.push("(function () {");
  bodyLines.push("  'use strict';");
  bodyLines.push("");
  bodyLines.push("  const shouldRun = () => {");
  bodyLines.push(matcherFn);
  bodyLines.push("  };");
  bodyLines.push("  if (!shouldRun()) return;");
  bodyLines.push("");

  const cssParts = [];
  const jsParts = [];
  for (const s of sectionEntries) {
    if (!s.code.trim()) continue;
    if (s.isJS) jsParts.push(s.code.trim());
    else cssParts.push(s.code.trim());
  }

  if (cssParts.length) {
    bodyLines.push(`  let css = ${JSON.stringify(cssParts.join("\n\n"))};`);
    if (forceImportant) {
      bodyLines.push("  // Approximate Stylus (user-origin) precedence: force !important.");
      bodyLines.push(
        "  css = css.replace(/(!important)\\s*;/gi, ';').replace(/:([^;{}]+);/g, (m, v) => `:${v.trim()} !important;`);"
      );
    }
    bodyLines.push("  if (typeof GM_addStyle === 'function') {");
    bodyLines.push("    GM_addStyle(css);");
    bodyLines.push("  } else {");
    bodyLines.push("    const style = document.createElement('style');");
    bodyLines.push("    style.textContent = css;");
    bodyLines.push("    (document.head || document.documentElement).appendChild(style);");
    bodyLines.push("  }");
    bodyLines.push("");
  }

  if (jsParts.length) {
    bodyLines.push("  // JS payload from Stylus section(s)");
    for (const chunk of jsParts) {
      bodyLines.push("  (function(){");
      for (const line of chunk.split("\n")) bodyLines.push("    " + line);
      bodyLines.push("  })();");
      bodyLines.push("");
    }
  }

  bodyLines.push("})();");

  const meta = [
    "// ==UserScript==",
    `// @name         ${scriptName}`,
    "// @namespace    https://local.stylus.import",
    `// @version      1.0.1`,
    `// @description  Imported from Stylus export (id=${styleId}, sha1=${sourceHash.slice(0, 8)})`,
    "// @match        *://*/*",
    "// @grant        GM_addStyle",
    anyDisabled ? "// @run-at       document-idle" : "// @run-at       document-start",
    "// ==/UserScript==",
  ].join("\n");

  return `${meta}\n\n${bodyLines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const input = argv[0];
  if (!input) throw new Error("Missing input Stylus JSON path");

  const outDir = path.resolve(argValue(argv, "--out", path.join(process.cwd(), "snippets")));
  const write = hasFlag(argv, "--write");
  const forceImportant = hasFlag(argv, "--force-important");

  const raw = await fsp.readFile(input, "utf8");
  const json = JSON.parse(raw);
  if (!Array.isArray(json)) throw new Error("Unexpected Stylus export format (expected array)");

  const styles = json.filter((o) => o && typeof o === "object" && Array.isArray(o.sections) && typeof o.name === "string");

  const nameCounts = new Map();
  const hashToNames = new Map();
  const outputs = [];

  for (const s of styles) {
    const name = s.name.trim();
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);

    const codeJoin = (s.sections || []).map((sec) => String(sec.code || "")).join("\n\n");
    const sourceHash = sha1(codeJoin);
    if (!hashToNames.has(sourceHash)) hashToNames.set(sourceHash, []);
    hashToNames.get(sourceHash).push(name);

    const slug = slugify(name) || "style";
    const fileBase = `stylus-${slug}.user.js`;
    outputs.push({
      name,
      fileBase,
      enabled: !!s.enabled,
      styleId: s.id ?? s._id ?? "",
      sourceHash,
      sections: s.sections || [],
    });
  }

  const duplicateNames = [...nameCounts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  const duplicateContent = [...hashToNames.entries()].filter(([, names]) => names.length > 1);

  const report = {
    input,
    stylesCount: styles.length,
    outDir,
    write,
    forceImportant,
    duplicates: {
      names: duplicateNames,
      content: duplicateContent.map(([hash, names]) => ({ hash: hash.slice(0, 12), names })),
    },
  };

  if (!write) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await fsp.mkdir(outDir, { recursive: true });

  const used = new Set();
  for (const o of outputs) {
    const baseNoExt = o.fileBase.replace(/\\.user\\.js$/, "");
    let finalBase = o.fileBase;
    let n = 2;
    while (used.has(finalBase)) {
      finalBase = `${baseNoExt}__dup${n}.user.js`;
      n += 1;
    }
    used.add(finalBase);
    const outPath = path.join(outDir, finalBase);
    const script = renderUserScript({
      name: o.name,
      enabled: o.enabled,
      sections: o.sections,
      styleId: o.styleId,
      sourceHash: o.sourceHash,
      forceImportant,
    });
    await fsp.writeFile(outPath, script, "utf8");
  }

  console.log(JSON.stringify({ ...report, written: outputs.length }, null, 2));
}

main().catch((e) => {
  console.error("ERROR", e?.message || e);
  process.exitCode = 1;
});


#!/usr/bin/env node
// Cheap SYSTEM_DESIGN.md §1 check: a `var(--name)` that is not in
// tokens.css, not defined as a local custom property, and not bound
// from JS, paints the CSS fallback in silence. No Electron, no display.
//
// Known gap (not a failure until the TaskCard owner replaces it):
// TaskCard.module.css `.sprintRow` uses `var(--bg)` with no definition.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Documented silent fallbacks. Name + file suffix. A NEW file using
 * the same name still fails. Remove the row when the owner fixes it. */
const KNOWN_UNDEFINED = [
  {
    name: "--bg",
    fileSuffix: "TaskCard.module.css",
    note: "SYSTEM_DESIGN silent fallback: .sprintRow uses var(--bg) with no definition. Replace with var(--surface) or var(--panel).",
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(css|tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src, kind) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (kind === "js") {
    out = out.replace(/(^|[^:])\/\/.*$/gm, "$1");
  } else {
    out = out.replace(/^\s*\/\/.*$/gm, "");
  }
  return out;
}

function lineDefs(src) {
  const set = new Set();
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*(--[a-zA-Z0-9-]+)\s*:/);
    if (m) set.add(m[1]);
  }
  return set;
}

function jsBindings(src) {
  const set = new Set();
  for (const m of src.matchAll(/["'](--[a-zA-Z0-9-]+)["'](?:\s+as\s+\w+)?\s*\]?\s*:/g)) {
    set.add(m[1]);
  }
  for (const m of src.matchAll(/setProperty\(\s*["'](--[a-zA-Z0-9-]+)["']/g)) {
    set.add(m[1]);
  }
  return set;
}

function varUses(src) {
  const set = new Set();
  for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) set.add(m[1]);
  return set;
}

export function scanDesignTokens(root = PROJECT_ROOT) {
  const tokensPath = join(root, "src/renderer/src/styles/tokens.css");
  const rendererRoot = join(root, "src/renderer");
  const catalog = lineDefs(stripComments(readFileSync(tokensPath, "utf8"), "css"));
  const locals = new Set();
  const used = new Map();

  for (const abs of walk(rendererRoot)) {
    if (abs.endsWith("tokens.css")) continue;
    const rel = relative(root, abs);
    const kind = /\.css$/.test(abs) ? "css" : "js";
    const src = stripComments(readFileSync(abs, "utf8"), kind);
    for (const d of lineDefs(src)) locals.add(d);
    if (kind === "js") for (const d of jsBindings(src)) locals.add(d);
    for (const u of varUses(src)) {
      if (!used.has(u)) used.set(u, []);
      used.get(u).push(rel);
    }
  }

  const missing = [];
  const known = [];
  for (const [name, files] of [...used.entries()].sort()) {
    if (catalog.has(name) || locals.has(name)) continue;
    const gap = KNOWN_UNDEFINED.find(
      (g) => g.name === name && files.every((f) => f.endsWith(g.fileSuffix)),
    );
    if (gap) known.push({ name, files, note: gap.note });
    else missing.push({ name, files });
  }

  return { catalog, locals, used, missing, known };
}

function main() {
  const { catalog, used, missing, known } = scanDesignTokens();
  for (const g of known) {
    console.log(`check-design-tokens: known gap ${g.name} (${g.files.join(", ")})`);
    console.log(`  ${g.note}`);
  }
  if (missing.length) {
    console.error("check-design-tokens: var() with no definition in tokens.css, renderer locals, or JS bindings:");
    for (const { name, files } of missing) {
      console.error(`  ${name}`);
      for (const f of files) console.error(`    ${f}`);
    }
    process.exit(1);
  }
  console.log(
    `check-design-tokens: ok — ${catalog.size} tokens in tokens.css, ${used.size} var() names resolved` +
      (known.length ? `, ${known.length} documented gap(s)` : ""),
  );
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

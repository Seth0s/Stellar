#!/usr/bin/env node
// Design-token checks — two layers.
//
// LAYER 1 — var() EXISTENCE (the original check): a `var(--name)` that is
// not in tokens.css, not defined as a local custom property, and not bound
// from JS, paints the CSS fallback in silence. No Electron, no display.
//
// LAYER 2 — SPACING SCALE (task d200c269): raw px in RHYTHM properties
// (padding/margin/gap family) is a violation, with exactly three outs:
//
//   a. the value is zero (0 / 0px — zero needs no token);
//   b. the line declares an escape: `/* sd:allow: <reason> */` — the reason
//      is REQUIRED; a bare `sd:allow` is itself a violation, because an
//      escape without a stated reason is a back door, not documentation;
//   c. the file's violation count is at or below its FROZEN BASELINE
//      (scripts/verify/design-tokens-baseline.json).
//
// ADOPTION PATH (why the baseline exists — failing 800+ occurrences today
// would make the check unusable, and "warn only" never becomes an error):
//   - a file NOT in the baseline must be at ZERO → new code is born on the
//     scale (this is the tooth that stops the next hand-written line);
//   - a file IN the baseline may not GROW → existing debt is frozen;
//   - migrating a slice is a RATCHET DOWN: after the migration lands, run
//     `node scripts/verify/check-design-tokens.mjs --update-baseline` to
//     freeze the new (lower) count. A file that reaches 0 is PINNED: its
//     entry lands as an explicit 0 and any raw px that reappears fails —
//     updateBaseline writes that 0 itself (pinned by the write-path test).
//
// SCAN LIMITS (declared frontier): the scan is LINE-based — one declaration
// per line, ending in `;`. It does NOT see: a value continued on the next
// line, a SECOND declaration on the same line (only the first `prop:` of the
// line is attributed), or a last declaration missing its `;` before `}`.
// Applies to every rule below. In the typography rule `rem`/`em` are out by
// design (a relative size is not a step); here `rem`/`em` are simply not the
// unit this scale speaks.
// Under prettier none of these occur in this repo — but a hand-typed line
// is written before it is formatted; when in doubt, run the checker after
// formatting. Counts are DECLARATIONS (`padding: 7px 10px` is one), not px
// instances.
//
// LAYER 3 — TYPOGRAPHIC SCALE (task c8cd45fc, part 2 of the design system):
// raw px `font-size` is a violation, with the SAME three outs and the SAME
// mechanism as layer 2 — one more entry in SD_RULES with its own baseline
// section, the same pin/ratchet and the same audited escape. Nothing was
// re-implemented for it; the machinery is shared by design.
//
// FRONTIER OF THE TYPOGRAPHY RULE — only a SINGLE px literal counts
// (`font-size: 11px`). Deliberately NOT seen: `clamp()`/`calc()` (the
// `.card-head`/`.card-foot` scale with the card's own width via `cqw`),
// `var(--sticky-font-size, …)` (the sticky note's OWN user-controlled size)
// and `em` (the relative cascade of the markdown inside it). Flagging any of
// those would either break the scaling or move a size the USER owns — and the
// terminal's per-card size never reaches CSS at all: it is an xterm option set
// from JS (`useTerminal.ts`'s `BASE_FONT_SIZE`), out of this scan's reach by
// construction.
//
// What is deliberately NOT checked here: coordinates (top/right/bottom/
// left/inset) are layout GEOMETRY, not rhythm — the precedent is
// --titlebar-h — and a spacing token on a positional offset would be a
// type error. border/width/height/font-size are other concerns (the
// typography task owns font-size; see docs/SYSTEM_DESIGN.md §9 for the
// measured data). Inline styles in TSX are a known, measured gap (5
// occurrences today) — the rule structure extends to them when needed.
//
// GENERALIZATION: the sibling design-system tasks (typography, radius,
// motion) add an entry to SD_RULES — properties + their own baseline
// section. The mechanism (baseline + ratchet + declared escape) is the
// shared part; adding a rule must not require rewriting it.
//
// Known gap (not a failure until the TaskCard owner replaces it):
// TaskCard.module.css `.sprintRow` uses `var(--bg)` with no definition.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Baseline lives beside the checker; rooted so tests can exercise the
 * WRITE path against a throwaway tree. */
function baselinePath(root = PROJECT_ROOT) {
  return join(root, "scripts", "verify", "design-tokens-baseline.json");
}

/** Rhythm properties the `--space-*` scale governs. The suffix list covers
 * the logical/physical shorthands CSS actually ships. */
const RHYTHM_PROP_RE =
  /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|x|y|block|inline|block-start|block-end|inline-start|inline-end))?$/;

/** The one property the `--text-*` scale governs. */
const FONT_SIZE_PROP_RE = /^font-size$/;

/** px instances inside one declaration value. Zero is exempt: `padding: 0`
 * needs no token. */
function pxInstances(value) {
  const out = [];
  for (const m of value.matchAll(/(-?\d+(?:\.\d+)?)px\b/gi)) {
    if (Number(m[1]) === 0) continue;
    out.push(m[1]);
  }
  return out;
}

/** A font-size is "raw" only when the WHOLE value is a single px literal.
 * `clamp()`/`calc()` scale with the container, `var(--sticky-font-size, …)` is
 * the sticky's own user-controlled size and `em` is the relative cascade of
 * the markdown inside it — none of them is a step, and letting the rule touch
 * them would either break the scaling or move a size the USER owns. */
function pxLiteralValue(value) {
  const m = value.trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
  if (!m || Number(m[1]) === 0) return [];
  return [m[1]];
}

/**
 * The seed rule set — the mechanism is shared, each domain adds an entry with
 * its own baseline section: `propRe` (which properties), `raw` (what counts as
 * a violation in the VALUE) and the same escape marker. Part 1 seeded
 * "spacing"; part 2 added "typography" without touching the machinery.
 * Radius/motion join here the same way.
 */
export const SD_RULES = [
  {
    id: "spacing",
    description:
      "raw px in rhythm properties (padding/margin/gap) — use --space-* (docs/SYSTEM_DESIGN.md §1.5)",
    propRe: RHYTHM_PROP_RE,
    raw: pxInstances,
    tokenFamily: "--space-*",
    noun: "with raw px in rhythm properties",
  },
  {
    id: "typography",
    description:
      "raw px font-size (a single px literal) — use --text-* (docs/SYSTEM_DESIGN.md §1.6)",
    propRe: FONT_SIZE_PROP_RE,
    raw: pxLiteralValue,
    tokenFamily: "--text-*",
    noun: "with a single px font-size",
  },
];

const RULE_SPACING = SD_RULES[0];
const RULE_TYPOGRAPHY = SD_RULES[1];

/** A declared escape: reason is mandatory, on the same line as the
 * declaration it excuses. Printed in every run — an invisible escape is a
 * back door; an audited one is documentation. */
const ESCAPE_RE = /\/\*\s*sd:allow:\s*(.+?)\s*\*\//;
const ESCAPE_BARE_RE = /\bsd:allow\b/;

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

function walkCss(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkCss(p, out);
    else if (name.endsWith(".css") && name !== "tokens.css") out.push(p);
  }
  return out;
}

function stripComments(src, kind) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (kind === "js") {
    out = out.replace(/(^|[^:])\/\/.*$/gm, "");
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

/**
 * Pure: one SD rule's verdict for one CSS source. Lines that are comment
 * chrome (start with `*` or `/*`) never count as declarations, because the
 * scan runs on RAW source — it has to, to see the escape markers.
 *
 * Returns { violations, escapes }: an escape is NOT a violation; it is
 * returned so every report prints it. A bare `sd:allow` without a reason
 * comes back as a violation of its own.
 */
export function scanRuleSource(src, rule) {
  const violations = [];
  const escapes = [];
  src.split("\n").forEach((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) return;
    const decl = line.match(/^\s*([a-z-]+)\s*:\s*([^;]+);/);
    if (!decl) return;
    const [, prop, value] = decl;
    if (!rule.propRe.test(prop)) return;
    const instances = rule.raw(value);
    if (instances.length === 0) return;
    const escape = line.match(ESCAPE_RE);
    if (escape) {
      // A blank reason (`/* sd:allow: */`, spaces/tabs) is NOT an escape —
      // the back door the module claims to refuse does not open with a
      // space. Falls through as a violation of its own.
      if (!escape[1].trim()) {
        violations.push({
          line: index + 1,
          property: prop,
          values: instances,
          reason: "sd:allow with an empty reason — say WHY on the marker or remove it",
        });
        return;
      }
      escapes.push({ line: index + 1, property: prop, reason: escape[1] });
      return;
    }
    if (ESCAPE_BARE_RE.test(line)) {
      violations.push({
        line: index + 1,
        property: prop,
        values: instances,
        reason: 'sd:allow without a reason — an escape must say WHY: /* sd:allow: <reason> */',
      });
      return;
    }
    violations.push({ line: index + 1, property: prop, values: instances });
  });
  return { violations, escapes };
}

/** Convenience wrappers — same function, the rule bound. Kept named so the
 * tests and the reports read as the domain, not as the index of SD_RULES. */
export function scanSpacingSource(src) {
  return scanRuleSource(src, RULE_SPACING);
}
export function scanTypographySource(src) {
  return scanRuleSource(src, RULE_TYPOGRAPHY);
}

/** One SD rule against the whole renderer: violations and escapes per file
 * (tokens.css excluded — its px are DEFINITIONS). */
export function scanRule(root = PROJECT_ROOT, rule = RULE_SPACING) {
  const rendererRoot = join(root, "src/renderer");
  const perFile = {};
  const escapesByFile = {};
  for (const abs of walkCss(rendererRoot)) {
    const rel = relative(root, abs);
    const { violations, escapes } = scanRuleSource(readFileSync(abs, "utf8"), rule);
    if (violations.length > 0) perFile[rel] = violations.length;
    if (escapes.length > 0) escapesByFile[rel] = escapes;
  }
  return { perFile, escapesByFile };
}

export function scanSpacingRule(root = PROJECT_ROOT) {
  return scanRule(root, RULE_SPACING);
}
export function scanTypographyRule(root = PROJECT_ROOT) {
  return scanRule(root, RULE_TYPOGRAPHY);
}

function loadBaseline(root = PROJECT_ROOT) {
  const path = baselinePath(root);
  if (!existsSync(path)) return { comment: "", rules: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Frozen-baseline enforcement for one rule: unlisted file must be at 0;
 * listed file may not grow. Pure given perFile + baseline section. */
export function checkAgainstBaseline(perFile, frozenSection, rule = RULE_SPACING) {
  const family = rule.tokenFamily ?? "--space-*";
  const failures = [];
  const files = new Set([...Object.keys(frozenSection ?? {}), ...Object.keys(perFile)]);
  for (const file of [...files].sort()) {
    const now = perFile[file] ?? 0;
    const frozen = frozenSection?.[file];
    if (frozen === undefined) {
      if (now > 0) {
        failures.push({
          file,
          now,
          frozen: null,
          message: `raw px in a file with no frozen baseline — new code uses ${family} (or declares /* sd:allow: reason */)`,
        });
      }
    } else if (now > frozen) {
      failures.push({
        file,
        now,
        frozen,
        message: `grew by ${now - frozen} over the frozen baseline — migrate to ${family} or declare an escape`,
      });
    }
  }
  return failures;
}

/** Scaffolding for the write-path test: rooted so a throwaway tree can
 * exercise the real write. The ratchet-to-zero behavior itself is under
 * test in tests/unit/design-tokens.test.ts. Writes EVERY rule's section, so
 * adding a rule to SD_RULES needs no change here. */
export function updateBaseline(root = PROJECT_ROOT) {
  const path = baselinePath(root);
  const baseline = loadBaseline(root);
  const rules = { ...(baseline.rules ?? {}) };
  const report = [];

  for (const rule of SD_RULES) {
    const { perFile } = scanRule(root, rule);
    const section = { ...(rules[rule.id] ?? {}) };
    // Measured counts overwrite the frozen ones…
    for (const [file, count] of Object.entries(perFile)) section[file] = count;
    // …a listed file that no longer reports violations lands as an EXPLICIT 0
    // — that 0 is the pin: the pre-migration debt cannot come back (a bare
    // absence would let it, which is exactly the hole the write-path test
    // pins shut);
    for (const file of Object.keys(section)) {
      if (perFile[file] === undefined) section[file] = 0;
    }
    // …and a file that left the tree has no debt to freeze — prune it.
    for (const file of Object.keys(section)) {
      if (!existsSync(join(root, file))) delete section[file];
    }
    const sorted = Object.fromEntries(Object.entries(section).sort());
    rules[rule.id] = sorted;
    const total = Object.values(sorted).reduce((a, b) => a + b, 0);
    const pinned = Object.values(sorted).filter((v) => v === 0).length;
    report.push(
      `${Object.keys(sorted).length} file(s), ${total} frozen violating declaration(s) for rule "${rule.id}"` +
        (pinned > 0 ? `, ${pinned} file(s) pinned at 0` : ""),
    );
  }

  const next = {
    comment:
      "Frozen violation counts per design-token rule (tasks d200c269 spacing, c8cd45fc typography). A file NOT listed here must be at ZERO — new code uses the rule's token family (--space-*, --text-*). A listed file may not GROW. After migrating a slice, run `node scripts/verify/check-design-tokens.mjs --update-baseline` to freeze the new (lower) count; a file that reached 0 is PINNED clean — its entry stays at an explicit 0 and any raw px that reappears fails the check. Escapes: /* sd:allow: <reason> */ — audited in every run.",
    rules,
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  for (const line of report) console.log(`check-design-tokens: baseline updated — ${line}`);
}

function ruleCheck(rule) {
  const { perFile, escapesByFile } = scanRule(PROJECT_ROOT, rule);
  const baseline = loadBaseline();
  const failures = checkAgainstBaseline(perFile, baseline.rules?.[rule.id], rule);

  const total = Object.values(perFile).reduce((a, b) => a + b, 0);
  const escapedTotal = Object.values(escapesByFile).reduce((a, b) => a + b.length, 0);
  console.log(
    `check-design-tokens: ${rule.id} — ${total} violating declaration(s) ${rule.noun} across ${Object.keys(perFile).length} file(s) ` +
      `(counts are declarations, not px instances), ${escapedTotal} declared escape(s), frozen baseline: ${baseline.rules?.[rule.id] ? "loaded" : "MISSING"}`,
  );
  for (const [file, escapes] of Object.entries(escapesByFile)) {
    for (const e of escapes) {
      console.log(`  sd:allow ${file}:${e.line} (${e.property}) — ${e.reason}`);
    }
  }
  if (failures.length > 0) {
    console.error(`check-design-tokens: ${rule.id} baseline violations:`);
    for (const f of failures) {
      console.error(`  ${f.file} — now ${f.now}, frozen ${f.frozen ?? "absent"}: ${f.message}`);
    }
  }
  return failures;
}

function main() {
  const wantsUpdate = process.argv.includes("--update-baseline");
  if (wantsUpdate) {
    updateBaseline();
    return;
  }

  const { catalog, used, missing, known } = scanDesignTokens();
  for (const g of known) {
    console.log(`check-design-tokens: known gap ${g.name} (${g.files.join(", ")})`);
    console.log(`  ${g.note}`);
  }
  let failed = false;
  if (missing.length) {
    failed = true;
    console.error("check-design-tokens: var() with no definition in tokens.css, renderer locals, or JS bindings:");
    for (const { name, files } of missing) {
      console.error(`  ${name}`);
      for (const f of files) console.error(`    ${f}`);
    }
  } else {
    console.log(
      `check-design-tokens: ok — ${catalog.size} tokens in tokens.css, ${used.size} var() names resolved` +
        (known.length ? `, ${known.length} documented gap(s)` : ""),
    );
  }

  for (const rule of SD_RULES) {
    if (ruleCheck(rule).length > 0) failed = true;
  }

  if (failed) process.exit(1);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

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
// SCAN LIMITS — what this parser reads. (Task 0f96fbda rewrote this note: the
// previous version declared a limit that no longer exists, and justified the
// limit with an argument that was BACKWARDS. Do not restore it — see below.)
//
// It reads the DECLARATION, not the line: `prop: value;`, where the value may
// span several lines, and where a SECOND declaration on the same line is a
// declaration of its own. Comments are blanked out by offset, so a
// commented-out declaration is never a violation. Per rule: in typography
// `rem`/`em` are out by design (a relative size is not a step); in motion
// `delay` and `easing` are out by design. Counts are DECLARATIONS
// (`padding: 7px 10px` is one), not instances. Applies to every rule below.
//
// The one shape still out of reach: a declaration with no terminating `;`.
//
// WHY THE PARSE CHANGED, and why the old note was wrong. The scan used to read
// ONE LINE at a time, so a value broken across lines was neither a violation
// nor frozen — it did not exist for the gate at all. Three such declarations
// exist here (MediaCard.module.css:64, layout.css:246 and layout.css:3200,
// +13 items), and they are not a typing accident: they are what `npm run
// format` PRODUCES. The old note said "under prettier none of these occur in
// this repo", and the measurement showed that to be exactly backwards — but for
// ONE rule only, and the reason is the comma:
//   - spacing, typography and radius: ZERO invisible declarations, measured.
//     Their values are SPACE separated (`padding: 1px 7px`) and the formatter
//     leaves those on one line;
//   - motion: a value is a COMMA separated list, and prettier at printWidth 100
//     breaks it — `transition: left X ease, top X ease` becomes three lines,
//     token or not.
// That is why the hole was motion-only and why the old justification must not
// come back: for motion it was not a stale excuse, it was the opposite of what
// the formatter does. Closing it moved the motion baseline 33 → 36 and nothing
// else (the other three sections were byte identical), and it retired two
// smaller limits with it: the second declaration on a line, and the line that
// merely STARTS with `*` blacklisting whatever followed.
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
// LAYER 4 — RADIUS SCALE (task 325d6c66, part 3 of the design system): a raw
// `border-radius` value is a violation, with the SAME three outs and the SAME
// machinery as layers 2 and 3 — one more SD_RULES entry, its own baseline
// section, the same pin/ratchet and the same audited escape. Nothing was
// re-implemented for it either.
//
// THE TRAPS OF THIS DOMAIN, named — a radius scale gets these wrong first:
//   - `999px` is a FORM, not a step: PILL, "as round as the box allows". The
//     same role is spelled `99px` and `20px` elsewhere (the four 20px toolbar
//     chips of the inspector are already capsules at their ~20px height).
//     --radius-pill names it.
//   - `50%` is the other FORM: CIRCLE, "half the box". It is relative to the
//     ELEMENT, so on a square it is the circle and on a rectangle it is an
//     ellipse — all 19 current uses were checked one by one and are square
//     boxes. --radius-circle names it.
//   - Numbering either form (as --radius-6/7) would leave 11..998 missing from
//     the ruler: that is the invented-scale mistake, not a scale.
//   - `--radius` (10px) is the PRE-EXISTING token and a real step (--radius-5,
//     13 declarations, all the container role: card frame, clip, modal,
//     popover). It survives as an alias so no reference dangles; new code
//     writes --radius-5.
// What counts as raw here is narrower than the rhythm rule and wider than the
// typography one: any non-zero px PLUS the bare `50%`. Leaving `50%` out would
// make the circle form invisible to the gate and its token decorative.
//
// FRONTIER OF THIS RULE: only `border-radius` — the shorthand and its logical
// long-hands (which ship in CSS and do not occur in this repo yet) — is
// scanned; `var(...)` is not raw and zero needs no token. The two radius
// values set from TSX inline styles today (CodeEditor.tsx's `borderRadius:
// "50%"` and its `"999px"`) are out of reach, the same measured inline-style
// gap the rhythm rule declares.
//
// LAYER 5 — MOTION SCALE (task 153ca424, part 4 of the design system): a raw
// DURATION in a transition/animation is a violation, with the SAME three outs
// and the SAME machinery as layers 2–4 — one more SD_RULES entry, its own
// baseline section, the same pin/ratchet and the same audited escape. Nothing
// was re-implemented.
//
// THE TRAPS OF THIS DOMAIN, named — the first one is the whole design:
//   - TWO WORLDS that must not be mixed. FINITE (interaction: hovers, focus,
//     enter/leave) is what a ruler governs — --duration-1..4. INFINITE
//     (continuous feedback: the mic breathing at 1.1s, a spin at 0.7s, the
//     activity sweep at 2.4s, the twinkle at 4s) does NOT: each is the reason
//     of a single thing, and a step with one user is dead weight. Those declare
//     an escape with their own reason on the line.
//   - `delay` is NOT scanned, by design. It is a PHASE OFFSET and often
//     arithmetic: the thinking dots' 0.15s/0.3s stagger is n×0.15, so snapping
//     it to a duration step would break the arithmetic it exists to express.
//     Only the FIRST time value of each comma-separated part counts.
//   - `easing` is NOT scanned, by design. Exactly one curve in this repo is not
//     a browser keyword (the rail's cubic-bezier, which has its own token); the
//     rest are canonical and drift-free — a gate that complains without a token
//     to migrate to is the warning that never becomes an error.
//   - `prefers-reduced-motion` is part of the contract, and the answer is NOT
//     "duration: 0". Under reduce the declaration does not exist, and the app
//     RELIES on that: no `animationend` fires, which is why the card close
//     schedules a setTimeout fallback. Tokens live inside the blocks; a reduce
//     block's `none` is not a scale value and never a violation.
// FRONTIER OF THIS RULE — CLOSED in task 0f96fbda, and this is where the hole
// was found. A comma-separated `transition` is exactly the shape the formatter
// breaks across lines, so this rule was the one the old line-based parse could
// not see: 33 → 36 declarations, +13 items, in MediaCard (1 → 2) and layout.css
// (15 → 17). Reading whole declarations (see SCAN LIMITS above) closed it, and
// with it went the exception this task left behind: the `.reflow` line in
// animations.css was held on ONE line on purpose, because wrapping it would
// have hidden it from the gate. That is debt, not design — a rule that forces
// CSS to be written against the formatter. It is formatted normally again.
// OUT OF REACH BY CONSTRUCTION: motion defined in JS — the connector pulse
// (App.tsx's `CONNECTOR_PULSE_DURATION_MS = 2400` through WAAPI, mirroring the
// CSS sweeps' 2.4s), the card-close fallback `setTimeout(…, 180)` against the
// CSS `popout 0.16s`, and the ConstellationBg canvas requestAnimationFrame loop.
//
// What is deliberately NOT checked here: coordinates (top/right/bottom/
// left/inset) are layout GEOMETRY, not rhythm — the precedent is
// --titlebar-h — and a spacing token on a positional offset would be a
// type error. border/width/height are other concerns, font-size belongs to
// the typography rule, border-radius to the radius one and durations to the
// motion one (see docs/SYSTEM_DESIGN.md §9 for the measured data). Inline
// styles in TSX are a known, measured gap (5 rhythm + 2 radius occurrences
// today; motion reaches JS by another road, named above) — the rule structure
// extends to them when needed.
//
// GENERALIZATION: proved four times. Each new domain was one more SD_RULES
// entry with its own baseline section, and NONE of them touched
// updateBaseline, checkAgainstBaseline or the escape marker.

// LAYER 6 — COLOR (task 16a6abb5, part 6 of the design system): a raw color
// LITERAL in a color property is a violation, with the SAME three outs and the
// SAME machinery as layers 2–5 — one more SD_RULES entry, its own baseline
// section, the same pin/ratchet/escape. Nothing was re-implemented.
//
// THE FIRST CUT OF THIS DOMAIN IS THE BIGGEST, and it came first for a reason:
// DERIVATION IS NOT A RAW COLOR. The repo derives with `color-mix(in srgb,
// var(--token) N%, transparent)` 68 times and EVERY ONE mixes a token — zero mix
// a literal. A rule that read composition as raw color would have been born with
// 73 false positives (those 68 plus 5 `rgba()` written by hand with a token's
// value) that nobody could satisfy. So `raw` strips `var()` and `color-mix()`
// first, and what survives is what a human typed.
//
// THE PROPERTY LIST IS RESTRICTED, and the measurement is why: the first count
// of raw colors in this repo found 93 literals and **61 of them were the `white`
// of `white-space: nowrap`** — the single LARGEST bucket, and not a color at
// all. A rule that read every property would have spent its life policing
// layout values. Only properties that can carry a color are read.
//
// WHAT IS LEFT RAW IS LEGITIMATE, and that is the finding, not a gap: shadow
// (`rgba(0,0,0,α)`), overlay, a document's own white (the browser canvas, the
// QR paper), the diff syntax and one translucent panel. Those are roles §5.4
// documents and the baseline FREEZES them rather than migrating — freezing is
// the honest admission that a legitimate literal exists, the same posture as
// spacing's 1px and motion's continuous feedback. So: NO new color token came
// out of this part. What exists covers the use, every color token has users,
// and a scale invented here would have been dead weight.
//
// ONE EXCLUSION THAT MUST NOT BE "FIXED" LATER: the `rgba(20,20,24,0.78)` of
// MediaCard's toolbar sits on a `backdrop-filter` surface, which docs/PERF.md §5
// lists as a VRAM hypothesis. Migrating THAT color is a COMPOSITION change, not
// an organization one, and needs live verification — it stays raw on purpose,
// and the inline comment next to it says so.
//
// ORDER OF ADOPTION, learned the hard way in part 3: SEED THE SECTION BEFORE
// MIGRATING. A brand-new rule's section pins nothing on its own — the migrated
// file reports zero, never enters perFile, and was never listed, so
// `--update-baseline` has no key to write the explicit 0 into. The pin only
// lands for a file the section already listed. So: add the rule, run
// `--update-baseline` to freeze the PRE-migration counts, then migrate, then
// run it again — and the migrated file comes back as an explicit 0.
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

/** The `--radius-*` scale governs `border-radius` — the shorthand plus the four
 * logical long-hands CSS ships (`border-start-start-radius` …). None of the
 * long-hands occurs in this repo today; listing them closes the gap before it
 * opens, the same way RHYTHM_PROP_RE lists its suffixes. */
const RADIUS_PROP_RE = /^border-radius$|^border-(start-start|start-end|end-start|end-end)-radius$/;

/** The `--duration-*` scale governs a TRANSITION or ANIMATION declaration, and
 * only through its duration: the shorthands plus the `-duration` long-hands.
 * `-delay` and `-timing-function` are out by design — see the LAYER 5 header. */
const MOTION_PROP_RE = /^(transition|animation)(-duration)?$/;

/** The properties that can carry a COLOR. The list is restricted ON PURPOSE,
 * and the reason is measured: the first count of raw colors in this repo found
 * 93, and **61 of them were the `white` of `white-space: nowrap`** caught by the
 * named-color pattern — the SINGLE LARGEST bucket. A rule that reads any
 * property would have been born policing layout values (task 16a6abb5, §9.6). */
const COLOR_PROP_RE =
  /^(color|background|background-color|background-image|border|border-color|border-(top|right|bottom|left|block|inline)-color|outline|outline-color|box-shadow|text-shadow|fill|stroke|caret-color|accent-color)$/;

/** Named CSS colors, minus the keywords that are NOT a color by value:
 * `transparent`, `currentColor` and `inherit` say "whatever is there", so
 * flagging them would be flagging the absence of a decision, not a value. */
const NAMED_COLOR_RE =
  /\b(?:white|black|red|blue|green|yellow|orange|purple|pink|gray|grey|silver|maroon|lime|navy|teal|aqua|olive|fuchsia|cyan|magenta|brown|gold|beige|ivory|coral|crimson|indigo|violet|tan|salmon|khaki|plum|orchid|azure|linen|snow|wheat)\b/gi;

/** Strip `var(...)` and `color-mix(...)` — including a nested one — so what is
 * left is only what was written by hand. */
function stripDerivations(value) {
  let out = value.replace(/var\([^()]*\)/gi, " ");
  let guard = 0;
  while (/color-mix\(/i.test(out) && guard++ < 20) {
    const start = out.toLowerCase().indexOf("color-mix(");
    let depth = 0;
    let end = start + "color-mix(".length;
    for (; end < out.length; end++) {
      if (out[end] === "(") depth++;
      else if (out[end] === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    out = `${out.slice(0, start)} ${out.slice(end + 1)}`;
  }
  return out;
}

/** A color is "raw" when a literal survives — hex, `rgb()`/`rgba()`,
 * `hsl()`/`hsla()`, or a named color. DERIVATION IS NOT A VIOLATION: the repo
 * has 68 `color-mix()` uses and EVERY ONE mixes a `var(--token)` (plus 5
 * `rgba()` written by hand with a token's value). Treating composition as a raw
 * color would have born this rule with 73 false positives nobody could satisfy. */
function colorRaw(value) {
  const rest = stripDerivations(value);
  const out = [];
  for (const m of rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push(m[0]);
  for (const m of rest.matchAll(/\b(?:rgba?|hsla?)\([^)]*\)/gi)) out.push(m[0]);
  NAMED_COLOR_RE.lastIndex = 0;
  for (const m of rest.matchAll(NAMED_COLOR_RE)) out.push(m[0]);
  return out;
}

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

/** A radius is "raw" when it is a non-zero px value OR the bare `50%`. The
 * percentage is policed on purpose: `50%` IS the circle form, and a rule that
 * ignored it would leave the form invisible to the gate while --radius-circle
 * sat decorative. `var(...)` and zero are not raw. */
function radiusRaw(value) {
  const out = pxInstances(value);
  if (/(^|\s)50%(\s|$)/.test(value)) out.push("50%");
  return out;
}

/** Split a shorthand value on TOP-LEVEL commas only — parens hold no comma in
 * practice, but `cubic-bezier(0.16, 1, 0.3, 1)` proves they can. */
function topLevelParts(value) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** A motion value is "raw" when the FIRST time value of a comma part is a
 * non-zero literal — that first time IS the duration. The second one is the
 * DELAY, and it is not flagged on purpose: a delay is a phase offset and often
 * arithmetic (the thinking dots' 0.15s/0.3s stagger is n×0.15), so snapping it
 * to a duration step would break the arithmetic it exists to express. */
const TIME_RE = /(-?\d*\.?\d+)(ms|s)\b/gi;
function durationRaw(value) {
  const out = [];
  for (const part of topLevelParts(value)) {
    TIME_RE.lastIndex = 0;
    const m = TIME_RE.exec(part);
    if (!m || Number(m[1]) === 0) continue;
    out.push(`${m[1]}${m[2]}`);
  }
  return out;
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
  {
    id: "radius",
    description:
      "raw px (or 50%) border-radius — use --radius-1..5 / --radius-pill / --radius-circle (docs/SYSTEM_DESIGN.md §1.7)",
    propRe: RADIUS_PROP_RE,
    raw: radiusRaw,
    tokenFamily: "--radius-*",
    noun: "with a raw radius value",
  },
  {
    id: "motion",
    description:
      "raw duration in transition/animation — use --duration-1..4 (docs/SYSTEM_DESIGN.md §1.8); continuous feedback (infinite) declares /* sd:allow: reason */",
    propRe: MOTION_PROP_RE,
    raw: durationRaw,
    tokenFamily: "--duration-*",
    noun: "with a raw duration",
  },
  {
    id: "color",
    description:
      "raw color literal in a color property — use a token (docs/SYSTEM_DESIGN.md §5.4) or derive with color-mix(in srgb, var(--token) N%, transparent)",
    propRe: COLOR_PROP_RE,
    raw: colorRaw,
    tokenFamily: "a color token",
    noun: "with a raw color literal",
  },
];

const RULE_SPACING = SD_RULES[0];
const RULE_TYPOGRAPHY = SD_RULES[1];
const RULE_RADIUS = SD_RULES[2];
const RULE_MOTION = SD_RULES[3];
const RULE_COLOR = SD_RULES[4];

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

/** Blank out comments, keeping every offset and every newline in place. The
 * escape markers live INSIDE comments, so the declaration search runs on this
 * blanked text while the marker itself is still read from the RAW line. It also
 * retires the old per-line heuristic ("a line starting with `*` is comment
 * chrome"), which flagged a commented-out declaration whenever the comment's
 * lines happened not to start with `*`. */
function blankComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j++) out += src[j] === "\n" ? "\n" : " ";
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/** ONE declaration, read WHOLE: `prop: value;`, the value allowed to span
 * lines. The lookbehind anchors the property to a declaration start (`;`, `{`,
 * `}` or the very beginning of the file), so a selector like `a:hover` is never
 * read as a declaration. A declaration with no terminating `;` is still out of
 * reach — that is the one scan limit this parser keeps. */
const DECL_RE = /(?<=^|[;{}])\s*([a-zA-Z-]+)\s*:\s*([^;{}]*);/g;

/**
 * Pure: one SD rule's verdict for one CSS source.
 *
 * Reads the DECLARATION, not the line (task 0f96fbda). A value broken across
 * lines used to be invisible — neither a violation nor frozen — and that shape
 * is exactly what this repo's own formatter produces for a comma-separated
 * `transition` (see the FRONTIER note in the header for why the old
 * justification was backwards). Reading whole declarations also closes two
 * smaller limits the header used to declare: a SECOND declaration on the same
 * line is now attributed, and a line that merely starts with `*` no longer
 * blacklists whatever follows it.
 *
 * The escape marker is looked up on the line where the declaration ENDS (its
 * `;`) — for a single-line declaration, which is nearly all of them, that is
 * the same line as before.
 *
 * Returns { violations, escapes }: an escape is NOT a violation; it is
 * returned so every report prints it. A bare `sd:allow` without a reason
 * comes back as a violation of its own.
 */
export function scanRuleSource(src, rule) {
  const violations = [];
  const escapes = [];
  const blanked = blankComments(src);
  const lines = src.split("\n");
  DECL_RE.lastIndex = 0;
  let match;
  while ((match = DECL_RE.exec(blanked))) {
    const prop = match[1].toLowerCase();
    if (!rule.propRe.test(prop)) continue;
    const value = match[2].replace(/\s+/g, " ").trim();
    const instances = rule.raw(value);
    if (instances.length === 0) continue;
    // The line of the PROPERTY, not of the boundary character the lookbehind
    // matched — that is the line a human opens.
    const start = match.index + (match[0].length - match[0].replace(/^\s*/, "").length);
    const line = blanked.slice(0, start).split("\n").length;
    const endLine = blanked.slice(0, match.index + match[0].length).split("\n").length;
    const markerText = lines[endLine - 1] ?? "";
    const escape = markerText.match(ESCAPE_RE);
    if (escape) {
      // A blank reason (`/* sd:allow: */`, spaces/tabs) is NOT an escape —
      // the back door the module claims to refuse does not open with a
      // space. Falls through as a violation of its own.
      if (!escape[1].trim()) {
        violations.push({
          line,
          property: prop,
          values: instances,
          reason: "sd:allow with an empty reason — say WHY on the marker or remove it",
        });
        continue;
      }
      escapes.push({ line: endLine, property: prop, reason: escape[1] });
      continue;
    }
    if (ESCAPE_BARE_RE.test(markerText)) {
      violations.push({
        line,
        property: prop,
        values: instances,
        reason: 'sd:allow without a reason — an escape must say WHY: /* sd:allow: <reason> */',
      });
      continue;
    }
    violations.push({ line, property: prop, values: instances });
  }
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
export function scanRadiusSource(src) {
  return scanRuleSource(src, RULE_RADIUS);
}
export function scanMotionSource(src) {
  return scanRuleSource(src, RULE_MOTION);
}
export function scanColorSource(src) {
  return scanRuleSource(src, RULE_COLOR);
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
export function scanRadiusRule(root = PROJECT_ROOT) {
  return scanRule(root, RULE_RADIUS);
}
export function scanMotionRule(root = PROJECT_ROOT) {
  return scanRule(root, RULE_MOTION);
}
export function scanColorRule(root = PROJECT_ROOT) {
  return scanRule(root, RULE_COLOR);
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
          message: `a raw value in a file with no frozen baseline — new code uses ${family} (or declares /* sd:allow: reason */)`,
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
      "Frozen violation counts per design-token rule (tasks d200c269 spacing, c8cd45fc typography, 325d6c66 radius, 153ca424 motion, 16a6abb5 color). A file NOT listed here must be at ZERO — new code uses the rule's token family (--space-*, --text-*, --radius-*, --duration-*, a color token; for color, DERIVATION IS NOT A LITERAL: color-mix(in srgb, var(--token) N%, transparent) is the sanctioned way to tint, and raw is only what a human typed by hand). A listed file may not GROW. After migrating a slice, run `node scripts/verify/check-design-tokens.mjs --update-baseline` to freeze the new (lower) count; a file that reached 0 is PINNED clean — its entry stays at an explicit 0 and any raw value that reappears fails the check. Escapes: /* sd:allow: <reason> */ — audited in every run.",
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

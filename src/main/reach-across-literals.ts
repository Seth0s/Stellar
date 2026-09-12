/**
 * Cross-repo literal join (DESIGN-BACKLOG.md §3.0, fatia 2).
 *
 * No symbol crosses a repository boundary. What crosses is a literal
 * written on both sides — the Laravel route written again in the client.
 * The join is a match of the *normalized* form, over the trees named by
 * `ai/workspace.yaml`. Ordering is by specificity: a long path shared
 * across two trees is a strong signal; `status` matching two payloads
 * is noise. Mechanical, never curated per repository.
 *
 * A declared contract, where one exists, is a confidence reinforcement
 * and never a prerequisite. The tool has to work on a repository with
 * no documentation at all.
 *
 * Derived on the dirty trees, discarded after the call. No graph, no
 * card, no persisted index, no HEAD cache, no new column.
 *
 * AGENT-FACING — DO NOT TRANSLATE. Status token `sem_referencia` is
 * specified as-is. See `src/shared/i18n/agent-facing.ts`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { confine, MAX_FILE_BYTES, PathEscapeError } from "./fs-tools";
import {
  hitCapFor,
  PREVIEW_MAX,
  REACH_BINARY_EXTS,
  REACH_IGNORE_DIR_NAMES,
  type Hunk,
  type ReachIncompleteness,
  type ReachStatus,
} from "./reach-from-hunks";
import {
  loadCatalogFromCwd,
  type CatalogProject,
  type WorkspaceCatalog,
} from "./workspace-catalog";

export type AcrossLiteralSeed = {
  text: string;
  normalized: string;
  fromFile: string;
  fromSides: Array<"added" | "removed">;
};

export type AcrossJoin = {
  file: string;
  line: number;
  preview: string;
  project: string;
  seed: string;
  normalized: string;
  specificity: number;
  staticSegments: number;
  seedSides: Array<"added" | "removed">;
  contractReinforced: boolean;
};

export type AcrossResult = {
  status: ReachStatus;
  joins: AcrossJoin[];
  scanned: {
    catalogPath: string;
    workspaceRoot: string;
    projects: Array<{ id: string; path: string }>;
    filesScanned: number;
    fileCapHit: boolean;
    seeds: AcrossLiteralSeed[];
    elapsedMs: number;
  };
  incompleteness: ReachIncompleteness[];
};

const IGNORE_DIR_NAMES = new Set([
  ...REACH_IGNORE_DIR_NAMES,
  "vendor",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  "graphify-out",
  "storage",
  ".turbo",
  ".nuxt",
  ".hermes",
  ".claude",
  ".cursor",
]);

const BINARY_EXTS = REACH_BINARY_EXTS;
const SKIP_EXTS = new Set([".lock", ".map", ".min.js"]);

/** Per-project walk cap. Same order of magnitude as the intra-repo scan. */
export const MAX_FILES_PER_PROJECT = 8_000;
export const MAX_JOINS_RETURNED = 200;

const WILDCARD = "{_}";

const QUOTED_RE = /(["'])(?:\\.|(?!\1)[^\\])*?\1|`(?:\\.|[^`\\])*?`/g;
const PATH_TOKEN_RE = /\/[A-Za-z0-9._{}$-][A-Za-z0-9._/{}$-]{2,}/g;

const ALWAYS_INCOMPLETENESS: ReachIncompleteness[] = [
  {
    what: "concatenated URL",
    why:
      "A URL built by concatenation or interpolation that never appears as one literal is a false negative — the join cannot reconstruct the runtime string. Typical shape: a helper that returns a prefix (`planPath(id)`) plus a suffix (`/coverage/reconcile`), or `\"/plans/\" . $id . \"/ready\"`. Those fragments may still match if a distinctive suffix remains; the full path does not.",
  },
  {
    what: "generic field name",
    why:
      "A short literal such as `status` or `name` matches between unrelated payloads. Specificity ranking puts those below a long path, but they are still false positives when they survive the frequency cap. A list of joins is not a claim that every hit is a consumer of the same contract.",
  },
  {
    what: "resolution method",
    why:
      "Normalized literal match over the dirty trees named by ai/workspace.yaml, not a compiler and not a reader of a hand-written matrix. Symbols are not joined across repositories. Declared contracts, when present, only raise confidence on an already-found join — they are never required. Read incompleteness before acting.",
  },
];

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function stripDiffPrefix(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "";
  if (line.startsWith("+") || line.startsWith("-")) return line.slice(1);
  return line;
}

function unescapeQuoted(raw: string): string {
  const quote = raw[0];
  const inner = raw.slice(1, -1);
  if (quote === "`") return inner;
  return inner.replace(/\\([\\'"nrt])/g, (_, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return ch;
  });
}

function lineHasUnresolvedConstruction(line: string): string | null {
  if (line.includes("${")) return "template interpolation (${...})";
  if (/["'`][^"'`\n]{0,80}["'`]\s*\+/.test(line) || /\+\s*["'`]/.test(line)) return "string concatenation";
  if (/["'][^"'\n]{0,80}["']\s*\./.test(line) || /\.\s*["']/.test(line)) return "string concatenation";
  return null;
}

/**
 * Collapse the ways two sides write the same path into one key:
 * `{plan}`, `${planId}`, `{$planId}`, `:plan` → `{_}`; query strings
 * dropped; case folded. Not a parser of every language — just the
 * shapes that actually show up on both sides of an HTTP contract.
 */
export function normalizeLiteral(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith("/") && s.includes(" ")) || /^(get|post|put|patch|delete)\s+\//i.test(s)) {
    s = s.replace(/^(get|post|put|patch|delete)\s+/i, "");
  }
  s = s.toLowerCase();
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\$\{[^}]*\}/g, WILDCARD);
  s = s.replace(/\{\$[a-zA-Z_][a-zA-Z0-9_>-]*\}/g, WILDCARD);
  s = s.replace(/\{[a-zA-Z_][a-zA-Z0-9_?]*\}/g, WILDCARD);
  s = s.replace(/(^|\/):[a-zA-Z_][a-zA-Z0-9_]*/g, `$1${WILDCARD}`);
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

export function literalSegments(normalized: string): string[] {
  return normalized.split("/").filter((s) => s.length > 0);
}

export type LiteralJoinHit = {
  shared: string;
  staticSegments: number;
  length: number;
};

/**
 * Two normalized literals join when they are equal, or when the shorter
 * path is a *suffix* of the longer one. `{_}` matches one segment. A
 * join needs at least one exact static segment — a wildcard-only suffix
 * like `{_}/{_}` is not a signal (that is how `DIR="${X}/${Y}"` used to
 * light up every `/plans/{plan}/…` seed).
 */
export function joinNormalized(a: string, b: string): LiteralJoinHit | null {
  if (!a || !b) return null;
  if (a === b) {
    const segs = literalSegments(a);
    const staticSegments = segs.filter((s) => s !== WILDCARD).length;
    return { shared: a, staticSegments, length: a.length };
  }
  const pathLike = a.includes("/") || b.includes("/");
  if (!pathLike) return null;

  const sa = literalSegments(a);
  const sb = literalSegments(b);
  if (sa.length === 0 || sb.length === 0) return null;
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  const start = long.length - short.length;
  let exactStatic = 0;
  for (let i = 0; i < short.length; i++) {
    const x = short[i];
    const y = long[start + i];
    if (x === WILDCARD || y === WILDCARD) continue;
    if (x !== y) return null;
    exactStatic++;
  }
  if (exactStatic < 1) return null;
  const sharedSegs = long.slice(start);
  return {
    shared: `/${sharedSegs.join("/")}`,
    staticSegments: exactStatic,
    length: sharedSegs.join("/").length + 1,
  };
}

export function specificityOf(normalized: string): number {
  const segs = literalSegments(normalized);
  const staticSegs = segs.filter((s) => s !== WILDCARD).length;
  const pathBonus = normalized.includes("/") ? 20 : 0;
  return staticSegs * 40 + normalized.length + pathBonus;
}

function extractQuotedValues(line: string): string[] {
  const out: string[] = [];
  QUOTED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTED_RE.exec(line)) !== null) {
    out.push(unescapeQuoted(m[0]));
  }
  return out;
}

function extractPathTokens(line: string): string[] {
  const withoutStrings = line.replace(QUOTED_RE, " ");
  const out: string[] = [];
  PATH_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TOKEN_RE.exec(withoutStrings)) !== null) {
    out.push(m[0]);
  }
  return out;
}

function looksUsefulLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  return true;
}

export function extractLiteralSeedsFromHunks(hunks: Hunk[]): {
  seeds: AcrossLiteralSeed[];
  incompleteness: ReachIncompleteness[];
} {
  const byNorm = new Map<string, AcrossLiteralSeed>();
  const incompleteness: ReachIncompleteness[] = [];
  const seenDynamic = new Set<string>();

  for (const hunk of hunks) {
    const fromFile = toPosix(hunk.file || "").replace(/^\.\//, "");
    const sides: Array<"added" | "removed"> = ["removed", "added"];
    for (const side of sides) {
      const lines = side === "added" ? hunk.added : hunk.removed;
      if (!lines) continue;
      for (const raw of lines) {
        const line = stripDiffPrefix(raw);
        if (!line.trim()) continue;
        const dynamic = lineHasUnresolvedConstruction(line);
        if (dynamic) {
          const dynKey = `${fromFile}:${dynamic}:${line.trim().slice(0, 80)}`;
          if (!seenDynamic.has(dynKey)) {
            seenDynamic.add(dynKey);
            incompleteness.push({
              what: `unresolved construction in ${fromFile || "(unknown file)"} (${side})`,
              why: `Hunk line uses ${dynamic}; a consumer that only sees the built string will be missed if no distinctive fragment remains.`,
            });
          }
        }
        const values = [...extractQuotedValues(line), ...extractPathTokens(line)];
        for (const value of values) {
          if (!looksUsefulLiteral(value)) continue;
          const normalized = normalizeLiteral(value);
          if (!normalized || normalized.length < 3) continue;
          const existing = byNorm.get(normalized);
          if (existing) {
            if (!existing.fromSides.includes(side)) existing.fromSides.push(side);
          } else {
            byNorm.set(normalized, { text: value, normalized, fromFile, fromSides: [side] });
          }
        }
      }
    }
  }

  return { seeds: [...byNorm.values()], incompleteness };
}

function isContractPath(rel: string, project: CatalogProject): boolean {
  const posix = toPosix(rel).toLowerCase();
  if (posix.includes("/docs/contracts/") || posix.startsWith("docs/contracts/")) return true;
  if (/(^|\/)contracts?\.md$/.test(posix)) return true;
  for (const src of project.canonicalSources) {
    const needle = toPosix(src).replace(/^\.\//, "").toLowerCase();
    if (!needle) continue;
    if (posix === needle || posix.startsWith(`${needle.replace(/\/+$/, "")}/`) || posix.endsWith(needle)) {
      if (posix.endsWith(".md") || posix.endsWith(".mdx")) return true;
    }
  }
  return false;
}

function skipProducerFile(rel: string, seedFromFile: string): boolean {
  if (!seedFromFile) return false;
  const a = toPosix(rel).replace(/^\.\//, "");
  const b = seedFromFile.replace(/^\.\//, "");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

type PreparedSeed = AcrossLiteralSeed & { spec: number };

async function walkProject(
  project: CatalogProject,
  seeds: PreparedSeed[],
): Promise<{
  filesScanned: number;
  fileCapHit: boolean;
  codeHits: AcrossJoin[];
  contractNorms: Set<string>;
  overflowed: Set<string>;
}> {
  let codeHits: AcrossJoin[] = [];
  const contractNorms = new Set<string>();
  const overflowed = new Set<string>();
  const counts = new Map<string, number>();
  let filesScanned = 0;
  let fileCapHit = false;
  let rootReal: string;
  try {
    rootReal = confine(project.absPath, "");
  } catch {
    return { filesScanned: 0, fileCapHit: false, codeHits: [], contractNorms, overflowed };
  }

  async function visit(absDir: string): Promise<void> {
    if (fileCapHit) return;
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (fileCapHit) return;
      if (entry.isDirectory()) {
        if (IGNORE_DIR_NAMES.has(entry.name)) continue;
        await visit(join(absDir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext) || SKIP_EXTS.has(ext)) continue;
      if (entry.name.endsWith(".min.js")) continue;
      if (filesScanned >= MAX_FILES_PER_PROJECT) {
        fileCapHit = true;
        return;
      }
      const abs = join(absDir, entry.name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      const text = await readFile(abs, "utf8").catch(() => null);
      if (text === null) continue;
      if (text.includes("\0")) continue;
      filesScanned++;
      const rel = toPosix(relative(rootReal, abs));
      const contract = isContractPath(rel, project);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const values = [...extractQuotedValues(line), ...extractPathTokens(line)];
        if (values.length === 0) continue;
        for (const seed of seeds) {
          if (overflowed.has(seed.normalized)) continue;
          if (skipProducerFile(rel, seed.fromFile)) continue;
          let hit: LiteralJoinHit | null = null;
          for (const value of values) {
            if (!looksUsefulLiteral(value)) continue;
            const joined = joinNormalized(seed.normalized, normalizeLiteral(value));
            if (!joined) continue;
            if (!hit || joined.staticSegments > hit.staticSegments || (joined.staticSegments === hit.staticSegments && joined.length > hit.length)) {
              hit = joined;
            }
          }
          if (!hit) continue;
          if (contract) {
            contractNorms.add(seed.normalized);
            continue;
          }
          const n = (counts.get(seed.normalized) ?? 0) + 1;
          counts.set(seed.normalized, n);
          const cap = hitCapFor({ text: seed.text, kind: "literal" });
          if (n > cap) {
            overflowed.add(seed.normalized);
            codeHits = codeHits.filter((h) => h.normalized !== seed.normalized);
            continue;
          }
          codeHits.push({
            file: `${project.path}/${rel}`,
            line: i + 1,
            preview: line.trim().slice(0, PREVIEW_MAX),
            project: project.id,
            seed: seed.text,
            normalized: seed.normalized,
            specificity: seed.spec,
            staticSegments: hit.staticSegments,
            seedSides: seed.fromSides,
            contractReinforced: false,
          });
        }
      }
    }
  }

  await visit(rootReal);
  return { filesScanned, fileCapHit, codeHits, contractNorms, overflowed };
}

function decideStatus(joins: AcrossJoin[]): ReachStatus {
  return joins.length === 0 ? "sem_referencia" : "evidencia";
}

export async function reachAcrossLiterals(input: {
  cwd: string;
  hunks: Hunk[];
  catalogPath?: string;
  /** Override of MAX_JOINS_RETURNED — used by the gabarito measurement. */
  maxJoins?: number;
}): Promise<AcrossResult> {
  const started = Date.now();
  const incompleteness: ReachIncompleteness[] = [];
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const hunks = input.hunks ?? [];

  const extracted = extractLiteralSeedsFromHunks(hunks);
  incompleteness.push(...extracted.incompleteness);

  if (hunks.length === 0) {
    incompleteness.push({
      what: "input hunks",
      why: "No hunks were given, so nothing was seeded. An empty join list is not a claim that nothing is affected.",
    });
  }

  if (extracted.seeds.length === 0 && hunks.length > 0) {
    incompleteness.push({
      what: "seed extraction",
      why: "Hunk lines produced no literal this scan treats as searchable. Symbols are not joined across repositories — if the hunk only touched identifiers, this result being empty is expected, not proof that no client is affected.",
    });
  }

  let catalog: WorkspaceCatalog | null = null;
  let filesScanned = 0;
  let fileCapHit = false;
  const joins: AcrossJoin[] = [];

  if (!cwd) {
    incompleteness.push({
      what: "repository root",
      why: "cwd is missing or empty; the catalog was not loaded and no tree was walked.",
    });
  } else {
    try {
      confine(cwd, "");
    } catch (err) {
      incompleteness.push({
        what: "repository root",
        why: err instanceof PathEscapeError ? `cwd escaped confinement: ${err.message}` : `could not open cwd "${cwd}".`,
      });
    }
  }

  if (cwd) {
    const loaded = await loadCatalogFromCwd(cwd, input.catalogPath);
    if ("error" in loaded) {
      incompleteness.push({ what: "workspace catalog", why: loaded.error });
    } else {
      catalog = loaded;
      if (loaded.missing.length > 0) {
        incompleteness.push({
          what: "catalog paths",
          why: `Catalog entries whose path is missing on disk were skipped (deriva, not a join rule): ${loaded.missing.map((m) => `${m.id} (${m.path})`).join(", ")}.`,
        });
      }
      if (loaded.projects.length === 0) {
        incompleteness.push({
          what: "workspace catalog",
          why: "Catalog loaded but no project directory exists on disk. Nothing was walked.",
        });
      } else if (extracted.seeds.length > 0) {
        const prepared: PreparedSeed[] = extracted.seeds.map((s) => ({ ...s, spec: specificityOf(s.normalized) }));
        const overflowed = new Set<string>();
        const contractNorms = new Set<string>();
        for (const project of loaded.projects) {
          const walk = await walkProject(project, prepared);
          filesScanned += walk.filesScanned;
          if (walk.fileCapHit) {
            fileCapHit = true;
            incompleteness.push({
              what: `scan cap (${project.id})`,
              why: `Stopped after ${MAX_FILES_PER_PROJECT} files in ${project.path}. Later files in that tree were not read.`,
            });
          }
          for (const n of walk.contractNorms) contractNorms.add(n);
          for (const n of walk.overflowed) overflowed.add(n);
          joins.push(...walk.codeHits);
        }
        for (const seed of extracted.seeds) {
          if (overflowed.has(seed.normalized)) {
            incompleteness.push({
              what: `seed "${seed.text}"`,
              why: `Occurred more than ${hitCapFor({ text: seed.text, kind: "literal" })} times across the catalog trees, so further hits of this literal were dropped. Frequency is a mechanical gate, not a proof that the token is irrelevant.`,
            });
          }
        }
        for (const j of joins) {
          if (contractNorms.has(j.normalized)) j.contractReinforced = true;
        }
      }
    }
  }

  joins.sort(
    (a, b) =>
      b.specificity - a.specificity ||
      b.staticSegments - a.staticSegments ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const cap = input.maxJoins ?? MAX_JOINS_RETURNED;
  if (joins.length > cap) {
    incompleteness.push({
      what: "result cap",
      why: `Kept the ${cap} most specific joins of ${joins.length}. Lower-specificity hits (short / generic literals) were dropped from the payload, not declared irrelevant.`,
    });
    joins.length = cap;
  }

  incompleteness.push(...ALWAYS_INCOMPLETENESS);

  return {
    status: decideStatus(joins),
    joins,
    scanned: {
      catalogPath: catalog ? toPosix(catalog.catalogPath) : "",
      workspaceRoot: catalog ? toPosix(catalog.workspaceRoot) : "",
      projects: catalog ? catalog.projects.map((p) => ({ id: p.id, path: p.path })) : [],
      filesScanned,
      fileCapHit,
      seeds: extracted.seeds,
      elapsedMs: Date.now() - started,
    },
    incompleteness,
  };
}

export { decideStatus };

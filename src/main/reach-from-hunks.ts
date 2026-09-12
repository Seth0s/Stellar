/**
 * Intra-repo reach from diff hunks (DESIGN-BACKLOG.md §3.0, fatia 1).
 *
 * Derived on the dirty tree, discarded after the call. No graph, no card,
 * no persisted index, no HEAD cache, no new column. The seed is the hunk
 * text — never the file the hunk lives in.
 *
 * AGENT-FACING — DO NOT TRANSLATE. Status token `sem_referencia` is
 * specified as-is; every other string here is English for the model
 * that reads the tool result. See `src/shared/i18n/agent-facing.ts`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { confine, MAX_FILE_BYTES, PathEscapeError } from "./fs-tools";

export type Hunk = {
  file: string;
  added?: string[];
  removed?: string[];
};

export type ReachSeed = {
  text: string;
  kind: "symbol" | "literal";
  fromFile: string;
  fromSides: Array<"added" | "removed">;
};

export type ReachEvidence = {
  file: string;
  line: number;
  preview: string;
  seed: string;
  seedKind: "symbol" | "literal";
  seedSides: Array<"added" | "removed">;
};

export type ReachIncompleteness = {
  what: string;
  why: string;
};

export type ReachStatus = "evidencia" | "sem_referencia";

export type ReachResult = {
  status: ReachStatus;
  evidence: ReachEvidence[];
  scanned: {
    root: string;
    filesScanned: number;
    fileCapHit: boolean;
    seeds: ReachSeed[];
    elapsedMs: number;
  };
  incompleteness: ReachIncompleteness[];
};

/** Same names file-watcher prunes. Local copy so this module does not
 * import Electron (file-watcher.ts pulls `BrowserWindow`). Exported so
 * the cross-repo walker reuses the same prune set instead of drifting. */
export const REACH_IGNORE_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  ".verify-tmp",
  "build",
  "out",
  ".cache",
]);

const IGNORE_DIR_NAMES = REACH_IGNORE_DIR_NAMES;

export const REACH_BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".mp3",
  ".mp4",
  ".mov",
  ".class",
  ".o",
]);

const BINARY_EXTS = REACH_BINARY_EXTS;

export const MAX_FILES_SCANNED = 8_000;
export const MAX_HITS_PER_SEED = 40;
export const PREVIEW_MAX = 160;

/** Mechanical specificity gate — longer / path-like seeds keep more hits
 * before being treated as too common. Not a denylist. */
export function hitCapFor(seed: { text: string; kind: "symbol" | "literal" }): number {
  const n = seed.text.length;
  if (seed.kind === "literal" && (seed.text.includes("/") || n >= 12)) return 400;
  if (n >= 12) return 300;
  if (n >= 8) return 200;
  if (n >= 5) return 80;
  return MAX_HITS_PER_SEED;
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const STRING_RE = /(["'])(?:\\.|(?!\1)[^\\])*?\1|`(?:\\.|[^`\\])*?`/g;
const PATH_TOKEN_RE = /\/[A-Za-z0-9._{}-][A-Za-z0-9._/{}\-]{2,}/g;

const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "function",
  "const",
  "let",
  "var",
  "class",
  "interface",
  "type",
  "enum",
  "export",
  "import",
  "from",
  "default",
  "new",
  "this",
  "super",
  "try",
  "catch",
  "finally",
  "throw",
  "async",
  "await",
  "yield",
  "typeof",
  "instanceof",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "as",
  "is",
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "abstract",
  "implements",
  "extends",
  "package",
  "with",
  "debugger",
  "delete",
  "constructor",
  "module",
  "require",
  "namespace",
  "declare",
  "satisfies",
  "infer",
  "keyof",
  "never",
  "unknown",
  "any",
  "unique",
  "asserts",
  "of",
  "in",
  "get",
  "set",
  "def",
  "elif",
  "lambda",
  "pass",
  "raise",
  "except",
  "and",
  "or",
  "not",
  "None",
  "True",
  "False",
  "self",
  "cls",
  "global",
  "nonlocal",
  "assert",
  "del",
  "func",
  "struct",
  "chan",
  "go",
  "defer",
  "select",
  "range",
  "nil",
  "fn",
  "mut",
  "pub",
  "use",
  "mod",
  "impl",
  "trait",
  "match",
  "where",
  "crate",
  "string",
  "number",
  "boolean",
  "object",
  "bigint",
  "symbol",
  "int",
  "float",
  "double",
  "bool",
  "char",
]);

const METHOD_INCOMPLETENESS: ReachIncompleteness = {
  what: "resolution method",
  why:
    "Text search over the dirty working tree, not a compiler. Aliases, re-exports, barrel files, computed property names, dynamic import()/require() with a non-literal, and strings built by concatenation or interpolation are not followed. The evidence list is not a claim that these are the affected sites — read incompleteness before acting.",
};

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
  return null;
}

function isUsefulSymbol(name: string): boolean {
  if (name.length < 3) return false;
  if (KEYWORDS.has(name)) return false;
  return true;
}

function isUsefulLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (KEYWORDS.has(trimmed)) return false;
  return true;
}

function seedKey(kind: ReachSeed["kind"], text: string): string {
  return `${kind}\0${text}`;
}

/**
 * Pull symbols and literals from hunk lines only. The hunk's filename is
 * never turned into a seed — "who consumes store.ts" is the query this
 * exists to refuse.
 */
export function extractSeedsFromHunks(hunks: Hunk[]): {
  seeds: ReachSeed[];
  incompleteness: ReachIncompleteness[];
} {
  const byKey = new Map<string, ReachSeed>();
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
              why: `Hunk line uses ${dynamic}; this scan cannot resolve the runtime value, so a consumer that only sees the built string will be missed.`,
            });
          }
        }

        STRING_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STRING_RE.exec(line)) !== null) {
          const rawLit = m[0];
          if (rawLit.startsWith("`") && rawLit.includes("${")) continue;
          const value = unescapeQuoted(rawLit);
          if (!isUsefulLiteral(value)) continue;
          const key = seedKey("literal", value);
          const existing = byKey.get(key);
          if (existing) {
            if (!existing.fromSides.includes(side)) existing.fromSides.push(side);
          } else {
            byKey.set(key, { text: value, kind: "literal", fromFile, fromSides: [side] });
          }
        }

        STRING_RE.lastIndex = 0;
        const withoutStrings = line.replace(STRING_RE, " ");
        IDENT_RE.lastIndex = 0;
        while ((m = IDENT_RE.exec(withoutStrings)) !== null) {
          const name = m[0];
          if (!isUsefulSymbol(name)) continue;
          const key = seedKey("symbol", name);
          const existing = byKey.get(key);
          if (existing) {
            if (!existing.fromSides.includes(side)) existing.fromSides.push(side);
          } else {
            byKey.set(key, { text: name, kind: "symbol", fromFile, fromSides: [side] });
          }
        }

        PATH_TOKEN_RE.lastIndex = 0;
        while ((m = PATH_TOKEN_RE.exec(withoutStrings)) !== null) {
          const value = m[0];
          if (!isUsefulLiteral(value)) continue;
          const key = seedKey("literal", value);
          const existing = byKey.get(key);
          if (existing) {
            if (!existing.fromSides.includes(side)) existing.fromSides.push(side);
          } else {
            byKey.set(key, { text: value, kind: "literal", fromFile, fromSides: [side] });
          }
        }
      }
    }
  }

  return { seeds: [...byKey.values()], incompleteness };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileSeedMatcher(seed: ReachSeed): (line: string) => boolean {
  if (seed.kind === "literal") {
    return (line) => line.includes(seed.text);
  }
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(seed.text)}(?:$|[^A-Za-z0-9_$])`);
  return (line) => re.test(line);
}

function decideStatus(evidence: ReachEvidence[]): ReachStatus {
  return evidence.length === 0 ? "sem_referencia" : "evidencia";
}

type PreparedSeed = ReachSeed & { matches: (line: string) => boolean };

async function walkAndSearch(
  rootReal: string,
  seeds: PreparedSeed[],
): Promise<{
  filesScanned: number;
  fileCapHit: boolean;
  hitsByKey: Map<string, ReachEvidence[]>;
  overflowed: Set<string>;
}> {
  const hitsByKey = new Map<string, ReachEvidence[]>();
  const overflowed = new Set<string>();
  const counts = new Map<string, number>();
  let filesScanned = 0;
  let fileCapHit = false;

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
      if (BINARY_EXTS.has(extname(entry.name).toLowerCase())) continue;
      if (filesScanned >= MAX_FILES_SCANNED) {
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
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const seed of seeds) {
          const key = seedKey(seed.kind, seed.text);
          if (overflowed.has(key)) continue;
          if (!seed.matches(line)) continue;
          const n = (counts.get(key) ?? 0) + 1;
          counts.set(key, n);
          const cap = hitCapFor(seed);
          if (n > cap) {
            overflowed.add(key);
            hitsByKey.delete(key);
            continue;
          }
          const bucket = hitsByKey.get(key) ?? [];
          bucket.push({
            file: rel,
            line: i + 1,
            preview: line.trim().slice(0, PREVIEW_MAX),
            seed: seed.text,
            seedKind: seed.kind,
            seedSides: seed.fromSides,
          });
          hitsByKey.set(key, bucket);
        }
      }
    }
  }

  await visit(rootReal);
  return { filesScanned, fileCapHit, hitsByKey, overflowed };
}

export async function reachFromHunks(input: { cwd: string; hunks: Hunk[] }): Promise<ReachResult> {
  const started = Date.now();
  const incompleteness: ReachIncompleteness[] = [];
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const hunks = input.hunks ?? [];

  const extracted = extractSeedsFromHunks(hunks);
  incompleteness.push(...extracted.incompleteness);

  if (hunks.length === 0) {
    incompleteness.push({
      what: "input hunks",
      why: "No hunks were given, so nothing was seeded. An empty evidence list is not a claim that nothing is affected.",
    });
  }

  if (extracted.seeds.length === 0 && hunks.length > 0) {
    incompleteness.push({
      what: "seed extraction",
      why: "Hunk lines produced no identifier or literal this scan treats as searchable (keywords, 1–2 character tokens, and empty/short strings are dropped). That is a gap in extraction, not proof that the change has no consumers.",
    });
  }

  let rootReal = cwd;
  let filesScanned = 0;
  let fileCapHit = false;
  const evidence: ReachEvidence[] = [];

  if (!cwd) {
    incompleteness.push({
      what: "repository root",
      why: "cwd is missing or empty; the dirty tree was not walked.",
    });
  } else {
    try {
      rootReal = confine(cwd, "");
      const st = await stat(rootReal);
      if (!st.isDirectory()) {
        incompleteness.push({
          what: "repository root",
          why: `cwd "${cwd}" is not a directory; the dirty tree was not walked.`,
        });
      } else if (extracted.seeds.length > 0) {
        const prepared: PreparedSeed[] = extracted.seeds.map((s) => ({ ...s, matches: compileSeedMatcher(s) }));
        const walk = await walkAndSearch(rootReal, prepared);
        filesScanned = walk.filesScanned;
        fileCapHit = walk.fileCapHit;
        if (walk.fileCapHit) {
          incompleteness.push({
            what: "scan cap",
            why: `Stopped after ${MAX_FILES_SCANNED} files. Later files were not read; evidence from those paths is missing.`,
          });
        }
        for (const seed of extracted.seeds) {
          const key = seedKey(seed.kind, seed.text);
          if (walk.overflowed.has(key)) {
            incompleteness.push({
              what: `seed "${seed.text}" (${seed.kind})`,
              why: `Occurred more than ${hitCapFor(seed)} times in the walked tree, so it was treated as too common to be a useful reference and none of its hits were kept. Frequency is a mechanical gate, not a proof that the token is irrelevant.`,
            });
            continue;
          }
          const hits = walk.hitsByKey.get(key);
          if (hits) evidence.push(...hits);
        }
      }
    } catch (err) {
      if (err instanceof PathEscapeError) {
        incompleteness.push({
          what: "repository root",
          why: `cwd escaped confinement: ${err.message}`,
        });
      } else {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
        incompleteness.push({
          what: "repository root",
          why:
            code === "ENOENT"
              ? `cwd "${cwd}" does not exist; the dirty tree was not walked.`
              : `could not open cwd "${cwd}"${code ? ` (${code})` : ""}.`,
        });
      }
    }
  }

  evidence.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.seed.localeCompare(b.seed));

  incompleteness.push(METHOD_INCOMPLETENESS);

  return {
    status: decideStatus(evidence),
    evidence,
    scanned: {
      root: toPosix(rootReal || cwd),
      filesScanned,
      fileCapHit,
      seeds: extracted.seeds,
      elapsedMs: Date.now() - started,
    },
    incompleteness,
  };
}

export { decideStatus };

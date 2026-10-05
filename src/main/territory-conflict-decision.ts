/**
 * Territory CONFLICT — refuse a spawn/link that would put a second EXECUTING
 * implementer over territory another ACTIVE task on the same board claims,
 * while allowing a path two implementers agree to SHARE.
 *
 * Overlap is by PREFIX of path segments, not exact glob. Measured across the
 * real board: the column mixes clean globs (`src/**`), raw paths
 * (`src/main/store.ts`), an annotation glued to the path (`store.ts (actor)`),
 * and pure prose with no path structure. An exact-glob comparator would miss
 * most of them — the same silent-accept failure this exists to close. A
 * wildcard INSIDE a segment is compared literally (a full glob engine is out of
 * scope); the mechanism is prefix overlap, not general glob intersection.
 *
 * PER-PATH MODE: an entry is `exclusive` (the default) or `shared`. A `shared`
 * entry MUST carry a coordination note; two active tasks may hold the same path
 * ONLY if BOTH declare it `shared`. `shared × exclusive` is refused — the
 * exclusive side never consented to share.
 *
 * GLOB × NEW FILE: a broad glob does not hard-block a narrower, specific target.
 * A glob collides with a concrete path only when the path MATCHES the glob AND
 * exists on disk; a glob collides with another glob only when neither contains
 * the other. Otherwise it is a WARNING that passes (a new file under a broad
 * claim), never a refusal.
 *
 * Pure apart from an INJECTED `pathExists` (I/O stays at the caller) — no
 * `git`, no filesystem watch: this module only compares what is declared plus
 * that one fact.
 */

import { posix } from "node:path";
import { normalizeStringList } from "./task-contract-decision";

export type TerritoryMode = "exclusive" | "shared";

/** One declared territory entry, split into its mode, coordination note and
 *  path, without resolving the path yet. */
export type ParsedTerritoryEntry = {
  /** The entry exactly as declared (used to name it in refusals). */
  raw: string;
  mode: TerritoryMode;
  /** The `(…)` coordination note, when present. `shared` requires one. */
  note: string | null;
  /** The path part (mode prefix and note removed). */
  path: string;
};

/**
 * Splits a raw territory string into mode / note / path. The mode prefix is
 * `shared:` (case-insensitive); anything else is `exclusive`. The note is the
 * trailing `(…)` — the same annotation `resolveTerritoryEntry` already strips.
 */
export function parseTerritoryEntry(raw: string): ParsedTerritoryEntry {
  const trimmed = raw.trim();
  const mode: TerritoryMode = /^shared:/i.test(trimmed) ? "shared" : "exclusive";
  const withoutMode = mode === "shared" ? trimmed.replace(/^shared:\s*/i, "") : trimmed;
  const noteMatch = withoutMode.match(/\s*\(([^)]*)\)\s*$/);
  const note = noteMatch ? noteMatch[1]!.trim() : null;
  const path = withoutMode.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return { raw, mode, note: note && note.length > 0 ? note : null, path };
}

/** True when the entry declares `shared` mode. */
export function isSharedTerritoryEntry(raw: string): boolean {
  return parseTerritoryEntry(raw).mode === "shared";
}

/** True when any entry of the list declares `shared` mode. */
export function territoryDeclaresShared(territory: string[] | null | undefined): boolean {
  const list = normalizeStringList(territory);
  return list !== null && list.some(isSharedTerritoryEntry);
}

export type ActiveTaskTerritory = {
  taskId: string;
  /** Declared territory, normalized from SQL. `null`/empty = undeclared — never
   *  used as evidence. */
  territory: string[] | null;
  /** Base a RELATIVE entry resolves against: the task's own `cwd`, else the
   *  board root (the caller resolves that fallback). An absolute entry ignores
   *  it. `null`/absent = no base: the relative stays relative. */
  cwd?: string | null;
};

export type TerritoryWarning = {
  conflictingTaskId: string;
  /** The entry as declared on each side. */
  mine: string;
  theirs: string;
  mineResolved: string;
  theirsResolved: string;
  /** AGENT-FACING. Says the overlap was allowed and why. */
  message: string;
};

export type TerritoryRefusal = {
  conflictingTaskId: string;
  mine: string;
  theirs: string;
  mineResolved: string;
  theirsResolved: string;
  /** AGENT-FACING refusal — same channel as every other spawn refusal. */
  error: string;
};

export type TerritoryConflictDecision =
  | {
      ok: true;
      /** Overlaps that PASSED with a warning (new/specific target under a
       *  broader claim). Empty when there is nothing to say. */
      warnings: TerritoryWarning[];
      /** Present only when the guard would have refused and the caller
       *  supplied a non-empty `override`: the refusal it bypassed, so the
       *  caller can record it on the task's trail. */
      overridden?: { reason: string; conflict: TerritoryRefusal };
    }
  | ({ ok: false } & TerritoryRefusal);

export type TerritoryConflictInput = {
  taskId: string;
  territory: string[] | null;
  /** `cwd` of the candidate (or board root). Same rule as
   *  `ActiveTaskTerritory.cwd`. */
  cwd?: string | null;
  /** Every ACTIVE task on the SAME board except the candidate (the caller
   *  already filtered by board_id and by "not the candidate"). */
  activeTasks: ActiveTaskTerritory[];
  /** Does a CONCRETE path exist on disk? Injected so this module stays pure.
   *  Absent = treated as existing (conservative: an existing file is a real
   *  conflict). Only consulted for glob × concrete pairs. */
  pathExists?: (resolvedPath: string) => boolean;
  /** Orchestrator override: a non-empty reason makes a would-be refusal pass
   *  and is returned in `overridden` for the caller to record. */
  override?: string | null;
};

/**
 * Decides whether `territory` (the candidate) collides with an ACTIVE task.
 * Absent territory on either side is not evidence — never invents a collision.
 * Each entry is RESOLVED against its own task's base before comparing.
 */
export function decideTerritoryConflict(input: TerritoryConflictInput): TerritoryConflictDecision {
  const mineList = normalizeStringList(input.territory);
  if (!mineList) return { ok: true, warnings: [] };

  const override = typeof input.override === "string" ? input.override.trim() : "";
  const warnings: TerritoryWarning[] = [];

  // A malformed `shared` (no coordination note) is refused before any compare:
  // the declaration itself is invalid, not the overlap.
  for (const raw of mineList) {
    const parsed = parseTerritoryEntry(raw);
    if (parsed.mode === "shared" && !parsed.note) {
      const refusal: TerritoryRefusal = {
        conflictingTaskId: input.taskId,
        mine: raw,
        theirs: raw,
        mineResolved: raw,
        theirsResolved: raw,
        error: describeSharedWithoutNote(raw),
      };
      if (override) return { ok: true, warnings, overridden: { reason: override, conflict: refusal } };
      return { ok: false, ...refusal };
    }
  }

  const activeTasks = input.activeTasks ?? [];
  for (const other of activeTasks) {
    if (other.taskId === input.taskId) continue;
    const theirsList = normalizeStringList(other.territory);
    if (!theirsList) continue;
    for (const mine of mineList) {
      const mineEntry = parseTerritoryEntry(mine);
      const resolvedMine = resolveTerritoryEntry(mine, input.cwd);
      if (!resolvedMine) continue;
      for (const theirs of theirsList) {
        const theirsEntry = parseTerritoryEntry(theirs);
        const resolvedTheirs = resolveTerritoryEntry(theirs, other.cwd);
        if (!resolvedTheirs) continue;
        if (!segmentsOverlap(resolvedMine.segments, resolvedTheirs.segments)) continue;

        // Both declared shared: the two implementers consented to share.
        if (mineEntry.mode === "shared" && theirsEntry.mode === "shared") continue;

        const base = {
          conflictingTaskId: other.taskId,
          mine,
          theirs,
          mineResolved: resolvedMine.display,
          theirsResolved: resolvedTheirs.display,
        };

        // One shared, one not: the exclusive side never consented.
        if (mineEntry.mode !== theirsEntry.mode) {
          return refuseOrOverride({ ...base, error: describeSharedVsExclusive(base) }, override, warnings);
        }

        const globMine = isGlobSegments(resolvedMine.segments);
        const globTheirs = isGlobSegments(resolvedTheirs.segments);

        if (globMine && globTheirs) {
          // The very same glob claimed by both is a real collision, not nesting.
          if (sameSegments(resolvedMine.segments, resolvedTheirs.segments)) {
            return refuseOrOverride({ ...base, error: describeConcreteVsConcrete(base) }, override, warnings);
          }
          const nested =
            containsSegments(resolvedMine.segments, resolvedTheirs.segments) ||
            containsSegments(resolvedTheirs.segments, resolvedMine.segments);
          if (nested) {
            warnings.push({ ...base, message: describeBroadGlob(base) });
            continue;
          }
          return refuseOrOverride({ ...base, error: describeGlobCross(base) }, override, warnings);
        }

        if (globMine !== globTheirs) {
          const concrete = globMine ? resolvedTheirs : resolvedMine;
          const exists = input.pathExists ? input.pathExists(concrete.display) : true;
          if (!exists) {
            warnings.push({ ...base, message: describeNewFileUnderGlob(base) });
            continue;
          }
          return refuseOrOverride({ ...base, error: describeConcreteVsGlob(base) }, override, warnings);
        }

        // Two concrete paths that overlap.
        return refuseOrOverride({ ...base, error: describeConcreteVsConcrete(base) }, override, warnings);
      }
    }
  }
  return { ok: true, warnings };
}

function refuseOrOverride(
  refusal: TerritoryRefusal,
  override: string,
  warnings: TerritoryWarning[],
): TerritoryConflictDecision {
  if (override) return { ok: true, warnings, overridden: { reason: override, conflict: refusal } };
  return { ok: false, ...refusal };
}

/**
 * Lists, for a task's SHARED entries, the OTHER active tasks on the same path —
 * the coordination list each implementer's brief carries. Pure: callers pass
 * the already-filtered active tasks. One line per (path, other task); `null`
 * when there is nothing shared to report.
 */
export function describeSharedCoOwners(input: {
  taskId: string;
  territory: string[] | null;
  cwd?: string | null;
  others: { taskId: string; territory: string[] | null; cwd?: string | null }[];
}): string | null {
  const mineList = normalizeStringList(input.territory);
  if (!mineList) return null;
  const shared = mineList.filter(isSharedTerritoryEntry);
  if (shared.length === 0) return null;
  const lines: string[] = [];
  for (const raw of shared) {
    const mine = resolveTerritoryEntry(raw, input.cwd);
    if (!mine) continue;
    for (const other of input.others) {
      if (other.taskId === input.taskId) continue;
      const theirsList = normalizeStringList(other.territory);
      if (!theirsList) continue;
      for (const theirs of theirsList) {
        if (!isSharedTerritoryEntry(theirs)) continue;
        const resolvedTheirs = resolveTerritoryEntry(theirs, other.cwd);
        if (!resolvedTheirs) continue;
        if (!segmentsOverlap(mine.segments, resolvedTheirs.segments)) continue;
        const note = parseTerritoryEntry(theirs).note ?? parseTerritoryEntry(raw).note ?? "no note";
        lines.push(`- "${raw}" is also held by task ${other.taskId} (shared note: ${note})`);
      }
    }
  }
  return lines.length === 0 ? null : lines.join("\n");
}

/**
 * Two entries collide when their path segments agree up to a wildcard, or until
 * the shorter one ends (prefix). `"*"` matches exactly one segment; `"**"` (or
 * a trailing `"/"`, normalized) matches the rest. An entry that does not read
 * as a path never collides.
 */
export function territoryEntriesOverlap(a: string, b: string, baseA?: string | null, baseB?: string | null): boolean {
  const segA = resolveTerritoryEntry(a, baseA);
  const segB = resolveTerritoryEntry(b, baseB);
  if (segA === null || segB === null) return false;
  return segmentsOverlap(segA.segments, segB.segments);
}

/** The comparator core: per-segment prefix with `*`/`**`. */
function segmentsOverlap(segA: readonly string[], segB: readonly string[]): boolean {
  const len = Math.min(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    if (segA[i] === "**" || segB[i] === "**") return true;
    if (segA[i] === "*" || segB[i] === "*") continue;
    if (segA[i] !== segB[i]) return false;
  }
  return true;
}

/** True when any segment carries a wildcard — `*`, `**`, or an embedded one
 *  like `smoke-a8-*.mjs` (a specific pattern is still a pattern). */
function isGlobSegments(segments: readonly string[]): boolean {
  return segments.some((s) => s.includes("*"));
}

/** True when the two resolved segment lists are identical. */
function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * Does every path matching `inner` also match `outer`? (inner ⊆ outer.) Walks
 * together; `outer`'s `**` covers the rest; `inner`'s `**` where `outer` has a
 * literal means inner is broader, so outer does not contain it.
 */
function containsSegments(outer: readonly string[], inner: readonly string[]): boolean {
  for (let i = 0; i < outer.length; i++) {
    // `**` covers the rest of `inner`.
    if (outer[i] === "**") return true;
    // `outer` longer than `inner` without a `**` does not cover it.
    if (i >= inner.length) return false;
    // `inner` broader at this segment means `outer` does not contain it.
    if (inner[i] === "**") return false;
    // `*` matches exactly one segment, so it covers a literal `inner[i]`.
    if (outer[i] === "*") continue;
    // A literal `outer[i]` does not cover `inner[i]`'s `*`.
    if (inner[i] === "*") return false;
    if (outer[i] !== inner[i]) return false;
  }
  return outer.length >= inner.length;
}

/** A resolved territory entry: the segments the comparator uses and the
 *  resolved path (to name each side in a refusal). */
export type ResolvedTerritoryEntry = { segments: string[]; display: string };

/**
 * The ONE resolution of a territory entry — shared by the collision guard and
 * the CONTRACT CROSSING so the two never diverge.
 *
 * A `shared:` mode prefix is removed first (the mode is not part of the path).
 * An ABSOLUTE entry stays as is (normalized). A RELATIVE one resolves against
 * `base` (own `cwd`, or board root); without a base it stays relative. `..`
 * that ESCAPES the base is refused (`null`, not comparable). A trailing `"/"`
 * becomes an explicit `"**"`. An entry with a space (prose) does not read as a
 * path. A glued `" (note)"` is removed too.
 */
export function resolveTerritoryEntry(raw: string, base?: string | null): ResolvedTerritoryEntry | null {
  const withModeStripped = raw.replace(/^shared:\s*/i, "");
  const withoutNote = withModeStripped.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (withoutNote.length === 0) return null;
  if (/\s/.test(withoutNote)) return null;
  const withStar = withoutNote.endsWith("/") ? `${withoutNote}**` : withoutNote;

  let path: string;
  if (withStar.startsWith("/")) {
    path = posix.normalize(withStar);
  } else {
    const relative = posix.normalize(withStar);
    if (relative === ".." || relative.startsWith("../")) return null;
    const basePath = normalizeTerritoryBase(base);
    path = basePath ? posix.resolve(basePath, relative) : relative;
  }
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  return { segments, display: path };
}

/** Non-empty base (trim), or `null` — absence of a base is data, not an error. */
function normalizeTerritoryBase(base: string | null | undefined): string | null {
  const trimmed = typeof base === "string" ? base.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/* ============================ AGENT-FACING TEXT ============================
 * Same channel as every other spawn refusal; English, and each one TEACHES the
 * way out (declare shared on BOTH sides, or override with a reason). */

type RefusalBodies = Pick<
  TerritoryRefusal,
  "conflictingTaskId" | "mine" | "theirs" | "mineResolved" | "theirsResolved"
>;

function describeSharedWithoutNote(raw: string): string {
  return (
    `[de: stellar] territory "${raw}" declares mode \`shared\` without the mandatory coordination note — ` +
    `a shared path is a promise that TWO implementers coordinate on it, so the note is not optional. ` +
    `Write it as \`shared:<path> (<how the two implementers coordinate: who re-reads before editing, who owns which part>)\`, ` +
    `or declare the path without the \`shared:\` prefix to keep it exclusive. Nothing was written.`
  );
}

function describeSharedVsExclusive(b: RefusalBodies): string {
  return (
    `[de: stellar] territory "${b.mine}" (resolved: "${b.mineResolved}") overlaps task ${b.conflictingTaskId}'s declared "${b.theirs}" ` +
    `(resolved: "${b.theirsResolved}"), which is ACTIVE right now. One side declared the path \`shared\` and the other did not — ` +
    `two implementers may hold the same path ONLY when BOTH declare it shared. Declare \`shared:<path> (<coordination note>)\` on BOTH, ` +
    `or change one territory. Nothing was written.`
  );
}

function describeConcreteVsConcrete(b: RefusalBodies): string {
  return (
    `[de: stellar] territory "${b.mine}" (resolved: "${b.mineResolved}") overlaps task ${b.conflictingTaskId}'s declared "${b.theirs}" ` +
    `(resolved: "${b.theirsResolved}"), and that task is ACTIVE right now — refusing a second live implementer over the same declared path. ` +
    `If you truly need to share it, declare \`shared:<path> (<coordination note>)\` on BOTH tasks; an orchestrator can pass ` +
    `\`overrideTerritory: "<reason>"\` to proceed anyway, which is recorded. Nothing was written.`
  );
}

function describeConcreteVsGlob(b: RefusalBodies): string {
  return (
    `[de: stellar] territory "${b.mine}" (resolved: "${b.mineResolved}") matches task ${b.conflictingTaskId}'s declared glob "${b.theirs}" ` +
    `(resolved: "${b.theirsResolved}"), which is ACTIVE right now, and the path ALREADY EXISTS on disk — this is a real collision with the ` +
    `files that glob claims. Declare \`shared:<path> (<note>)\` on BOTH tasks, narrow one side, or pass ` +
    `\`overrideTerritory: "<reason>"\` (recorded). Nothing was written.`
  );
}

function describeGlobCross(b: RefusalBodies): string {
  return (
    `[de: stellar] territory glob "${b.mine}" (resolved: "${b.mineResolved}") crosses task ${b.conflictingTaskId}'s glob "${b.theirs}" ` +
    `(resolved: "${b.theirsResolved}") — neither contains the other and that task is ACTIVE. Narrow one side, declare ` +
    `\`shared:<path> (<note>)\` on BOTH, or pass \`overrideTerritory: "<reason>"\` (recorded). Nothing was written.`
  );
}

function describeBroadGlob(b: RefusalBodies): string {
  return (
    `[de: stellar] territory "${b.mine}" (resolved: "${b.mineResolved}") is nested under task ${b.conflictingTaskId}'s broader glob ` +
    `"${b.theirs}" (resolved: "${b.theirsResolved}"), which is ACTIVE. Allowed: a broad claim does not hard-block a narrower one — ` +
    `coordinate with task ${b.conflictingTaskId} before writing. This is a warning, not a gate.`
  );
}

function describeNewFileUnderGlob(b: RefusalBodies): string {
  return (
    `[de: stellar] territory "${b.mine}" (resolved: "${b.mineResolved}") sits under task ${b.conflictingTaskId}'s broader claim ` +
    `"${b.theirs}" (resolved: "${b.theirsResolved}"), which is ACTIVE, but the path does not exist on disk yet — allowed as a NEW/specific ` +
    `target under a broad claim. Coordinate with task ${b.conflictingTaskId} before creating it (this is a warning, not a gate).`
  );
}

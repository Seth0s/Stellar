/**
 * THE DECISION to isolate (or not) a task's gates in a worktree holding only
 * its own diff.
 *
 * MEASURED DEFECT: with five implementers on the SAME tree, the gate the app
 * measures after `report` runs against the whole shared checkout and picks up
 * the other cards' half-finished work. A good task came back red because of a
 * leftover import in a file another card was editing; a minute later the same
 * check passed. A false red on a good task — and, symmetrically, a green can
 * hide a real red.
 *
 * THE FIX is not "measure less": it is to measure in a DISPOSABLE copy of HEAD
 * with ONLY this task's changes applied. This module decides WHICH files are
 * "this task's" and WHEN that cannot be asserted — pure, no I/O; the worktree
 * preparation lives in `gate-isolation.ts`.
 *
 * WHERE THE SET COMES FROM: the `filesChanged` of the report the CARD itself
 * wrote (the DECLARED step of `diff-attribution.ts`). It is the author's
 * declaration, never verified by the app — and the shared tree does not allow
 * deriving AUTHORSHIP by observation (the app observes CHANGE, never who
 * touched it).
 *
 * WHAT NEVER HAPPENS: isolating silently with a WRONG set.
 *   - a file declared by TWO cards at once → DISPUTED → `shared` with both ids
 *     in the note (picking one would be a guess);
 *   - the card declared no file (or there is no card) → no attribution →
 *     `shared` (isolating to pure HEAD would measure the wrong tree and give a
 *     false green);
 *   - a declared path that is absolute or contains `..` → invalid declaration →
 *     `shared` (the app does not copy what can escape the repository);
 *   - the cwd is not a git repository → `shared` (there is no HEAD to isolate
 *     from).
 *
 * THE DECLARED TERRITORY FILTERS NOTHING. Measured in `gate-runner.ts`: most
 * files the agents declare fall OUTSIDE the territory. Filtering the set by
 * territory would erase exactly the task's change, and the gate would measure a
 * HEAD without it — the same false green this module exists to close. The
 * territory is INTENT, not a description of what happened.
 *
 * IT ENTERS ONLY TO AUGMENT. A card that forgets to declare a changed file
 * used to get a false green: isolation measured only the `filesChanged`. The
 * caller scans the tree, FILTERS the dirty files inside the territory (it owns
 * the matcher) and passes them as `territoryDirty`; here those paths ENTER the
 * isolated set — as long as no OTHER card declared them (another card's
 * declaration is a dispute, and a dispute never becomes a guess). The augment
 * is always ADDITIVE: the declared set stays whole, and nothing is removed for
 * being outside the territory.
 */

/** The files ONE card declared it changed (the report's `filesChanged`). */
export type DeclaredFiles = { cardId: string; paths: readonly string[] };

/** A file claimed by 2+ cards — the note carries every id. */
export type GateIsolationDispute = { path: string; cardIds: string[] };

export type GateIsolationDecision = {
  /** Where the gates must be measured. `shared` = the usual shared tree,
   * which includes the other cards' work. */
  mode: "isolated" | "shared";
  /** The paths to apply to the worktree. Empty when `shared`. */
  files: string[];
  /** Files declared by more than one card INCLUDING this one — the reason to
   * refuse when there is a dispute. Empty otherwise. */
  disputed: GateIsolationDispute[];
  /** Dirty files INSIDE the territory that NO card declared and that entered
   * the isolated set. Empty in `shared` mode — nothing entered the gate. */
  undeclaredInTerritory: string[];
  /** Why `shared`; `null` when `isolated`. */
  reason: string | null;
};

/**
 * Normalizes a path declared in a report to a path RELATIVE to the repository,
 * or `null` when it is not safe/useful. It accepts the shapes the real data
 * has: plain path, `./x`, `:line` suffix (evidence), parenthesised prose
 * (`src/main/x.ts (M, +2/-1)`). It refuses an absolute path and any `..`
 * segment — a path that escapes the root never becomes a copy.
 */
export function normalizeDeclaredRepoPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0) return null;
  s = s.replace(/\\/g, "/");
  // Absolute (POSIX or Windows) is not relative to the repo: refuse.
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) return null;
  s = s.replace(/^\.\/+/, "");
  s = s.split(" (")[0] ?? s;
  s = s.replace(/:\d+(-\d+)?$/, "");
  const parts = s.split("/");
  if (parts.some((p) => p === "..")) return null;
  const cleaned = parts.filter((p) => p.length > 0 && p !== ".").join("/");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Reads the `filesChanged` of a raw `report_json` — a list of normalized paths,
 * or `[]` when the report lacks the field / is unreadable. Pure and defensive:
 * an unexpected shape becomes ABSENCE (never an invented path), and the absence
 * is what drives the decision to `shared`.
 */
export function readDeclaredFilesFromReport(reportJson: string | null | undefined): string[] {
  if (!reportJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const raw = (parsed as Record<string, unknown>).filesChanged;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const path = normalizeDeclaredRepoPath(entry);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function shared(reason: string, disputed: GateIsolationDispute[] = []): GateIsolationDecision {
  return { mode: "shared", files: [], disputed, undeclaredInTerritory: [], reason };
}

/**
 * The decision. Pure: it only looks at the per-card declaration and the git
 * root.
 */
export function decideGateIsolation(input: {
  /** The implementer card OF THIS task (who declares what it changed). */
  cardId: string | null;
  /** `filesChanged` of each ACTIVE card, raw (the module normalizes). Include
   * OTHER live writers so a real dispute is detectable; omit archived,
   * missing, released, and terminal-task cards (see active-declaration-decision)
   * — ghost ids in this list were the measured false shared-mode trigger. */
  declared: readonly DeclaredFiles[] | null | undefined;
  /** Git root of the task's cwd, or `null` outside a repository. */
  gitRoot: string | null;
  /** Dirty files observed in the tree that fall INSIDE the declared territory
   * — the caller already filtered by the territory matcher. They enter the
   * isolated set when no card declared them. Absent = nothing to add. */
  territoryDirty?: readonly string[] | null;
  /** Nested repositories intersecting this task's declared paths. An outer
   * repository worktree cannot contain their HEAD or dirty files, so this
   * forces a measured shared-tree run instead of a false isolated result. */
  nestedRepositories?: readonly string[] | null;
}): GateIsolationDecision {
  if (!input.gitRoot) {
    return shared("o cwd desta task não é um repositório git — não há HEAD de onde isolar.");
  }
  if (!input.cardId) {
    return shared("a task não tem card implementer — não há como atribuir quais arquivos são dela.");
  }
  const nestedRepositories = [...new Set(input.nestedRepositories ?? [])];
  if (nestedRepositories.length > 0) {
    return shared(
      `the declared territory or changed files intersect nested git repositories (${nestedRepositories.join(", ")}); ` +
        "an outer-repository worktree cannot include them, so the gates will run in the shared tree",
    );
  }
  // Normalizes EVERY declaration (including the other cards': the dispute is
  // between declarations, and a neighbour's unsafe path does not contaminate
  // ours).
  const byPath = new Map<string, Set<string>>();
  const mine: string[] = [];
  const mineSeen = new Set<string>();
  for (const decl of input.declared ?? []) {
    if (typeof decl?.cardId !== "string") continue;
    for (const raw of decl.paths ?? []) {
      const path = normalizeDeclaredRepoPath(raw);
      if (path === null) {
        // A declared path of MY card that is INVALID: do not isolate — the set
        // may be missing a change, and an incomplete isolation is the false
        // green this module closes.
        if (decl.cardId === input.cardId) {
          return shared(`o relatório declarou um caminho inválido (${JSON.stringify(raw)}) — não isola com um conjunto que pode estar errado.`);
        }
        continue;
      }
      const set = byPath.get(path) ?? new Set<string>();
      set.add(decl.cardId);
      byPath.set(path, set);
      if (decl.cardId === input.cardId && !mineSeen.has(path)) {
        mineSeen.add(path);
        mine.push(path);
      }
    }
  }
  if (mine.length === 0) {
    return shared("o relatório do card não declarou nenhum arquivo (filesChanged vazio) — sem atribuição, isolar mediria o HEAD sem as mudanças desta task.");
  }
  const disputed: GateIsolationDispute[] = [];
  for (const path of mine) {
    const cards = byPath.get(path);
    if (cards && cards.size > 1) disputed.push({ path, cardIds: [...cards] });
  }
  if (disputed.length > 0) {
    const names = disputed.map((d) => `${d.path} (${d.cardIds.join(", ")})`).join("; ");
    return shared(
      `arquivo(s) declarado(s) por mais de um card ao mesmo tempo — não escolhe um lado: ${names}.`,
      disputed,
    );
  }
  // TERRITORY AUGMENT: dirty files inside the territory that NO card declared
  // enter the isolated set. A path another card already declared stays out —
  // its dispute would have fallen to `shared` above when it was OURS; if it is
  // another's, choosing it would be a guess.
  const undeclaredInTerritory: string[] = [];
  for (const raw of input.territoryDirty ?? []) {
    const path = normalizeDeclaredRepoPath(raw);
    if (path === null || mineSeen.has(path) || byPath.has(path)) continue;
    if (undeclaredInTerritory.includes(path)) continue;
    undeclaredInTerritory.push(path);
  }
  for (const path of undeclaredInTerritory) mineSeen.add(path);
  const files = [...mine, ...undeclaredInTerritory].sort();
  return { mode: "isolated", files, disputed: [], undeclaredInTerritory, reason: null };
}

/**
 * The mode's note — the sentence that stops a hurried reviewer from reading the
 * green/red as this task's alone when it is not. `isolated` also warns, because
 * the value is in SAYING that the measurement is clean.
 */
export function describeGateIsolation(input: {
  mode: "isolated" | "shared";
  appliedFiles: readonly string[];
  disputed: readonly GateIsolationDispute[];
  reason: string | null;
  /** Files of the territory that entered the gate without a declaration. */
  undeclaredInTerritory?: readonly string[];
}): string {
  if (input.mode === "isolated") {
    const n = input.appliedFiles.length;
    const undeclared = input.undeclaredInTerritory ?? [];
    const undeclaredNote =
      undeclared.length > 0
        ? ` ${undeclared.length} arquivo(s) do território não declarados entraram no gate: ${undeclared.join(", ")}.`
        : "";
    return (
      `Gates medidos numa worktree ISOLADA do HEAD com SÓ as mudanças desta task: ` +
      `${n} arquivo(s) aplicado(s)${n > 0 ? `: ${input.appliedFiles.join(", ")}` : ""}. ` +
      `O trabalho dos outros cards NÃO entrou nesta medição.${undeclaredNote}`
    );
  }
  const base = "Gates medidos na ÁRVORE COMPARTILHADA: pode incluir trabalho de outros cards.";
  const why = input.reason ? ` Motivo: ${input.reason}` : "";
  const dispute =
    input.disputed.length > 0
      ? ` ${input.disputed
          .map((d) => `"${d.path}" foi declarado por ${d.cardIds.join(" e ")}`)
          .join("; ")}.`
      : "";
  return `${base}${why}${dispute}`;
}

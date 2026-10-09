/**
 * Pure Fila V3 decisions (DADOS.md §§3–6): queue column, tile status phrase,
 * Agora banner, and "needs you" membership. Never invents missing facts.
 */

import type { TaskPhase } from "../../main/task-phase-decision";
import type { TaskPurpose } from "../../task-purpose";
import { cardHasReviewer } from "../../task-purpose";

/** Queue columns by orchestrator phase (DADOS §3). */
export type QueueColumn =
  | "waiting"
  | "ready"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "superseded";

export const QUEUE_COLUMN_ORDER: readonly QueueColumn[] = [
  "waiting",
  "ready",
  "running",
  "review",
  "done",
  "failed",
  "superseded",
];

/** Visible primary columns (rails collapsed until opened). */
export const QUEUE_PRIMARY_COLUMNS: readonly QueueColumn[] = [
  "waiting",
  "ready",
  "running",
  "review",
  "done",
];

export const QUEUE_RAIL_COLUMNS: readonly QueueColumn[] = ["failed", "superseded"];

export type QueueFilter = "all" | "needsYou" | "liveAgent";

export type QueueTaskFacts = {
  phase: TaskPhase;
  status: string;
  cardAlive: boolean;
  blockedQuestion: unknown | null;
  requestedStatus: string | null;
  review: string | null;
  cards: readonly { role: string; label?: string | null; provider?: string | null; cardId?: string }[];
  /** Optional: last measured agent action line (lacuna 3). Absent → generic "trabalhando". */
  recentAction?: string | null;
  screenTurnState?: "working" | "ended" | "unknown" | null;
  /** Provider quota exhausted for this task's provider — only when measured. */
  providerQuotaExhausted?: boolean;
  provider?: string | null;
  deps?: readonly string[];
  depTitles?: Readonly<Record<string, string | undefined>>;
  gateRun?: {
    ok: boolean;
    failedCommand: string | null;
    isolation: { undeclaredInTerritory: string[] } | null;
    /** Per-command results when the measured gate listed them. */
    commands?: readonly { cmd: string; ok: boolean }[] | null;
  } | null;
  /** Reviewer waiting label when known. */
  reviewerLabel?: string | null;
  /** Approver label for done phrase. */
  approverLabel?: string | null;
  rounds?: number;
  failureKind?: string | null;
  updatedAt?: number;
  supersededBy?: string | null;
  supersededTargetDone?: boolean;
  supersededTitle?: string | null;
  supersededReason?: string | null;
  purpose?: TaskPurpose | null;
  /** Elapsed ms since last card activity (running). */
  lastActivityAgeMs?: number | null;
  contextPercent?: number | null;
  hasReportThisRound?: boolean;
  blockedAskedAt?: number | null;
  requestedReason?: string | null;
  /** Gate red is outside this task's territory (measured). */
  gateRedOutsideTerritory?: boolean | null;
  gateFailedFilesOutside?: number | null;
};

/** Start of the local calendar day — used by the Done column "today" filter. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isDoneToday(updatedAt: number | undefined, now: number): boolean {
  if (updatedAt == null) return false;
  return updatedAt >= startOfLocalDay(now);
}

/**
 * DADOS §3 — phase → column. blockedQuestion / requestedStatus win over phase.
 * `running` with a dead card goes to Ready (never Rodando).
 */
export function columnForQueueTask(task: QueueTaskFacts): QueueColumn {
  if (task.blockedQuestion != null || task.requestedStatus != null) return "waiting";
  switch (task.phase) {
    case "waiting_deps":
      return "waiting";
    case "ready":
    case "reserved":
      return "ready";
    case "running":
      return task.cardAlive ? "running" : "ready";
    case "awaiting_review":
    case "changes_requested":
      return "review";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "superseded":
      return "superseded";
    default:
      return "ready";
  }
}

export function groupTasksByQueueColumn<T extends QueueTaskFacts & { id: string; order: number | null; suggestedOrder: number | null; implicitOrder: number | null; createdAt: number }>(
  tasks: readonly T[],
  compare: (a: T, b: T) => number,
): Record<QueueColumn, T[]> {
  const groups: Record<QueueColumn, T[]> = {
    waiting: [],
    ready: [],
    running: [],
    review: [],
    done: [],
    failed: [],
    superseded: [],
  };
  for (const t of tasks) groups[columnForQueueTask(t)].push(t);
  for (const col of QUEUE_COLUMN_ORDER) groups[col].sort(compare);
  return groups;
}

/** DADOS §6 — three sources only. Prototype Fila also shows review=wanted
 * while the task is still in Pronta (ready/reserved), before awaiting_review. */
export function taskNeedsYou(task: QueueTaskFacts): boolean {
  if (task.blockedQuestion != null) return true;
  if (task.requestedStatus != null) return true;
  if (
    task.review === "wanted" &&
    !cardHasReviewer(task.cards.map((c) => c.role)) &&
    (task.phase === "awaiting_review" ||
      task.phase === "ready" ||
      task.phase === "reserved" ||
      task.phase === "changes_requested")
  ) {
    return true;
  }
  return false;
}

export function filterByQueueFilter<T extends QueueTaskFacts>(tasks: readonly T[], filter: QueueFilter): T[] {
  if (filter === "all") return [...tasks];
  if (filter === "needsYou") return tasks.filter(taskNeedsYou);
  return tasks.filter((t) => t.cardAlive && t.phase === "running" && t.blockedQuestion == null);
}

/**
 * Chip counts. "Tudo" = tasks in open columns (waiting/ready/running/review/
 * done-today/failed). Excludes superseded and archived done (see-all link).
 */
export function countQueueFilter(
  tasks: readonly QueueTaskFacts[],
  filter: QueueFilter,
  now: number = Date.now(),
): number {
  if (filter === "all") {
    return tasks.filter((task) => {
      const col = columnForQueueTask(task);
      if (col === "superseded") return false;
      if (col === "done" && !isDoneToday(task.updatedAt, now)) return false;
      return true;
    }).length;
  }
  return filterByQueueFilter(tasks, filter).length;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function implementerLabel(task: QueueTaskFacts): string {
  const impl = task.cards.find((c) => c.role === "implementer") ?? task.cards[0];
  if (impl?.label?.trim()) return impl.label.trim();
  if (impl?.provider) return impl.provider;
  if (task.provider) return task.provider;
  return "card";
}

function firstOpenDep(task: QueueTaskFacts): { id: string; title: string } | null {
  const deps = task.deps ?? [];
  if (deps.length === 0) return null;
  const id = deps[0]!;
  const title = task.depTitles?.[id]?.trim() ?? "";
  return { id, title };
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/**
 * DADOS §4 — first matching rule wins. Returns a single display phrase;
 * never invents an action the app did not measure.
 */
export function deriveTileStatusPhrase(task: QueueTaskFacts): string {
  if (task.blockedQuestion != null) return "Espera sua resposta";
  if (task.requestedStatus != null) {
    // Prototype tile copy (Fila.dc.html); Agora / needs-you still name the ask.
    return "Pausada até você liberar";
  }
  if (task.phase === "waiting_deps") {
    const dep = firstOpenDep(task);
    if (!dep) return "Esperando dependências";
    const titleBit = dep.title ? ` ${dep.title}` : "";
    return `Depois de #${shortId(dep.id)}${titleBit}`;
  }
  if (task.phase === "reserved") {
    return `Reservada para ${implementerLabel(task)}`;
  }
  if (task.phase === "ready" || (task.phase === "running" && !task.cardAlive)) {
    if (task.phase === "running" && !task.cardAlive) return "card encerrou sem report";
    if (task.providerQuotaExhausted && task.provider) {
      return `Sem card · ${task.provider} sem cota`;
    }
    return "Sem card";
  }
  if (task.phase === "running" && task.cardAlive) {
    const who = implementerLabel(task);
    const action = task.recentAction?.trim();
    return action ? `${who} ${action}` : `${who} trabalhando`;
  }
  if (task.phase === "awaiting_review" || task.phase === "changes_requested") {
    // Gate commands render as tile chips; the status line is only the wait.
    const who =
      task.reviewerLabel?.trim() ||
      (task.review === "wanted" && !cardHasReviewer(task.cards.map((c) => c.role)) ? "você" : "o REVISOR");
    return `Esperando ${who}`;
  }
  if (task.phase === "done") {
    const who = task.approverLabel?.trim() || "você";
    const rounds = task.rounds ?? 0;
    const roundBit = rounds > 0 ? ` · ${rounds} rodada${rounds === 1 ? "" : "s"}` : "";
    // Portuguese: "pelo" before consonant-initial labels; "por" before "voce".
    const prep = who === "você" ? "por" : "pelo";
    return `✓ aprovada ${prep} ${who}${roundBit}`;
  }
  if (task.phase === "failed") {
    const kind = task.failureKind?.trim() || "falha";
    const when = task.updatedAt != null ? ` · ${formatDay(task.updatedAt)}` : "";
    return `✕ ${kind}${when}`;
  }
  if (task.phase === "superseded") {
    if (!task.supersededBy) return "Substituída";
    const doneBit = task.supersededTargetDone ? " concluída" : "";
    return `→ #${shortId(task.supersededBy)}${doneBit}`;
  }
  return "Sem card";
}

function gatePhraseBits(task: QueueTaskFacts): string | null {
  const gate = task.gateRun;
  if (!gate || gate.ok || !gate.failedCommand) return null;
  const outside = (gate.isolation?.undeclaredInTerritory?.length ?? 0) > 0 || task.gateRedOutsideTerritory === true;
  const cmd = shortCommand(gate.failedCommand);
  return outside ? `${cmd} ✕ outro card` : `${cmd} ✕`;
}

function shortCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 25)}…`;
}

/** Compact gate chips for the tile (only when a measured gate exists). */
export type TileGateChip = { label: string; tone: "good" | "danger" };

function chipCommandLabel(cmd: string): string {
  const s = cmd.trim().replace(/^npm\s+run\s+/, "").replace(/^npx\s+/, "");
  if (/^vitest\b/i.test(s)) return "vitest";
  const first = s.split(/\s+/)[0] ?? s;
  return first.length <= 28 ? first : `${first.slice(0, 25)}…`;
}

export function deriveTileGateChips(task: QueueTaskFacts): TileGateChip[] {
  const gate = task.gateRun;
  if (!gate) return [];
  const outside =
    (gate.isolation?.undeclaredInTerritory?.length ?? 0) > 0 || task.gateRedOutsideTerritory === true;
  const commands = gate.commands;
  if (commands && commands.length > 0) {
    return commands.map((c) => {
      const name = chipCommandLabel(c.cmd);
      if (c.ok) return { label: `${name} ✓`, tone: "good" as const };
      return { label: outside ? `${name} ✕ outro card` : `${name} ✕`, tone: "danger" as const };
    });
  }
  if (gate.ok) return [{ label: "gates ✓", tone: "good" }];
  const bits = gatePhraseBits(task);
  if (!bits) return [{ label: "gates ✕", tone: "danger" }];
  return [{ label: bits, tone: "danger" }];
}

export type AgoraVariant = "blue" | "amber" | "amber-alert" | "danger" | "neutral" | null;

export type AgoraBanner = {
  variant: AgoraVariant;
  title: string;
  subtitle: string | null;
  actions: { id: string; label: string }[];
};

function ageHoursLabel(askedAt: number | null | undefined, now: number): string | null {
  if (askedAt == null || askedAt <= 0 || now < askedAt) return null;
  const hours = Math.max(1, Math.floor((now - askedAt) / 3_600_000));
  return `${hours} h`;
}

/**
 * DADOS §5 — Agora band for the task detail. `null` when nothing to show
 * (e.g. plain ready with no ask).
 */
export function deriveAgoraBanner(task: QueueTaskFacts, now: number): AgoraBanner | null {
  if (task.phase === "superseded") {
    const id = task.supersededBy ? shortId(task.supersededBy) : "?";
    const titleBit = task.supersededTitle?.trim() ? ` · ${task.supersededTitle.trim()}` : "";
    const reason = task.supersededReason?.trim();
    return {
      variant: "neutral",
      title: `Substituída por #${id}${titleBit}`,
      subtitle: reason
        ? `Motivo: ${reason}. Só leitura daqui em diante.`
        : "Só leitura daqui em diante.",
      actions: [{ id: "open-successor", label: "Abrir a nova task" }],
    };
  }

  if (task.blockedQuestion != null && typeof task.blockedQuestion === "object") {
    const q = task.blockedQuestion as {
      text?: string;
      options?: { id: string; label: string }[];
      askedAt?: number;
    };
    const age = ageHoursLabel(q.askedAt ?? task.blockedAskedAt, now);
    const options = Array.isArray(q.options)
      ? q.options.filter((o) => o?.id && o?.label).map((o) => ({ id: o.id, label: o.label }))
      : [];
    return {
      variant: "amber",
      title: age ? `Pergunta para você · há ${age}` : "Pergunta para você",
      subtitle: typeof q.text === "string" ? q.text : null,
      actions: options,
    };
  }

  if (task.requestedStatus != null) {
    const reason = task.requestedReason?.trim();
    return {
      variant: "amber",
      title: `${implementerLabel(task)} pede para mover para ${task.requestedStatus}`,
      subtitle: reason ?? null,
      actions: [
        { id: "approve-status", label: "Aprovar" },
        { id: "deny-status", label: "Recusar" },
      ],
    };
  }

  if (task.phase === "running" && task.cardAlive) {
    const ageSec =
      task.lastActivityAgeMs == null ? null : Math.max(0, Math.floor(task.lastActivityAgeMs / 1000));
    const parts: string[] = [];
    if (ageSec != null) parts.push(`Última atividade há ${ageSec} s`);
    if (task.contextPercent != null) parts.push(`contexto ${task.contextPercent}%`);
    if (task.hasReportThisRound === false) parts.push("nenhum report ainda nesta rodada");
    return {
      variant: "blue",
      title: `${implementerLabel(task)} está trabalhando`,
      subtitle: parts.length > 0 ? parts.join(" · ") : null,
      actions: [
        { id: "open-card", label: "Abrir o card" },
        { id: "ask-status", label: "Pedir status" },
      ],
    };
  }

  if (task.phase === "awaiting_review" || task.phase === "changes_requested") {
    const gate = task.gateRun;
    const outside =
      task.gateRedOutsideTerritory === true ||
      (gate != null && !gate.ok && (gate.isolation?.undeclaredInTerritory?.length ?? 0) > 0);
    const insideRed = gate != null && !gate.ok && !outside;

    if (outside) {
      const cmd = gate?.failedCommand ? shortCommand(gate.failedCommand) : "o gate";
      const n = task.gateFailedFilesOutside ?? gate?.isolation?.undeclaredInTerritory.length ?? 0;
      const nBit = n > 0 ? ` em ${n} arquivos fora do território` : " fora do território";
      return {
        variant: "amber-alert",
        title: "Esperando revisão · o gate falhou, mas o vermelho não é desta task",
        subtitle: `${cmd} quebrou${nBit} (trabalho de outro card em andamento). Os arquivos desta task passam.`,
        actions: [
          { id: "remeasure", label: "Medir de novo" },
          { id: "review", label: "Revisar" },
        ],
      };
    }

    if (insideRed) {
      const cmd = gate?.failedCommand ? shortCommand(gate.failedCommand) : "gate";
      return {
        variant: "danger",
        title: "o gate falhou nesta task",
        subtitle: cmd,
        actions: [
          { id: "return", label: "Devolver" },
          { id: "review", label: "Revisar" },
        ],
      };
    }

    return {
      variant: "amber",
      title: "Esperando revisão",
      subtitle: null,
      actions: [{ id: "review", label: "Revisar" }],
    };
  }

  return null;
}

/** Tile type chip label from purpose / blocked ask — short forms from the prototype. */
export function deriveTileTypeLabel(task: QueueTaskFacts): string | null {
  if (task.blockedQuestion != null) return "pergunta";
  switch (task.purpose) {
    case "investigate":
      return "investigar";
    case "implement":
      return "implementar";
    case "fix":
      return "corrigir";
    case "measure":
      return "medir";
    case "integrate":
      return "integrar";
    default:
      return null;
  }
}

/** Whether the live dot + activity bar should show (respect reduced motion in CSS). */
export function tileShowsLiveActivity(task: QueueTaskFacts): boolean {
  return task.phase === "running" && task.cardAlive && task.blockedQuestion == null;
}

export { summarizeRecentAction } from "../../shared/recent-action";

/** Map a queue column drop to the status written by moveTask. */
export function queueColumnToStatus(column: QueueColumn): string {
  switch (column) {
    case "waiting":
    case "ready":
      return "pending";
    case "running":
    case "review":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "superseded":
      return "superseded";
  }
}

/** Open-column minimum widths from Fila-v3.1 (running/review columns are wider). */
export const QUEUE_COLUMN_MIN_PX: Record<QueueColumn, number> = {
  waiting: 200,
  ready: 200,
  running: 220,
  review: 220,
  done: 200,
  failed: 200,
  superseded: 200,
};

export const QUEUE_RAIL_WIDTH_PX = 44;
export const QUEUE_COLUMN_GAP_PX = 12;

export type QueueRailDecisionInput = {
  availableWidth: number;
  counts: Readonly<Record<QueueColumn, number>>;
  /** Columns the user explicitly collapsed (persisted per board). */
  userCollapsed: ReadonlySet<QueueColumn>;
  /** Empty columns the user opened (overrides born-collapsed for this session). */
  userExpanded: ReadonlySet<QueueColumn>;
};

function widthNeeded(rails: ReadonlySet<QueueColumn>): number {
  let total = 0;
  let n = 0;
  for (const col of QUEUE_COLUMN_ORDER) {
    if (n > 0) total += QUEUE_COLUMN_GAP_PX;
    total += rails.has(col) ? QUEUE_RAIL_WIDTH_PX : QUEUE_COLUMN_MIN_PX[col];
    n += 1;
  }
  return total;
}

/**
 * Fila v3.1 — empty columns are born as rails; user collapse is sticky;
 * remaining open columns that do not fit collapse from the right into rails.
 * Expanding a rail on a narrow card may overflow (horizontal scroll), never omit.
 */
export function decideColumnRails(input: QueueRailDecisionInput): Set<QueueColumn> {
  const rails = new Set<QueueColumn>();
  for (const col of QUEUE_COLUMN_ORDER) {
    if (input.userCollapsed.has(col)) {
      rails.add(col);
      continue;
    }
    if (input.counts[col] === 0 && !input.userExpanded.has(col)) {
      rails.add(col);
    }
  }
  if (!(input.availableWidth > 0)) return rails;
  // Collapse when open columns would fill the width exactly too — at 1200px
  // Concluida/Falhas/Substituidas must be rails (Fila-v3.1-NOTAS.md).
  while (widthNeeded(rails) >= input.availableWidth) {
    let collapsed = false;
    for (let i = QUEUE_COLUMN_ORDER.length - 1; i >= 0; i--) {
      const col = QUEUE_COLUMN_ORDER[i];
      if (!rails.has(col)) {
        rails.add(col);
        collapsed = true;
        break;
      }
    }
    if (!collapsed) break;
  }
  return rails;
}

const COLLAPSED_STORAGE_PREFIX = "stellar.fila.collapsed.";

export function loadCollapsedColumns(boardId: string): Set<QueueColumn> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_PREFIX + boardId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return new Set();
    const out = new Set<QueueColumn>();
    for (const col of QUEUE_COLUMN_ORDER) {
      if ((parsed as Record<string, unknown>)[col] === true) out.add(col);
    }
    return out;
  } catch {
    return new Set();
  }
}

export function saveCollapsedColumns(boardId: string, collapsed: ReadonlySet<QueueColumn>): void {
  try {
    const obj: Record<string, boolean> = {};
    for (const col of QUEUE_COLUMN_ORDER) {
      if (collapsed.has(col)) obj[col] = true;
    }
    localStorage.setItem(COLLAPSED_STORAGE_PREFIX + boardId, JSON.stringify(obj));
  } catch {
    /* quota / private mode — preference is best-effort */
  }
}

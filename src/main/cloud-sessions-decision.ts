/**
 * ACCOUNT SESSIONS — the pure half: what a board becomes on its way to the
 * account (an allowlisted snapshot, with a project reference instead of a path),
 * what a snapshot becomes when it is opened on a machine, and what each failure
 * of the API means for the screen.
 *
 * The server validates the same allowlist (StellarCloud `internal/sessions`);
 * building only what it accepts here keeps a field the app grows later from
 * reaching the cloud by accident, and keeps a refusal from the server a bug to
 * fix rather than a normal outcome. Nothing in here touches the disk, the
 * network or the database.
 */

import { clampStickyFontSize, parseStickyFontSize, STICKY_FONT_SIZE_DEFAULT } from "../renderer/src/card-types";
import type { BoardRow, CardRow, ConnectorRow, TaskCardRow, TaskRow } from "./store";

// ---------------------------------------------------------------------------
// Snapshot shape (the contract's §4)
// ---------------------------------------------------------------------------

export type CwdRef = { rel: string } | { outside: true };
export type ProjectRef = { kind: "git"; remote: string; name: string } | { kind: "folder"; name: string };

export type SnapshotCard = {
  ref: string;
  kind: SnapshotCardKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string | null;
  group_ref?: string | null;
  provider?: string;
  model?: string;
  effort?: string;
  cwd_ref?: CwdRef;
  resume_id?: string;
  url?: string;
  persistent?: boolean;
  content?: string;
  color?: string;
  mode?: string;
  font_size?: number;
  points?: [number, number][];
  width?: number;
  style?: string;
};

export type SnapshotCardKind = "terminal" | "browser" | "files" | "changes" | "sticky" | "stroke" | "chat" | "task";

export type SnapshotConnector = { from_ref: string; to_ref: string; kind?: "context" | "depends"; label?: string };

export type SnapshotTask = {
  ref: string;
  prompt: string;
  provider?: string;
  status: "pending" | "blocked" | "done" | "failed" | "cancelled";
  deps?: string[];
  order?: number;
  suggested_order?: number;
  card_links?: { card_ref: string; role: "implementer" | "reviewer" }[];
};

export type SessionSnapshot = {
  schema_version: 1;
  board: {
    name: string;
    project: string;
    autonomous: boolean;
    concurrency_cap?: number;
    orchestrator_card_ref?: string;
  };
  cards: SnapshotCard[];
  connectors: SnapshotConnector[];
  tasks: SnapshotTask[];
};

export type SessionSummary = { cardCount: number; taskCount: number };

// ---------------------------------------------------------------------------
// Limits and patterns the server enforces (kept in step with snapshot.go)
// ---------------------------------------------------------------------------

export const SNAPSHOT_LIMITS = {
  cards: 200,
  connectors: 500,
  tasks: 2000,
  strokePoints: 5000,
  taskPromptBytes: 64 << 10,
  stickyBytes: 16 << 10,
  urlBytes: 2048,
  label: 120,
  deps: 200,
  cardLinks: 20,
} as const;

const RESUME = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER = /^[a-z0-9_-]{1,32}$/;

/** Card kinds a snapshot carries. Everything else (media, an external window) stays on the machine. */
const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["terminal", "browser", "files", "changes", "sticky", "stroke", "chat", "task"]);

// ---------------------------------------------------------------------------
// Project reference
// ---------------------------------------------------------------------------

/**
 * The `origin` of a git checkout as `host/org/repo`: no protocol, user, password
 * or token, no port, no `.git`. `null` when the text is not a git remote the
 * server would accept. Two checkouts of the same repository on two machines
 * (one over https, one over ssh) come out equal.
 */
export function normalizeGitRemote(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let text = raw.trim();
  if (text === "") return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(?!\d+\/)([^\s]+)$/.exec(text);
  const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([A-Za-z0-9.-]+)(?::\d{1,5})?\/([^\s?#]+)/.exec(text);
  if (url) {
    host = url[1]!;
    path = url[2]!;
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  text = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const segments = text.split("/").filter((s) => s !== "");
  if (segments.length < 1) return null;
  if (!segments.every((s) => /^[A-Za-z0-9._~-]+$/.test(s))) return null;
  return `${host.toLowerCase()}/${segments.join("/")}`;
}

/** Last segment of a path, `/` or `\` separated. */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** `git` when the checkout has a usable origin, otherwise the folder name. `null` when there is neither. */
export function buildProjectRef(input: { remoteUrl: string | null; root: string }): ProjectRef | null {
  const name = folderName(input.root).slice(0, SNAPSHOT_LIMITS.label);
  if (name === "" || /[\\/]/.test(name)) return null;
  const remote = normalizeGitRemote(input.remoteUrl);
  if (remote !== null && remote.length <= 256) return { kind: "git", remote, name };
  return { kind: "folder", name };
}

/** Whether a folder on this machine is the project a reference names, and how sure that is. */
export function matchProjectRef(ref: ProjectRef, candidate: { path: string; remoteUrl: string | null }): "remote" | "name" | null {
  if (ref.kind === "git" && normalizeGitRemote(candidate.remoteUrl) === ref.remote) return "remote";
  if (folderName(candidate.path) === ref.name) return "name";
  return null;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * A card's folder relative to the project root. `null` = the root itself (or
 * no folder at all); `{ outside: true }` = a folder that is not under the root.
 */
export function buildCwdRef(cwd: string, root: string): CwdRef | null {
  const c = toPosix(cwd).replace(/\/+$/, "");
  const r = toPosix(root).replace(/\/+$/, "");
  if (c === "" || r === "") return c === r ? null : { outside: true };
  if (c === r) return null;
  const prefix = r === "" ? "/" : `${r}/`;
  const inside = process.platform === "win32" || /^[A-Za-z]:/.test(r) ? c.toLowerCase().startsWith(prefix.toLowerCase()) : c.startsWith(prefix);
  if (!inside) return { outside: true };
  const rel = c.slice(prefix.length);
  if (rel === "" || rel.split("/").some((s) => s === "..")) return { outside: true };
  return { rel };
}

/** The folder on this machine a reference stands for, under the project root chosen here. */
export function resolveCwdRef(ref: CwdRef | null | undefined, root: string): string {
  if (!ref || "outside" in ref) return root;
  const r = root.replace(/[\\/]+$/, "");
  const sep = r.includes("\\") && !r.includes("/") ? "\\" : "/";
  return `${r}${sep}${ref.rel.split("/").join(sep)}`;
}

// ---------------------------------------------------------------------------
// Building the snapshot
// ---------------------------------------------------------------------------

function singleLine(text: string | null | undefined, max: number): string | null {
  if (text == null) return null;
  const cleaned = stripChars(text.replace(/[\r\n\t]+/g, " "), (c) => c < 0x20).trim();
  if (cleaned === "") return null;
  return truncateBytes(cleaned, max);
}

/** `text` without the characters whose code `drop` accepts. */
function stripChars(text: string, drop: (code: number) => boolean): string {
  let out = "";
  for (const ch of text) if (!drop(ch.codePointAt(0)!)) out += ch;
  return out;
}

function hasChar(text: string, test: (code: number) => boolean): boolean {
  for (const ch of text) if (test(ch.codePointAt(0)!)) return true;
  return false;
}

/** Cuts to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = text.slice(0, max);
  while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
  return out;
}

function multiLine(text: string, max: number): string {
  // Tab, line feed and carriage return stay; every other control character goes (the server refuses them).
  const cleaned = stripChars(text, (c) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d);
  return truncateBytes(cleaned, max);
}

function safeRef(id: string, used: Set<string>): string {
  let ref = id.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 64);
  if (ref === "") ref = "card";
  let candidate = ref;
  let n = 1;
  while (used.has(candidate)) {
    const suffix = `-${n++}`;
    candidate = ref.slice(0, 64 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

function finite(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) <= 1e7;
}

function httpUrl(raw: string): string | null {
  if (raw === "" || Buffer.byteLength(raw, "utf8") > SNAPSHOT_LIMITS.urlBytes || hasChar(raw, (c) => c < 0x20)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username !== "" || u.password !== "") return null;
    return raw;
  } catch {
    return null;
  }
}

function parseStroke(raw: string): { points: [number, number][]; width: number; style: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const obj = Array.isArray(parsed) ? { points: parsed } : (parsed as { points?: unknown; width?: unknown; style?: unknown });
    if (!obj || !Array.isArray(obj.points)) return null;
    const points: [number, number][] = [];
    for (const p of obj.points) {
      if (Array.isArray(p) && p.length === 2 && finite(Number(p[0])) && finite(Number(p[1]))) points.push([Number(p[0]), Number(p[1])]);
    }
    const limited = points.length > SNAPSHOT_LIMITS.strokePoints ? thin(points, SNAPSHOT_LIMITS.strokePoints) : points;
    const width = typeof (obj as { width?: unknown }).width === "number" ? Math.min(100, Math.max(0, (obj as { width: number }).width)) : 3;
    const style = (obj as { style?: unknown }).style === "marker" ? "marker" : "solid";
    return { points: limited, width, style };
  } catch {
    return null;
  }
}

/** Keeps `max` points spread evenly, always including the last one. */
function thin(points: [number, number][], max: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]!);
  return out;
}

const TASK_STATUS: Record<string, SnapshotTask["status"]> = {
  pending: "pending",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  // No process is alive on the other machine; a swapped-out task ended without judgment.
  running: "pending",
  superseded: "cancelled",
};

export type BuildSnapshotInput = {
  board: Pick<BoardRow, "name" | "project" | "autonomous" | "concurrency_cap" | "orchestrator_card_id">;
  cards: readonly CardRow[];
  connectors: readonly ConnectorRow[];
  tasks: readonly TaskRow[];
  taskCards: readonly Pick<TaskCardRow, "task_id" | "card_id" | "role" | "released_at">[];
  /** The project root of the board on this machine; every card path is made relative to it. */
  root: string;
};

export type BuiltSnapshot = {
  snapshot: SessionSnapshot;
  /** Cards that stayed on this machine (media, an external window) and archived ones are not counted. */
  omitted: number;
  /** Cards dropped only for being over the card limit. */
  overLimit: number;
  summary: SessionSummary;
};

/**
 * The board as the account stores it. Chat history, `system_prompt` (except the
 * sticky's font size, which is a setting), scrollback, results, reports and
 * every absolute path stay out.
 */
export function buildSnapshot(input: BuildSnapshotInput): BuiltSnapshot {
  const refs = new Map<string, string>();
  const used = new Set<string>();
  const cards: SnapshotCard[] = [];
  let omitted = 0;
  let overLimit = 0;
  for (const row of input.cards) {
    if (row.archived_at != null) continue;
    if (!SUPPORTED_KINDS.has(row.kind)) {
      omitted++;
      continue;
    }
    if (!finite(row.x) || !finite(row.y) || !finite(row.w) || !finite(row.h)) continue;
    if (cards.length >= SNAPSHOT_LIMITS.cards) {
      overLimit++;
      continue;
    }
    const card = buildCard(row, input.root, safeRef(row.id, used));
    refs.set(row.id, card.ref);
    cards.push(card);
  }
  // A group reference names another card's group; map the local group ids to safe refs too.
  const groups = new Map<string, string>();
  for (const [i, card] of cards.entries()) {
    const gid = input.cards.find((c) => refs.get(c.id) === card.ref)?.group_id ?? null;
    if (gid == null || gid === "") continue;
    if (!groups.has(gid)) groups.set(gid, safeRef(`g-${gid}`, new Set()));
    cards[i] = { ...card, group_ref: groups.get(gid)! };
  }

  const connectors: SnapshotConnector[] = [];
  for (const c of input.connectors) {
    const from = refs.get(c.from_card_id);
    const to = refs.get(c.to_card_id);
    if (!from || !to || connectors.length >= SNAPSHOT_LIMITS.connectors) continue;
    const out: SnapshotConnector = { from_ref: from, to_ref: to };
    if (c.kind === "context" || c.kind === "depends") out.kind = c.kind;
    const label = singleLine(c.label, SNAPSHOT_LIMITS.label);
    if (label) out.label = label;
    connectors.push(out);
  }

  const taskRefs = new Map<string, string>();
  const usedTaskRefs = new Set<string>();
  const eligible = input.tasks.slice(0, SNAPSHOT_LIMITS.tasks);
  for (const t of eligible) taskRefs.set(t.id, safeRef(t.id, usedTaskRefs));
  const tasks: SnapshotTask[] = [];
  for (const t of eligible) {
    const ref = taskRefs.get(t.id)!;
    const task: SnapshotTask = {
      ref,
      prompt: truncateBytes(stripChars(t.prompt ?? "", (c) => c === 0), SNAPSHOT_LIMITS.taskPromptBytes),
      status: TASK_STATUS[t.status] ?? "pending",
    };
    if (t.provider && PROVIDER.test(t.provider)) task.provider = t.provider;
    const deps = parseDeps(t.deps_json)
      .map((d) => taskRefs.get(d))
      .filter((d): d is string => d !== undefined && d !== ref)
      .slice(0, SNAPSHOT_LIMITS.deps);
    if (deps.length > 0) task.deps = deps;
    if (typeof t.order === "number" && Number.isInteger(t.order)) task.order = t.order;
    if (typeof t.suggested_order === "number" && Number.isInteger(t.suggested_order)) task.suggested_order = t.suggested_order;
    const links = input.taskCards
      .filter((l) => l.task_id === t.id && (l.released_at == null || l.released_at === 0))
      .map((l) => ({ card_ref: refs.get(l.card_id), role: l.role }))
      .filter((l): l is { card_ref: string; role: "implementer" | "reviewer" } => l.card_ref !== undefined && (l.role === "implementer" || l.role === "reviewer"))
      .slice(0, SNAPSHOT_LIMITS.cardLinks);
    if (links.length > 0) task.card_links = links;
    tasks.push(task);
  }

  const board: SessionSnapshot["board"] = {
    name: singleLine(input.board.name, SNAPSHOT_LIMITS.label) ?? "sessão",
    project: singleLine(input.board.project, SNAPSHOT_LIMITS.label) ?? "",
    autonomous: Boolean(input.board.autonomous),
  };
  if (typeof input.board.concurrency_cap === "number" && input.board.concurrency_cap >= 0 && input.board.concurrency_cap <= 64) {
    board.concurrency_cap = Math.floor(input.board.concurrency_cap);
  }
  const orchestrator = input.board.orchestrator_card_id ? refs.get(input.board.orchestrator_card_id) : undefined;
  if (orchestrator) board.orchestrator_card_ref = orchestrator;

  return {
    snapshot: { schema_version: 1, board, cards, connectors, tasks },
    omitted,
    overLimit,
    summary: { cardCount: cards.length, taskCount: tasks.length },
  };
}

function parseDeps(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function buildCard(row: CardRow, root: string, ref: string): SnapshotCard {
  const card: SnapshotCard = { ref, kind: row.kind as SnapshotCardKind, x: row.x, y: row.y, w: row.w, h: row.h };
  const label = singleLine(row.label, SNAPSHOT_LIMITS.label);
  if (label) card.label = label;
  const cwdRef = () => {
    const r = buildCwdRef(row.cwd, root);
    if (r) card.cwd_ref = r;
  };
  switch (row.kind) {
    case "terminal": {
      if (PROVIDER.test(row.provider)) card.provider = row.provider;
      const model = singleLine(row.model, 120);
      if (model) card.model = model;
      const effort = singleLine(row.effort, 32);
      if (effort) card.effort = effort;
      cwdRef();
      if (row.resume_id && RESUME.test(row.resume_id)) card.resume_id = row.resume_id;
      break;
    }
    case "chat": {
      if (PROVIDER.test(row.provider)) card.provider = row.provider;
      const model = singleLine(row.model, 120);
      if (model) card.model = model;
      cwdRef();
      break;
    }
    case "files":
    case "changes":
      cwdRef();
      break;
    case "browser": {
      const url = httpUrl(row.cwd);
      if (url) card.url = url;
      card.persistent = row.model === "persistent";
      break;
    }
    case "sticky": {
      card.content = multiLine(row.cwd, SNAPSHOT_LIMITS.stickyBytes);
      const color = singleLine(row.provider, 32);
      if (color) card.color = color;
      if (row.model === "edit" || row.model === "preview") card.mode = row.model;
      card.font_size = parseStickyFontSize(row.system_prompt);
      break;
    }
    case "stroke": {
      const stroke = parseStroke(row.cwd);
      if (stroke) {
        card.points = stroke.points;
        card.width = stroke.width;
        card.style = stroke.style;
      }
      break;
    }
    default:
      break;
  }
  return card;
}

/** The part of a session a conflict or a list shows. */
export function summarySnapshot(snapshot: SessionSnapshot): SessionSummary {
  return { cardCount: snapshot.cards.length, taskCount: snapshot.tasks.length };
}

// ---------------------------------------------------------------------------
// Restoring a snapshot on this machine
// ---------------------------------------------------------------------------

export type RestoreInput = {
  snapshot: SessionSnapshot;
  /** The project folder chosen on this machine, or `null` to open without one. */
  root: string | null;
  /** Where cards without a folder open when there is no project folder. */
  fallbackCwd: string;
  profileId: string;
  newId: () => string;
  now: number;
  /** Whether the CLI conversation a terminal card points at exists on this machine. */
  resumeExists: (card: { provider: string; cwd: string; resumeId: string }) => boolean;
};

export type RestorePlan = {
  board: BoardRow;
  cards: CardRow[];
  connectors: ConnectorRow[];
  tasks: TaskRow[];
  taskCards: TaskCardRow[];
  /** Terminal cards that opened clean because their conversation is not on this machine. */
  cleanTerminals: number;
};

/**
 * The local rows a snapshot becomes. Every card, connector and task gets a new
 * local id; the references inside the snapshot are only valid within it.
 */
export function planRestore(input: RestoreInput): RestorePlan {
  const { snapshot } = input;
  const boardId = input.newId();
  const cwdOf = (ref: CwdRef | null | undefined) => (input.root ? resolveCwdRef(ref, input.root) : input.fallbackCwd);
  const cardIds = new Map<string, string>();
  for (const c of snapshot.cards) cardIds.set(c.ref, input.newId());

  let cleanTerminals = 0;
  const cards: CardRow[] = snapshot.cards.map((c) => {
    const base: CardRow = {
      id: cardIds.get(c.ref)!,
      board_id: boardId,
      kind: c.kind,
      provider: "",
      cwd: "",
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      resume_id: null,
      model: null,
      effort: null,
      system_prompt: null,
      group_id: c.group_ref ? `${boardId}:${c.group_ref}` : null,
      label: c.label ?? null,
      updated_at: input.now,
      messages_json: null,
      archived_at: null,
      created_at: input.now,
    };
    switch (c.kind) {
      case "terminal": {
        const cwd = cwdOf(c.cwd_ref);
        let resumeId: string | null = null;
        if (c.resume_id) {
          const provider = c.provider ?? "";
          if (input.resumeExists({ provider, cwd, resumeId: c.resume_id })) resumeId = c.resume_id;
          else cleanTerminals++;
        }
        return { ...base, provider: c.provider ?? "claude", cwd, model: c.model ?? null, effort: c.effort ?? null, resume_id: resumeId };
      }
      case "chat":
        return { ...base, provider: c.provider ?? "anthropic", cwd: cwdOf(c.cwd_ref), model: c.model ?? null, messages_json: "[]" };
      case "files":
      case "changes":
        return { ...base, cwd: cwdOf(c.cwd_ref) };
      case "browser":
        return { ...base, cwd: c.url ?? "about:blank", model: c.persistent ? "persistent" : null };
      case "sticky":
        return {
          ...base,
          cwd: c.content ?? "",
          provider: c.color ?? "yellow",
          model: c.mode ?? null,
          system_prompt: String(clampStickyFontSize(c.font_size ?? STICKY_FONT_SIZE_DEFAULT)),
        };
      case "stroke":
        // The account keeps the line, its width and style; the pen color is not part of the snapshot.
        return {
          ...base,
          provider: "#e8eaf0",
          cwd: JSON.stringify({ points: c.points ?? [], width: c.width ?? 3, style: c.style === "marker" ? "marker" : "solid" }),
        };
      default:
        return base;
    }
  });

  const connectors: ConnectorRow[] = snapshot.connectors.map((c) => ({
    id: input.newId(),
    board_id: boardId,
    from_card_id: cardIds.get(c.from_ref)!,
    to_card_id: cardIds.get(c.to_ref)!,
    updated_at: input.now,
    kind: c.kind ?? null,
    label: c.label ?? null,
  }));

  const taskIds = new Map<string, string>();
  for (const t of snapshot.tasks) taskIds.set(t.ref, input.newId());
  const tasks: TaskRow[] = snapshot.tasks.map((t) => ({
    id: taskIds.get(t.ref)!,
    prompt: t.prompt,
    provider: t.provider ?? null,
    status: t.status,
    card_id: null,
    board_id: boardId,
    cwd: null,
    spawn_profile: null,
    result_json: null,
    deps_json: t.deps && t.deps.length > 0 ? JSON.stringify(t.deps.map((d) => taskIds.get(d)).filter((d): d is string => d !== undefined)) : null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: t.order ?? null,
    suggested_order: t.suggested_order ?? null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: input.now,
    updated_at: input.now,
    actor: "app",
  }));
  const taskCards: TaskCardRow[] = [];
  for (const t of snapshot.tasks) {
    for (const link of t.card_links ?? []) {
      const cardId = cardIds.get(link.card_ref);
      if (!cardId) continue;
      taskCards.push({ task_id: taskIds.get(t.ref)!, card_id: cardId, role: link.role, linked_at: input.now });
    }
  }

  const orchestrator = snapshot.board.orchestrator_card_ref ? (cardIds.get(snapshot.board.orchestrator_card_ref) ?? null) : null;
  const board: BoardRow = {
    id: boardId,
    name: snapshot.board.name,
    project: snapshot.board.project,
    cwd: input.root ?? input.fallbackCwd,
    created_at: input.now,
    updated_at: input.now,
    last_accessed_at: null,
    autonomous: snapshot.board.autonomous,
    concurrency_cap: snapshot.board.concurrency_cap ?? null,
    orchestrator_card_id: orchestrator,
    account_profile_id: input.profileId,
  };
  return { board, cards, connectors, tasks, taskCards, cleanTerminals };
}

// ---------------------------------------------------------------------------
// Failures: what each one means for the screen
// ---------------------------------------------------------------------------

/** What the screen shows for a failed call. `plan`: the profile needs Pro or a Team; `offline`: no connection. */
export type SessionFailure =
  | { state: "plan"; expired: boolean }
  | { state: "offline" }
  | { state: "login" }
  | { state: "limit" }
  | { state: "too-large" }
  | { state: "rate-limited"; retryAfterSec: number | null }
  | { state: "gone" }
  | { state: "invalid"; code: string }
  | { state: "error"; code: string; message: string };

export type SessionApiError = { status: number; code: string; message: string };

export function decideSessionFailure(error: SessionApiError, retryAfterSec: number | null = null): SessionFailure {
  if (error.status === 0 || error.code === "network" || error.code === "timeout") return { state: "offline" };
  switch (error.code) {
    case "plan_required":
      return { state: "plan", expired: false };
    case "plan_expired":
      return { state: "plan", expired: true };
    case "session_limit_reached":
      return { state: "limit" };
    case "snapshot_too_large":
    case "payload_too_large":
      return { state: "too-large" };
    case "rate_limited":
      return { state: "rate-limited", retryAfterSec };
    case "revision_gone":
      return { state: "gone" };
    case "snapshot_invalid":
    case "snapshot_version_unsupported":
      return { state: "invalid", code: error.code };
    default:
      break;
  }
  if (error.status === 401) return { state: "login" };
  if (error.status === 402) return { state: "plan", expired: false };
  if (error.status === 413) return { state: "too-large" };
  if (error.status === 429) return { state: "rate-limited", retryAfterSec };
  return { state: "error", code: error.code, message: error.message };
}

/**
 * ACCOUNT INBOX — pure decision layer (no I/O).
 *
 * Aggregates B8 team inbox items with local awaiting_review tasks, maps kinds
 * to tabs/actions, parses the REST/SSE payloads, and decides reconnect backoff
 * plus whether a system notification is allowed by the prefs.
 */

import { isOpaqueId } from "./local-identity-decision";

export const INBOX_KINDS = [
  "revisar",
  "pedido_pegar",
  "devolucao",
  "gate_falhou",
  "mencao",
  "atribuicao",
  "convite",
  "aprovacao",
  "integracao",
] as const;

export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxTab = "all" | "review" | "requests" | "assigned" | "mentions";

export type InboxActionId =
  | "open"
  | "review_now"
  | "assign_to"
  | "reject"
  | "accept"
  | "return"
  | "redistribute"
  | "gate_output"
  | "reply"
  | "view";

export type NotificationPrefs = {
  inApp: boolean;
  system: boolean;
  dailyDigest: boolean;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  inApp: true,
  system: true,
  dailyDigest: false,
};

export type TeamInboxItem = {
  id: string;
  kind: InboxKind;
  reference: string;
  teamId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
  createdAt: string | null;
  seenAt: string | null;
  resolvedAt: string | null;
};

export type LocalAwaitingItem = {
  boardId: string;
  boardName: string;
  taskId: string;
  title: string;
  updatedAt: number;
};

export type AggregatedInboxItem = {
  id: string;
  source: "team" | "local";
  kind: InboxKind;
  title: string;
  highlight: string;
  meta: string;
  avatarInitials: string;
  avatarTone: 0 | 1 | 2 | 3 | 4 | 5 | "warn" | "info";
  createdAt: number;
  seen: boolean;
  teamId: string | null;
  taskId: string | null;
  boardId: string | null;
  claimId: string | null;
  claimantName: string | null;
  actions: InboxActionId[];
  primaryAction: InboxActionId | null;
};

export type InboxTabCounts = Record<InboxTab, number>;

export type InboxSnapshot = {
  items: AggregatedInboxItem[];
  counts: InboxTabCounts;
  prefs: NotificationPrefs;
  offline: boolean;
  updatedAt: number;
};

export type SseEvent = {
  id: number | null;
  name: string;
  data: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isInboxKind(value: unknown): value is InboxKind {
  return typeof value === "string" && (INBOX_KINDS as readonly string[]).includes(value);
}

function parseUuidField(value: unknown): string | null {
  if (typeof value === "string" && isOpaqueId(value)) return value;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.String === "string" && isOpaqueId(rec.String)) return rec.String;
    if (typeof rec.Bytes === "string" && isOpaqueId(rec.Bytes)) return rec.Bytes;
  }
  return null;
}

function parseTimeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.Time === "string") {
      const ms = Date.parse(rec.Time);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return 0;
}

export function parseNotificationPrefs(raw: unknown): NotificationPrefs | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.in_app !== "boolean" || typeof rec.system !== "boolean" || typeof rec.daily_digest !== "boolean") {
    return null;
  }
  return { inApp: rec.in_app, system: rec.system, dailyDigest: rec.daily_digest };
}

export function parseTeamInboxItem(raw: unknown): TeamInboxItem | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = parseUuidField(rec.id);
  if (!id || !isInboxKind(rec.kind)) return null;
  let payload: Record<string, unknown> = {};
  if (rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload)) {
    payload = rec.payload as Record<string, unknown>;
  } else if (typeof rec.payload === "string") {
    try {
      const parsed = JSON.parse(rec.payload) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  return {
    id,
    kind: rec.kind,
    reference: asString(rec.reference) ?? "",
    teamId: parseUuidField(rec.team_id),
    taskId: parseUuidField(rec.task_id),
    payload,
    createdAt: timestampField(rec.created_at),
    seenAt: timestampField(rec.seen_at),
    resolvedAt: timestampField(rec.resolved_at),
  };
}

function timestampField(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  if (value && typeof value === "object") {
    return asString((value as { Time?: unknown }).Time);
  }
  return null;
}

export function parseInboxListResponse(raw: unknown): { items: TeamInboxItem[]; prefsHint?: never } | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.items)) return null;
  const items: TeamInboxItem[] = [];
  for (const row of rec.items) {
    const item = parseTeamInboxItem(row);
    if (item && !item.resolvedAt) items.push(item);
  }
  return { items };
}

/** Tab a kind belongs to. Gate/invite/approval/integration only appear in "all". */
export function tabForKind(kind: InboxKind): InboxTab | null {
  switch (kind) {
    case "revisar":
      return "review";
    case "pedido_pegar":
    case "devolucao":
      return "requests";
    case "atribuicao":
      return "assigned";
    case "mencao":
      return "mentions";
    default:
      return null;
  }
}

export function actionsForKind(kind: InboxKind): { actions: InboxActionId[]; primary: InboxActionId | null } {
  switch (kind) {
    case "revisar":
      return { actions: ["open", "review_now"], primary: "review_now" };
    case "pedido_pegar":
      return { actions: ["reject", "assign_to"], primary: "assign_to" };
    case "devolucao":
      return { actions: ["view", "redistribute"], primary: "redistribute" };
    case "gate_falhou":
      return { actions: ["gate_output"], primary: null };
    case "mencao":
      return { actions: ["reply"], primary: null };
    case "atribuicao":
      return { actions: ["return", "accept"], primary: "accept" };
    case "convite":
      return { actions: ["accept", "reject"], primary: "accept" };
    default:
      return { actions: ["open"], primary: null };
  }
}

function initialsFrom(text: string, fallback: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarToneForKind(kind: InboxKind): AggregatedInboxItem["avatarTone"] {
  switch (kind) {
    case "revisar":
      return "warn";
    case "pedido_pegar":
      return 3;
    case "devolucao":
      return 2;
    case "gate_falhou":
      return "info";
    case "mencao":
      return 1;
    case "atribuicao":
    case "convite":
      return 4;
    default:
      return 0;
  }
}

function payloadTitle(payload: Record<string, unknown>, fallback: string): string {
  return asString(payload.title) ?? asString(payload.ref) ?? fallback;
}

function formatRelative(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} d`;
}

export function aggregateInboxItems(input: {
  teamItems: TeamInboxItem[];
  localItems: LocalAwaitingItem[];
  now?: number;
}): { items: AggregatedInboxItem[]; counts: InboxTabCounts } {
  const now = input.now ?? Date.now();
  const items: AggregatedInboxItem[] = [];

  for (const team of input.teamItems) {
    const { actions, primary } = actionsForKind(team.kind);
    const title = payloadTitle(team.payload, team.reference || team.kind);
    const actor = asString(team.payload.actor_name) ?? asString(team.payload.claimant_name) ?? "";
    const claimId = asString(team.payload.claim_id);
    const claimantName = asString(team.payload.claimant_name) ?? asString(team.payload.actor_name);
    const gatesPassed = asNumber(team.payload.gates_passed);
    const gatesTotal = asNumber(team.payload.gates_total);
    const quote = asString(team.payload.quote) ?? asString(team.payload.body) ?? asString(team.payload.reason);
    const createdAt = parseTimeMs(team.createdAt) || now;
    const when = formatRelative(createdAt, now);

    let line: string;
    let highlight = title;
    let meta: string;
    let avatarInitials: string;

    switch (team.kind) {
      case "revisar": {
        line = "Revisar";
        avatarInitials = "R";
        const gates =
          gatesPassed != null && gatesTotal != null ? `gates ${gatesPassed}/${gatesTotal} · ` : gatesTotal != null ? `gates medidos ${gatesTotal}/${gatesTotal} · ` : "";
        meta = `${actor || "agente"} · ${gates}${when}${asString(team.payload.board_label) ? ` · ${asString(team.payload.board_label)}` : ""}`;
        break;
      }
      case "pedido_pegar": {
        line = "";
        highlight = title;
        avatarInitials = initialsFrom(claimantName ?? actor, "CP");
        const running = asNumber(team.payload.running_count);
        meta = `${running != null ? `ela tem ${running} rodando · ` : ""}${when}`;
        break;
      }
      case "devolucao": {
        line = "";
        highlight = title;
        avatarInitials = initialsFrom(actor, "DV");
        meta = `${quote ? `"${quote}" · ` : ""}${when}`;
        break;
      }
      case "gate_falhou": {
        line = "Gate falhou em";
        avatarInitials = "!";
        const fail = asString(team.payload.gate_summary) ?? "gate falhou";
        meta = `${fail}${actor ? ` · ${actor}` : ""} · ${when}`;
        break;
      }
      case "mencao": {
        line = "";
        highlight = asString(team.payload.ref) ?? title;
        avatarInitials = initialsFrom(actor, "M");
        meta = `${quote ? `"${quote}" · ` : ""}${when}`;
        break;
      }
      case "atribuicao": {
        line = "Atribuída a você:";
        avatarInitials = initialsFrom(asString(team.payload.team_initials) ?? "I", "I");
        const prio = asString(team.payload.priority);
        meta = `${actor || "—"}${prio ? ` · prioridade ${prio}` : ""}`;
        break;
      }
      case "convite": {
        line = "Convite";
        highlight = asString(team.payload.target) ?? title;
        avatarInitials = "C";
        meta = when;
        break;
      }
      default: {
        line = team.kind;
        avatarInitials = team.kind.slice(0, 2).toUpperCase();
        meta = when;
      }
    }

    items.push({
      id: `team:${team.id}`,
      source: "team",
      kind: team.kind,
      title: line,
      highlight,
      meta,
      avatarInitials,
      avatarTone: avatarToneForKind(team.kind),
      createdAt,
      seen: Boolean(team.seenAt),
      teamId: team.teamId,
      taskId: team.taskId,
      boardId: null,
      claimId,
      claimantName,
      actions,
      primaryAction: primary,
    });
  }

  for (const local of input.localItems) {
    const { actions, primary } = actionsForKind("revisar");
    items.push({
      id: `local:${local.boardId}:${local.taskId}`,
      source: "local",
      kind: "revisar",
      title: "Revisar",
      highlight: local.title.trim() || "(sem título)",
      meta: `agente da sessão ${local.boardName} · ${formatRelative(local.updatedAt, now)}`,
      avatarInitials: "R",
      avatarTone: "warn",
      createdAt: local.updatedAt,
      seen: true,
      teamId: null,
      taskId: local.taskId,
      boardId: local.boardId,
      claimId: null,
      claimantName: null,
      actions,
      primaryAction: primary,
    });
  }

  items.sort((a, b) => b.createdAt - a.createdAt);

  const counts: InboxTabCounts = { all: 0, review: 0, requests: 0, assigned: 0, mentions: 0 };
  for (const item of items) {
    counts.all += 1;
    const tab = tabForKind(item.kind);
    if (tab && tab !== "all") counts[tab] += 1;
  }

  return { items, counts };
}

export function filterInboxByTab(items: AggregatedInboxItem[], tab: InboxTab): AggregatedInboxItem[] {
  if (tab === "all") return items;
  return items.filter((item) => tabForKind(item.kind) === tab);
}

/** Exponential backoff for SSE reconnect: 1s → 2s → … capped at 30s. */
export function sseReconnectDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(30_000, 1000 * 2 ** n);
}

export function shouldShowSystemNotification(prefs: NotificationPrefs, kind: "system" | "in_app" = "system"): boolean {
  if (kind === "in_app") return prefs.inApp;
  return prefs.system;
}

/**
 * Incremental SSE parser. Feed raw chunks; completed events are returned and
 * removed from the carry buffer. Used so a reconnect with Last-Event-ID can be
 * unit-tested without a live socket.
 */
export function parseSseBuffer(carry: string, chunk: string): { events: SseEvent[]; rest: string } {
  const text = carry + chunk;
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: SseEvent[] = [];
  for (const block of parts) {
    if (!block.trim() || block.startsWith(":")) continue;
    let id: number | null = null;
    let name = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) {
        const n = Number(line.slice(3).trim());
        id = Number.isFinite(n) ? n : null;
      } else if (line.startsWith("event:")) {
        name = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    events.push({ id, name, data: dataLines.join("\n") });
  }
  return { events, rest };
}

/** After a disconnect, the next request must send the last fully received id. */
export function nextLastEventId(previous: number | null, events: SseEvent[]): number | null {
  let last = previous;
  for (const event of events) {
    if (event.id != null) last = event.id;
  }
  return last;
}

export function notificationCopy(item: AggregatedInboxItem): { title: string; body: string } {
  const title = item.title ? `${item.title} ${item.highlight}`.trim() : item.highlight;
  return { title: title.slice(0, 120), body: item.meta.slice(0, 180) };
}

export function emptyInboxSnapshot(now = Date.now()): InboxSnapshot {
  return {
    items: [],
    counts: { all: 0, review: 0, requests: 0, assigned: 0, mentions: 0 },
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    offline: false,
    updatedAt: now,
  };
}

/** Offline: keep cached team rows and refresh local awaiting_review. */
export function mergeOfflineSnapshot(cached: InboxSnapshot, localItems: LocalAwaitingItem[], now: number): InboxSnapshot {
  const localAgg = aggregateInboxItems({ teamItems: [], localItems, now });
  const teamRows = cached.items.filter((i) => i.source === "team");
  const items = [...teamRows, ...localAgg.items].sort((a, b) => b.createdAt - a.createdAt);
  const counts: InboxTabCounts = { all: 0, review: 0, requests: 0, assigned: 0, mentions: 0 };
  for (const item of items) {
    counts.all += 1;
    const tab = tabForKind(item.kind);
    if (tab && tab !== "all") counts[tab] += 1;
  }
  return { items, counts, prefs: cached.prefs, offline: true, updatedAt: now };
}

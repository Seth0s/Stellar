import { describe, expect, it } from "vitest";
import {
  aggregateInboxItems,
  filterInboxByTab,
  mergeOfflineSnapshot,
  nextLastEventId,
  parseInboxListResponse,
  parseNotificationPrefs,
  parseSseBuffer,
  shouldShowSystemNotification,
  sseReconnectDelayMs,
  type TeamInboxItem,
} from "../../src/main/inbox-decision";

const UUID = {
  a: "11111111-1111-1111-1111-111111111111",
  b: "22222222-2222-2222-2222-222222222222",
  t: "33333333-3333-3333-3333-333333333333",
  i: "44444444-4444-4444-4444-444444444444",
};

function teamItem(overrides: Partial<TeamInboxItem> & { kind: TeamInboxItem["kind"] }): TeamInboxItem {
  return {
    id: overrides.id ?? UUID.i,
    kind: overrides.kind,
    reference: overrides.reference ?? "#58",
    teamId: overrides.teamId ?? UUID.t,
    taskId: overrides.taskId ?? UUID.a,
    payload: overrides.payload ?? { title: "Lista de membros", actor_name: "Bruno" },
    createdAt: overrides.createdAt ?? "2026-10-11T12:00:00Z",
    seenAt: overrides.seenAt ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
  };
}

describe("inbox aggregation", () => {
  it("merges team items with local awaiting_review and counts tabs", () => {
    const { items, counts } = aggregateInboxItems({
      now: Date.parse("2026-10-11T13:00:00Z"),
      teamItems: [
        teamItem({ kind: "revisar", id: UUID.a }),
        teamItem({
          kind: "pedido_pegar",
          id: UUID.b,
          payload: { title: "Exportar", claimant_name: "Carla", claim_id: UUID.i, running_count: 3 },
        }),
        teamItem({ kind: "atribuicao", id: UUID.t, payload: { title: "Lentidão", actor_name: "Ana", priority: "alta" } }),
        teamItem({ kind: "mencao", id: UUID.i, payload: { ref: "#58", actor_name: "Ana", quote: "teto?" } }),
        teamItem({
          kind: "devolucao",
          id: "55555555-5555-5555-5555-555555555555",
          payload: { title: "Ícones", actor_name: "Bruno", reason: "design" },
        }),
        teamItem({
          kind: "gate_falhou",
          id: "66666666-6666-6666-6666-666666666666",
          payload: { title: "Turmas", gate_summary: "npm test: 2 falhas", actor_name: "Ana" },
        }),
      ],
      localItems: [
        {
          boardId: "board-1",
          boardName: "Maestro",
          taskId: "local-task",
          title: "Fechar oráculo de blob",
          updatedAt: Date.parse("2026-10-11T11:00:00Z"),
        },
      ],
    });

    expect(counts.all).toBe(7);
    expect(counts.review).toBe(2);
    expect(counts.requests).toBe(2);
    expect(counts.assigned).toBe(1);
    expect(counts.mentions).toBe(1);
    expect(items.some((i) => i.source === "local" && i.highlight.includes("oráculo"))).toBe(true);
    expect(filterInboxByTab(items, "review")).toHaveLength(2);
    expect(filterInboxByTab(items, "requests")).toHaveLength(2);
  });

  it("parses inbox list and prefs from the B8 JSON shape", () => {
    const list = parseInboxListResponse({
      items: [
        {
          id: UUID.a,
          kind: "revisar",
          reference: "ref",
          team_id: UUID.t,
          task_id: UUID.b,
          payload: { title: "X" },
          created_at: "2026-10-11T12:00:00Z",
          seen_at: null,
          resolved_at: null,
        },
        {
          id: UUID.b,
          kind: "revisar",
          reference: "done",
          team_id: UUID.t,
          task_id: UUID.a,
          payload: {},
          created_at: "2026-10-11T12:00:00Z",
          seen_at: null,
          resolved_at: "2026-10-11T12:30:00Z",
        },
      ],
    });
    expect(list?.items).toHaveLength(1);
    expect(parseNotificationPrefs({ in_app: true, system: false, daily_digest: true })).toEqual({
      inApp: true,
      system: false,
      dailyDigest: true,
    });
  });
});

describe("SSE reconnect", () => {
  it("keeps Last-Event-ID across chunked frames so a reconnect does not drop events", () => {
    const first = parseSseBuffer("", "id: 10\nevent: inbox\ndata: {\"type\":\"inbox\"}\n\n");
    expect(first.events).toHaveLength(1);
    let last = nextLastEventId(null, first.events);
    expect(last).toBe(10);

    // Split frame across two TCP chunks — the id must not be lost.
    const mid = parseSseBuffer("", "id: 11\nevent: task\ndata: {\"n\":1}");
    expect(mid.events).toHaveLength(0);
    const end = parseSseBuffer(mid.rest, "\n\nid: 12\nevent: inbox\ndata: {}\n\n");
    expect(end.events.map((e) => e.id)).toEqual([11, 12]);
    last = nextLastEventId(last, end.events);
    expect(last).toBe(12);
  });

  it("backs off exponentially and caps at 30s", () => {
    expect(sseReconnectDelayMs(0)).toBe(1000);
    expect(sseReconnectDelayMs(1)).toBe(2000);
    expect(sseReconnectDelayMs(2)).toBe(4000);
    expect(sseReconnectDelayMs(10)).toBe(30_000);
  });
});

describe("notification prefs", () => {
  it("respects the system flag for Electron notifications", () => {
    expect(shouldShowSystemNotification({ inApp: true, system: true, dailyDigest: false })).toBe(true);
    expect(shouldShowSystemNotification({ inApp: true, system: false, dailyDigest: true })).toBe(false);
    expect(shouldShowSystemNotification({ inApp: false, system: true, dailyDigest: false }, "in_app")).toBe(false);
  });

  it("keeps the last team rows when offline and refreshes local awaiting", () => {
    const cached = {
      items: [
        {
          id: "team:x",
          source: "team" as const,
          kind: "revisar" as const,
          title: "Revisar",
          highlight: "Cached",
          meta: "há 1 h",
          avatarInitials: "R",
          avatarTone: "warn" as const,
          createdAt: 1,
          seen: false,
          teamId: UUID.t,
          taskId: UUID.a,
          boardId: null,
          claimId: null,
          claimantName: null,
          actions: ["open" as const, "review_now" as const],
          primaryAction: "review_now" as const,
        },
      ],
      counts: { all: 1, review: 1, requests: 0, assigned: 0, mentions: 0 },
      prefs: { inApp: true, system: false, dailyDigest: false },
      offline: false,
      updatedAt: 1,
    };
    const merged = mergeOfflineSnapshot(
      cached,
      [{ boardId: "b", boardName: "S", taskId: "l", title: "Local", updatedAt: 2 }],
      3,
    );
    expect(merged.offline).toBe(true);
    expect(merged.prefs.system).toBe(false);
    expect(merged.items).toHaveLength(2);
    expect(merged.counts.all).toBe(2);
    expect(merged.counts.review).toBe(2);
  });
});

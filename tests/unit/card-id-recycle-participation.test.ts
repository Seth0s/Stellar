import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type CardRow, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * 2026-09-13 — card id recycle + task_cards history stamped as live role.
 * Measured in production: card 478 died on ec01dc40, id reused, new card
 * reported, and the report landed as a participation round on the old
 * (already done) task with role `implementer` with confidence.
 *
 * Two guards, both required:
 * 1. `nextIdSeed` never reissues an id still named by task_cards /
 *    verdicts / reports / tasks.card_id (short ids stay short, they just
 *    never come back).
 * 2. Live participation ignores links whose task is already done/failed,
 *    so even a forced same-id rebirth cannot stamp the dead task.
 */

function baseCard(id: string): CardRow {
  return {
    id,
    board_id: "default",
    kind: "terminal",
    provider: "cursor",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: Date.now(),
    messages_json: null,
    archived_at: null,
  };
}

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "work",
    provider: "cursor",
    status: "running",
    card_id: null,
    board_id: "default",
    cwd: null,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as TaskRow;
}

function callbacksBackedByStore(store: ReturnType<typeof openStore>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
        if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
        if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
        if (prop === "listTaskCardsForCard") return (cardId: string) => store.listTaskCardsForCard(cardId);
        if (prop === "recordParticipationRound")
          return (cardId: string, verdict: string | null, at: number) => store.recordParticipationRound(cardId, verdict, at);
        if (prop === "listTasks") return () => store.listTasks();
        if (prop === "upsertTask") return (row: TaskRow) => store.upsertTask(row);
        if (prop === "listAllConnectors") return () => [];
        if (prop === "listCards") return () => [];
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("card id recycle vs live participation (store real)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("nextIdSeed does not reuse a deleted card id still referenced by task_cards", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-id-seed-"));
    store = openStore(dir);
    store.upsertCard(baseCard("10"));
    store.upsertTask(baseTask("t-old", { card_id: "10", status: "done" }));
    // Close path for non-chat cards: hard delete. History stays in task_cards.
    store.deleteCard("10");
    expect(store.getCard("10")).toBeUndefined();
    expect(store.listTaskCardsForCardHistory("10")).toEqual([
      { task_id: "t-old", card_id: "10", role: "implementer" },
    ]);

    // Without the historical union, MAX(cards) would be null/0 and the
    // next spawn would reissue "10". Seed must stay at least 10.
    expect(store.nextIdSeed()).toBeGreaterThanOrEqual(10);
  });

  it("card closes, same id is forced back, new card reports → old done task gets NO new verdict; new running task does", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-id-recycle-"));
    store = openStore(dir);
    bus = createMessageBus(join(dir, "recycle.sock"), callbacksBackedByStore(store));

    store.upsertCard(baseCard("478"));
    store.upsertTask(baseTask("ec01-old", { card_id: "478", status: "running" }));
    // First incarnation participates, then the task completes (measured:
    // ec01dc40 → done at 16:26 while task_cards kept the row).
    store.recordParticipationRound("478", null, 1_000);
    store.upsertTask(baseTask("ec01-old", { card_id: "478", status: "done", updated_at: Date.now() }));

    store.deleteCard("478");
    // Force the pre-fix recycle: same short id reborn as a new card,
    // linked to a DIFFERENT live task (d1074fc2 class).
    store.upsertCard(baseCard("478"));
    store.upsertTask(baseTask("d107-new", { card_id: "478", status: "running" }));

    // History still names both; live view must only see the running one.
    expect(store.listTaskCardsForCardHistory("478").map((l) => l.task_id).sort()).toEqual(["d107-new", "ec01-old"]);
    expect(store.listTaskCardsForCard("478")).toEqual([{ task_id: "d107-new", card_id: "478", role: "implementer" }]);

    const beforeOld = store.getTaskVerdicts("ec01-old").length;
    const res = (await bus.handleRequest({
      cmd: "report",
      requesterId: "478",
      report: { ok: true },
      verdict: "aprovado",
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);

    expect(store.getReport("478")?.role).toBe("implementer");
    expect(store.getTaskVerdicts("ec01-old")).toHaveLength(beforeOld);
    expect(store.getTaskVerdicts("d107-new").map((v) => [v.role, v.verdict])).toEqual([["implementer", "aprovado"]]);
  });

  it("recordParticipationRound alone ignores a done-task link even when it is the only link (resolveReporterRole would have trusted it)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-id-stale-only-"));
    store = openStore(dir);
    store.upsertTask(baseTask("dead", { card_id: "99", status: "done" }));
    expect(store.listTaskCardsForCardHistory("99")).toHaveLength(1);
    expect(store.listTaskCardsForCard("99")).toEqual([]);
    expect(store.recordParticipationRound("99", "aprovado", Date.now())).toEqual([]);
    expect(store.getTaskVerdicts("dead")).toEqual([]);
  });
});

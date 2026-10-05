import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * The report NOTICE and the gate CONTRADICTION through the REAL path: a real
 * store, a real bus, a real gate (node).
 *
 * What these tests pin:
 *   - one notice per report: with gates, the "report available" waits for the
 *     result and carries "gates N/M" on the SAME line;
 *   - the standalone "gates measured by the app" message no longer exists;
 *   - the contradiction (report ok:true + red gate) becomes the ONLY
 *     self-standing message, with the task short id, the command, the mode and
 *     the trailing output.
 */

const GATES_GREEN = [
  `node -e ${JSON.stringify("process.stdout.write('G1');process.exit(0)")}`,
  `node -e ${JSON.stringify("process.stdout.write('G2');process.exit(0)")}`,
];

const GATES_RED = [
  `node -e ${JSON.stringify("process.stdout.write('G1');process.exit(0)")}`,
  `node -e ${JSON.stringify("process.stdout.write('BOOM-LINE');process.exit(1)")}`,
];

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    status: "running",
    card_id: `card-${id}`,
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

type Written = Array<[string, string]>;

function makeCallbacks(
  store: ReturnType<typeof openStore>,
  written: Written,
  opts: { boardCwd: string; resolveRead: (requestId: string) => void },
): Parameters<typeof createMessageBus>[1] {
  const target: Record<string, unknown> = {
    onReadCardRequest: (requestId: string) => opts.resolveRead(requestId),
    getReport: (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq),
    upsertReport: (row: ReportRow) => store.upsertReport(row),
    nextReportSeqSeed: () => store.nextReportSeqSeed(),
    listTaskCardsForCard: (cardId: string) => store.listTaskCardsForCard(cardId),
    getTaskCards: (taskId: string) => store.getTaskCards(taskId),
    recordParticipationRound: (cardId: string, verdict: string | null, at: number) =>
      store.recordParticipationRound(cardId, verdict, at),
    listTasks: () => store.listTasks(),
    listTasksByBoard: (boardId: string) => store.listTasksByBoard(boardId),
    getTask: (id: string) => store.getTask(id),
    upsertTask: (row: TaskRow) => store.upsertTask(row),
    isCardAlive: () => true,
    listCards: () => [{ id: "orch-1", kind: "terminal", label: "MASTER" }],
    describeCardLabel: (id: string) => `card ${id}`,
    getCardBoardId: () => "default",
    getBoardOrchestratorCardId: () => "orch-1",
    getBoardCwd: () => opts.boardCwd,
    listAllConnectors: () => [],
    findSpawnByChild: () => undefined,
    listSpawnsByParent: () => [],
    recordSpawn: () => ({ id: "spawn-stub" }),
    writeToCard: (id: string, text: string) => written.push([id, text]),
    getCardWriteReadiness: () => ({
      spawnedAtMs: Date.now() - 1_000,
      hasReceivedData: true,
      lastActivityAtMs: Date.now() - 1_000,
      hasPendingHumanInput: false,
      inputLineLastAtMs: null,
    }),
    getCardLastActivityAt: () => Date.now(),
    beginCardDelivery: () => true,
    endCardDelivery: () => undefined,
  };
  return new Proxy(target, {
    get: (t, prop: string) => (prop in t ? (t as Record<string, unknown>)[prop] : () => undefined),
    getOwnPropertyDescriptor: (t, prop: string) =>
      prop in t ? { configurable: true, enumerable: true, value: (t as Record<string, unknown>)[prop] } : undefined,
  }) as unknown as Parameters<typeof createMessageBus>[1];
}

async function waitForBody(written: Written, needle: string, timeoutMs = 15_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = written.find(([, text]) => text.includes(needle));
    if (hit) return hit[1];
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe("message-bus: aviso de report com gate e contradição (board 64)", () => {
  let dir: string;
  let workDir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  });

  function setup(written: Written) {
    dir = mkdtempSync(join(tmpdir(), "stellar-gate-notice-"));
    workDir = mkdtempSync(join(tmpdir(), "stellar-gate-notice-work-"));
    store = openStore(dir);
    bus = createMessageBus(
      join(dir, "a.sock"),
      makeCallbacks(store, written, {
        boardCwd: tmpdir(),
        resolveRead: (requestId) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
      }),
    );
    return store;
  }

  it("gates VERDES: um aviso só, com 'gates 2/2' e o id curto da task — nada de 'gates measured by the app'", async () => {
    const written: Written = [];
    const s = setup(written);
    const id = "d00a03fa-1111-2222-3333-444444444444";
    s.upsertTask(baseTask(id, { cwd: workDir, gates_json: JSON.stringify(GATES_GREEN) }));

    await bus!.handleRequest({
      cmd: "report",
      requesterId: `card-${id}`,
      report: { ok: true, taskId: id },
    } as BusRequest);

    const body = await waitForBody(written, "gates 2/2");
    expect(body).not.toBeNull();
    expect(body!).toContain("report available");
    expect(body!).toContain("d00a03fa");
    expect(body!).toContain("gates 2/2");
    // ONE notice only: no duplicated "report available" line, and the old
    // standalone notice no longer exists.
    const notices = written.filter(([, text]) => text.includes("report available"));
    expect(notices).toHaveLength(1);
    expect(written.some(([, text]) => text.includes("gates measured by the app"))).toBe(false);
  }, 40_000);

  it("CONTRADIÇÃO: report ok:true + gate vermelho → mensagem própria com id, comando, modo e saída final", async () => {
    const written: Written = [];
    const s = setup(written);
    const id = "d00a03fa-aaaa-bbbb-cccc-dddddddddddd";
    s.upsertTask(baseTask(id, { cwd: workDir, gates_json: JSON.stringify(GATES_RED) }));

    await bus!.handleRequest({
      cmd: "report",
      requesterId: `card-${id}`,
      report: { ok: true, taskId: id },
    } as BusRequest);

    const body = await waitForBody(written, "gate contradiction");
    expect(body).not.toBeNull();
    expect(body!).toContain("d00a03fa");
    expect(body!).toContain("SUCCESS (ok:true)");
    expect(body!).toContain("failed:");
    expect(body!).toContain("shared tree");
    expect(body!).toContain("BOOM-LINE");
    // The contradiction REPLACES the report notice: no "report available".
    expect(written.some(([, text]) => text.includes("report available"))).toBe(false);
  }, 40_000);

  it("report SEM gates: o aviso sai como sempre (sem sufixo de gate)", async () => {
    const written: Written = [];
    const s = setup(written);
    const id = "d00a03fa-9999-8888-7777-666666666666";
    s.upsertTask(baseTask(id, { cwd: workDir }));

    const res = (await bus!.handleRequest({
      cmd: "report",
      requesterId: `card-${id}`,
      report: { ok: true, taskId: id },
    } as BusRequest)) as { ok: boolean };
    expect(res.ok).toBe(true);

    const body = await waitForBody(written, "report available");
    expect(body).not.toBeNull();
    expect(body!).toContain("d00a03fa");
    expect(body!).not.toContain("gates");
  }, 40_000);
});

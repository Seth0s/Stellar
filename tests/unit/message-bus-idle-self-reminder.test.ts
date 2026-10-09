import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus } from "../../src/main/message-bus";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";
import { providerCapacity } from "../../src/main/providers";
import { readScreenTurnState } from "../../src/main/screen-turn-state";
import { SELF_REMINDER_ESCALATE_MS, SELF_REMINDER_FLOOR_MS } from "../../src/main/idle-self-reminder-decision";
import { selfReportReminderBody, unreportedIdlePointerBody } from "../../src/main/agent-facing-authorship";

/**
 * The REAL path of the turn-end reminder read from the SCREEN: a commandcode
 * card that repaints forever (the byte clock never ages), whose screen shows
 * `✻ Worked for …` with no spinner, linked to a task, with no report.
 *
 *   1. past the floor -> ONE message to the card ITSELF;
 *   2. one more interval with no report -> ONE notice to the orchestrator;
 *   3. no loop — even though delivering the reminder renews the "work granted"
 *      anchor of the episode, which must NOT open a new episode.
 *
 * The clock is a fake `Date` (only it): the real registry renews the anchor with
 * `Date.now()` on write, and the double here does the same.
 */
const sample = (name: string) => readFileSync(join(__dirname, "fixtures", "screen-turn", name), "utf8");
const ENDED = sample("commandcode-ended.txt");
const WORKING = sample("commandcode-working.txt");

const REMINDER = selfReportReminderBody("task-1");
const ORCH_POINTER = `[de: worker] ${unreportedIdlePointerBody()}`;

type Callbacks = Parameters<typeof createMessageBus>[1];

describe("message-bus: lembrete ao próprio card pelo fim de turno na tela", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  const T0 = new Date("2026-10-07T12:00:00Z").getTime();

  beforeAll(() => {
    loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-self-reminder-")));
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    bus?.close();
    bus = null;
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: {
    screen: () => string;
    workerProvider?: string;
    linked?: boolean;
    reportedAt?: () => number | null;
  }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-bus-self-reminder-"));
    const written: Array<[string, string]> = [];
    let workGrantedAt = T0 - 5 * 60_000;
    const provider = opts.workerProvider ?? "commandcode";
    const linked = opts.linked ?? true;
    const cbs = {
      listCards: () => [
        { id: "spawner-1", kind: "terminal", provider: "claude", cwd: "", label: "MASTER", displayName: "MASTER" },
        { id: "worker-1", kind: "terminal", provider, cwd: "", label: "worker", displayName: "worker" },
      ],
      writeToCard: (id: string, data: string) => {
        written.push([id, data]);
        // The registry renews the work-granted anchor on every delivery write.
        if (id === "worker-1") workGrantedAt = Date.now();
      },
      isCardAlive: (id: string) => id === "spawner-1" || id === "worker-1",
      // The TUI repaints: output right now, ALWAYS. The byte clock sees nothing.
      getCardLastActivityAt: () => Date.now(),
      getCardTurnEndedAt: () => null,
      getCardLastWorkGrantedAt: (id: string) => (id === "worker-1" ? workGrantedAt : Date.now()),
      // The registry keeps the state latched per chunk; the double reads the real
      // screen (fixture samples) with the SAME reader and the provider's live declaration.
      getCardScreenTurnState: (id: string) =>
        id === "worker-1" ? readScreenTurnState(opts.screen(), providerCapacity(provider)?.delivery.screenTurn) : "unknown",
      getCardWriteReadiness: () => ({
        spawnedAtMs: T0 - 600_000,
        hasReceivedData: true,
        lastActivityAtMs: Date.now(),
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
      }),
      beginCardDelivery: () => true,
      onReadCardRequest: ((requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" })) as never,
      describeCardLabel: ((id: string) => (id === "worker-1" ? "worker" : id === "spawner-1" ? "MASTER" : id)) as never,
      listAllConnectors: (() => [
        { kind: "spawned", from_card_id: "spawner-1", to_card_id: "worker-1", updated_at: T0 },
      ]) as never,
      getReport: (() => {
        const at = opts.reportedAt?.() ?? null;
        return at === null ? undefined : { card_id: "worker-1", seq: 1, report_json: "{}", updated_at: at };
      }) as never,
      nextReportSeqSeed: (() => 0) as never,
      listTaskCardsForCard: (() => []) as never,
      listTasksForIdleScan: (() =>
        linked ? [{ id: "task-1", card_id: "worker-1", status: "pending" }] : []) as never,
      listTasks: (() => (linked ? [{ id: "task-1", card_id: "worker-1", status: "pending" }] : [])) as never,
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(cbs, {
        get: (target, prop: string) => (target as Record<string, unknown>)[prop] ?? (() => undefined),
      }) as unknown as Callbacks,
    );
    return { bus: bus!, written, advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
  }

  /** Text typed into each card — without Enter / composer clears (control bytes only). */
  const isText = (data: string) => !/^[\x00-\x1f\x7f]*$/.test(data);
  const typedTo = (written: Array<[string, string]>, id: string) =>
    written.filter(([to, data]) => to === id && isText(data)).map(([, data]) => data);

  async function settle(): Promise<void> {
    // Delivery is asynchronous (FIFO + confirmation); the fake Date does not stop real timers.
    await new Promise((r) => setTimeout(r, 400));
  }

  it("lembrete ao card após o piso, depois UM aviso ao orquestrador, cada um uma vez (sem loop)", async () => {
    const { bus: b, written, advance } = setup({ screen: () => ENDED });

    b.scanIdleWithoutReport(); // first time the turn end is seen
    await settle();
    expect(typedTo(written, "worker-1")).toHaveLength(0);

    advance(SELF_REMINDER_FLOOR_MS + 1_000);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "worker-1")).toEqual([REMINDER]);
    expect(typedTo(written, "spawner-1")).toHaveLength(0); // the orchestrator is not bothered yet

    // Delivering the reminder renewed the work-granted anchor (the episode anchor):
    // later scans must neither remind again nor warn early.
    for (let i = 0; i < 5; i++) {
      advance(5_000);
      b.scanIdleWithoutReport();
    }
    await settle();
    expect(typedTo(written, "worker-1")).toEqual([REMINDER]);
    expect(typedTo(written, "spawner-1")).toHaveLength(0);

    advance(SELF_REMINDER_ESCALATE_MS + 1_000);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "spawner-1")).toHaveLength(1);
    expect(typedTo(written, "spawner-1")[0]).toContain(ORCH_POINTER);

    // Much later: nothing more, for either of them.
    for (let i = 0; i < 10; i++) {
      advance(60_000);
      b.scanIdleWithoutReport();
    }
    await settle();
    expect(typedTo(written, "worker-1")).toEqual([REMINDER]);
    expect(typedTo(written, "spawner-1")).toHaveLength(1);
    expect(typedTo(written, "spawner-1")[0]).toContain(ORCH_POINTER);
  });

  it("se o card reporta depois do lembrete, o orquestrador nunca é avisado", async () => {
    let reportedAt: number | null = null;
    const { bus: b, written, advance } = setup({ screen: () => ENDED, reportedAt: () => reportedAt });
    b.scanIdleWithoutReport();
    advance(SELF_REMINDER_FLOOR_MS + 1_000);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "worker-1")).toEqual([REMINDER]);

    advance(10_000);
    reportedAt = Date.now(); // the card called report after the reminder
    advance(SELF_REMINDER_ESCALATE_MS + 5_000);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "spawner-1")).toHaveLength(0);
  });

  it("turno em andamento (spinner na tela) nunca é cutucado", async () => {
    const { bus: b, written, advance } = setup({ screen: () => WORKING });
    for (let i = 0; i < 6; i++) {
      b.scanIdleWithoutReport();
      advance(30_000);
    }
    await settle();
    expect(written.filter(([, d]) => isText(d))).toHaveLength(0);
  });

  it("o card volta a trabalhar antes do piso: o relógio de ocioso reinicia", async () => {
    let screen = ENDED;
    const { bus: b, written, advance } = setup({ screen: () => screen });
    b.scanIdleWithoutReport();
    advance(SELF_REMINDER_FLOOR_MS - 5_000);
    screen = WORKING;
    b.scanIdleWithoutReport(); // back to work
    advance(10_000);
    screen = ENDED;
    b.scanIdleWithoutReport(); // idle again: the floor counts from here
    advance(SELF_REMINDER_FLOOR_MS - 5_000);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "worker-1")).toHaveLength(0);
    advance(10_000);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "worker-1")).toEqual([REMINDER]);
  });

  it("card sem task ligada não recebe lembrete", async () => {
    const { bus: b, written, advance } = setup({ screen: () => ENDED, linked: false });
    b.scanIdleWithoutReport();
    advance(SELF_REMINDER_ESCALATE_MS * 3);
    b.scanIdleWithoutReport();
    await settle();
    expect(written.filter(([, d]) => isText(d))).toHaveLength(0);
  });

  it("card bash vazio (shell) nunca recebe texto digitado", async () => {
    const { bus: b, written, advance } = setup({ screen: () => ENDED, workerProvider: "bash" });
    b.scanIdleWithoutReport();
    advance(SELF_REMINDER_ESCALATE_MS * 3);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "worker-1")).toHaveLength(0);
  });

  it("quem já reportou NO EPISÓDIO não é cutucado", async () => {
    const { bus: b, written, advance } = setup({ screen: () => ENDED, reportedAt: () => T0 - 1_000 });
    b.scanIdleWithoutReport();
    advance(SELF_REMINDER_ESCALATE_MS * 3);
    b.scanIdleWithoutReport();
    await settle();
    expect(written.filter(([, d]) => isText(d))).toHaveLength(0);
  });

  it("provider sem padrão de tela medido (cursor) não é lembrado pela tela", async () => {
    const { bus: b, written, advance } = setup({ screen: () => ENDED, workerProvider: "cursor" });
    b.scanIdleWithoutReport();
    advance(SELF_REMINDER_ESCALATE_MS * 3);
    b.scanIdleWithoutReport();
    await settle();
    expect(typedTo(written, "worker-1")).toHaveLength(0);
  });
});

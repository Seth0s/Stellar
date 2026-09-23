import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * `link_task_card` — role writer for a card that ALREADY exists (the
 * "reuse a live card as reviewer" pattern). Sister of spawn_agent's `role`.
 * Fixed here:
 *  - reviewer → `linkTaskCard` only, `card_id` untouched;
 *  - implementer (default when omitted) → becomes principal `card_id`
 *    (upsertTask, status not proposed) AND explicit role row;
 *  - refusals happen before any write: unknown task, card not open,
 *    unknown role, principal card asked to become reviewer.
 *
 * Task 618d179a added the second half: the handler now also DELIVERS a short
 * notice to the linked card. It used to write the role and return, so reusing
 * a live card only worked if the orchestrator typed the whole message by hand.
 * The notice is a POINTER — id, role, "read it with get_task" — never the task
 * statement (repeating it would just move who duplicates), and it goes through
 * the SAME queue `spawn_agent`/report already use. Covered below: role-aware
 * wording, no repeat on a same-role re-link, notice on a role CHANGE, skip
 * (with a stated reason) for a card with no reader, and the queued
 * (non-blocking) shape of the delivery.
 */
function applied(status: string): StatusWriteDecision {
  return { status, statusChanged: true, divergedStatus: null, divergedActor: null, recordDeclaration: false, warnAgent: false, declaredStatus: null };
}

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t-link",
    prompt: "work",
    provider: "claude",
    status: "running",
    card_id: "impl",
    board_id: "b1",
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
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

type CardStub = { id: string; kind: string; provider: string; cwd: string; label: string | null };
type LinkStub = { task_id: string; card_id: string; role: string };

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    { get: (_target, prop: string) => overrides[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: link_task_card", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** `deliverCard` resolves its pre-write screen read through `resolveReadCard`;
   * the flush covers body → SEND_ENTER_DELAY_MS → Enter → confirm. */
  async function flushDelivery(ms = 400): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  type RunOpts = {
    /** `null` = no such task at all (the default is a normal task). */
    existing?: TaskRow | null;
    openCards?: CardStub[];
    writes?: Array<[string, string]>;
    isCardAlive?: (id: string) => boolean;
    listTaskCardsForCard?: (cardId: string) => LinkStub[];
    describeCardLabel?: (id: string) => string;
  };

  async function run(req: Record<string, unknown>, opts: RunOpts = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-link-task-card-"));
    const existing = opts.existing === undefined ? task() : (opts.existing ?? undefined);
    const openCards: CardStub[] =
      opts.openCards ??
      ["impl", "rev"].map((id) => ({ id, kind: "terminal", provider: "claude", cwd: "", label: null }));
    const upserted: TaskRow[] = [];
    const linked: Array<{ taskId: string; cardId: string; role: string }> = [];
    const writes = opts.writes ?? [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        getTask: (id: string) => (existing && id === existing.id ? existing : undefined),
        listCards: () => openCards,
        upsertTask: (t: TaskRow) => {
          upserted.push(t);
          return applied(t.status);
        },
        linkTaskCard: (taskId: string, cardId: string, role: string) => linked.push({ taskId, cardId, role }),
        // Autorização de papel (05055482): requesterId presente no caminho
        // acbridge é a marca do board — é o fluxo que o teste exercita.
        getBoardOrchestratorCardId: (() => "orch") as never,
        listAllConnectors: () => [],
        recordSpawn: () => ({ id: "spawn-stub" }),
        findSpawnByChild: () => undefined,
        listSpawnsByParent: () => [],
        // Delivery harness — same shape the sibling notify tests use.
        onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: "" }),
        isCardAlive: opts.isCardAlive ?? (() => true),
        listTaskCardsForCard: opts.listTaskCardsForCard ?? (() => []),
        describeCardLabel: opts.describeCardLabel ?? ((id: string) => id),
        writeToCard: (...args: unknown[]) => {
          writes.push(args as [string, string]);
        },
        beginCardDelivery: () => true,
        getCardWriteReadiness: () => ({
          spawnedAtMs: Date.now() - 1_000,
          hasReceivedData: true,
          lastActivityAtMs: Date.now() - 1_000,
          hasPendingHumanInput: false,
          inputLineLastAtMs: null,
        }),
        getCardLastActivityAt: () => Date.now(),
      }),
    );
    const res = (await bus.handleRequest({
      cmd: "link_task_card",
      // Autorização de papel (05055482): o chamador padrão destes testes é a
      // marca do board ("orch") — o que está sob teste aqui é a mecânica do
      // aviso e da escrita, não a autoridade. Chamadas que passam o próprio
      // requesterId (o caminho acbridge abaixo) sobrescrevem isto.
      requesterId: "orch",
      ...req,
    } as BusRequest)) as Record<string, unknown>;
    return { res, upserted, linked, writes };
  }

  function bodies(writes: Array<[string, string]>): Array<[string, string]> {
    return writes.filter(([, data]) => data !== "\r");
  }

  it("reviewer: só a linha de papel; card_id da task não muda", async () => {
    const { res, upserted, linked, writes } = await run({ taskId: "t-link", cardId: "rev", role: "reviewer" });
    await flushDelivery();
    expect(res).toEqual({ ok: true, taskId: "t-link", cardId: "rev", role: "reviewer", notice: "queued" });
    expect(linked).toEqual([{ taskId: "t-link", cardId: "rev", role: "reviewer" }]);
    expect(upserted).toEqual([]);
    expect(bodies(writes).length).toBeGreaterThanOrEqual(1);
  });

  it("implementer (default quando omitido): vira card_id principal via linkImplementerToTask", async () => {
    const { res, upserted, linked } = await run({ taskId: "t-link", cardId: "rev" });
    await flushDelivery();
    expect(res).toEqual({ ok: true, taskId: "t-link", cardId: "rev", role: "implementer", notice: "queued" });
    expect(upserted).toHaveLength(1);
    expect(upserted[0].card_id).toBe("rev");
    expect(upserted[0].status).toBe("pending");
    expect(upserted[0].statusProposed).toBe(true);
    expect(upserted[0].actor).toBe("agent");
    expect(linked).toEqual([{ taskId: "t-link", cardId: "rev", role: "implementer" }]);
  });

  it("role inválido: recusado, nada gravado, nenhum default inventado", async () => {
    const { res, upserted, linked } = await run({ taskId: "t-link", cardId: "rev", role: "observer" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('got "observer"');
    expect(upserted).toEqual([]);
    expect(linked).toEqual([]);
  });

  it("card principal pedido como reviewer: recusado — as duas tabelas não podem discordar do mesmo card", async () => {
    const { res, linked } = await run({ taskId: "t-link", cardId: "impl", role: "reviewer" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("principal card");
    expect(linked).toEqual([]);
  });

  it("task inexistente / card não aberto / campos faltando: recusa antes de escrever", async () => {
    const missingTask = await run({ taskId: "nope", cardId: "rev", role: "reviewer" }, { existing: null });
    expect(missingTask.res).toEqual({ ok: false, error: 'no such task "nope"' });
    expect(missingTask.linked).toEqual([]);

    const closedCard = await run({ taskId: "t-link", cardId: "ghost", role: "reviewer" });
    expect(closedCard.res).toEqual({ ok: false, error: 'no open card with id "ghost"' });
    expect(closedCard.linked).toEqual([]);

    expect((await run({ cardId: "rev" })).res).toEqual({ ok: false, error: "missing taskId" });
    expect((await run({ taskId: "t-link" })).res).toEqual({ ok: false, error: "missing cardId" });
  });

  it("NOVO link como implementer: avisa o card — id, papel e get_task, NUNCA o enunciado", async () => {
    const writes: Array<[string, string]> = [];
    const { res } = await run({ taskId: "t-link", cardId: "rev" }, { writes });
    await flushDelivery();

    expect(res.notice).toBe("queued");
    const [first] = bodies(writes);
    expect(first[0]).toBe("rev");
    expect(first[1]).toContain("t-link"); // o id
    expect(first[1]).toContain("implementer"); // o papel
    expect(first[1]).toContain("get_task"); // como ler o enunciado
    // O enunciado NÃO é repetido — repetir só mudaria quem duplica.
    expect(first[1]).not.toContain("work");
  });

  it("NOVO link como reviewer: aviso DIFERENTE — 'to review', não a ordem de trabalho", async () => {
    const writes: Array<[string, string]> = [];
    await run({ taskId: "t-link", cardId: "rev", role: "reviewer" }, { writes });
    await flushDelivery();

    const [first] = bodies(writes);
    expect(first[1]).toContain("t-link");
    expect(first[1]).toContain("reviewer");
    expect(first[1]).toContain("to review");
    expect(first[1]).toContain("get_task");
    expect(first[1]).not.toContain("work");
  });

  it("RE-LINK com o MESMO papel: não avisa de novo — repetição não é informação nova", async () => {
    const writes: Array<[string, string]> = [];
    const { res } = await run(
      { taskId: "t-link", cardId: "rev" },
      { writes, listTaskCardsForCard: () => [{ task_id: "t-link", card_id: "rev", role: "implementer" }] },
    );
    await flushDelivery();

    expect(res.ok).toBe(true);
    expect(String(res.notice)).toContain("already linked as implementer");
    expect(writes).toHaveLength(0);
  });

  it("TROCAR de papel (implementer → reviewer): isso É fato novo e avisa", async () => {
    const writes: Array<[string, string]> = [];
    const { res } = await run(
      { taskId: "t-link", cardId: "rev", role: "reviewer" },
      { writes, listTaskCardsForCard: () => [{ task_id: "t-link", card_id: "rev", role: "implementer" }] },
    );
    await flushDelivery();

    expect(res.notice).toBe("queued");
    const [first] = bodies(writes);
    expect(first[1]).toContain("to review");
  });

  it("card sem leitor (não-terminal): o linkage vale, o aviso é pulado COM MOTIVO", async () => {
    const writes: Array<[string, string]> = [];
    const { res, linked } = await run(
      { taskId: "t-link", cardId: "c-chat", role: "reviewer" },
      { openCards: [{ id: "c-chat", kind: "chat", provider: "", cwd: "", label: null }], writes },
    );
    await flushDelivery();

    expect(res.ok).toBe(true); // o VÍNCULO não é derrubado pelo aviso
    expect(String(res.notice)).toContain("not a terminal");
    expect(linked).toEqual([{ taskId: "t-link", cardId: "c-chat", role: "reviewer" }]);
    expect(writes).toHaveLength(0);
  });

  it("card sem terminal vivo: linkage vale, aviso pulado com outro motivo", async () => {
    const writes: Array<[string, string]> = [];
    const { res } = await run({ taskId: "t-link", cardId: "rev" }, { writes, isCardAlive: () => false });
    await flushDelivery();

    expect(res.ok).toBe(true);
    expect(String(res.notice)).toContain("no live terminal");
    expect(writes).toHaveLength(0);
  });

  it("a entrega é ASSÍNCRONA (fila): o link responde ANTES de o aviso ser digitado", async () => {
    const writes: Array<[string, string]> = [];
    const { res } = await run({ taskId: "t-link", cardId: "rev" }, { writes });

    // Nada escrito ainda: o handler não bloqueia num turno — o aviso entra na
    // fila e é digitado quando o card volta a aceitar escrita.
    expect(res.notice).toBe("queued");
    expect(writes).toHaveLength(0);

    await flushDelivery();
    expect(bodies(writes).length).toBeGreaterThanOrEqual(1);
  });

  it("caminho do acbridge (requesterId presente): o aviso sai e leva o autor", async () => {
    const writes: Array<[string, string]> = [];
    const { res } = await run(
      { taskId: "t-link", cardId: "rev", role: "reviewer", requesterId: "orch" },
      { writes, describeCardLabel: (id: string) => (id === "orch" ? "Orquestrador" : id) },
    );
    await flushDelivery();

    expect(res.notice).toBe("queued");
    const [first] = bodies(writes);
    expect(first[1].startsWith("[de: Orquestrador]")).toBe(true);
    expect(first[1]).toContain("get_task");
  });
});

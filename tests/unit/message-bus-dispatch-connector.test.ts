import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus } from "../../src/main/message-bus";
import type { TaskRow, TaskTransitionRow } from "../../src/main/store";

/**
 * DEFEITO MEDIDO (2026-10-04, board 64): uma task com `deps` despachada
 * sozinha (a dep virou `done`) nasce SOLTA no board — nenhum conector.
 * O card que o orquestrador abre à mão com `spawn_agent` nasce com a seta
 * saindo dele; o auto-despacho precisa da MESMA ligação (contrato do dono
 * de 2026-09-14: a marca do orquestrador é a origem da cadeia).
 *
 * Origem, em ordem de precedência:
 *   1. o card marcado como orquestrador do board (`orchestrator_card_id`),
 *      se estiver VIVO;
 *   2. senão, o card que CRIOU a task (card_id da primeira transição
 *      `pending`), se estiver VIVO;
 *   3. senão, NENHUM conector — nunca se inventa origem.
 */

function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t",
    prompt: "fase 2",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    spawn_profile: null,
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

function pendingTransition(cardId: string | null): TaskTransitionRow {
  return {
    id: "tr-pending",
    task_id: "child",
    kind: "status",
    from_value: null,
    to_value: "pending",
    actor: "agent",
    card_id: cardId,
    at: 1,
  };
}

type ConnectorCall = { from: string; to: string; kind: string; label?: string | null };

function buildRig(
  dir: string,
  input: {
    orchestratorCardId: string | null;
    creatorCardId: string | null;
    alive: Record<string, boolean>;
    newCardId: string;
  },
) {
  let bus: ReturnType<typeof createMessageBus> | null = null;
  const connectors: ConnectorCall[] = [];
  const dep = baseTask({ id: "dep-done", status: "done", prompt: "fase 1", cwd: "/tmp/wt" });
  const child = baseTask({
    id: "child",
    status: "pending",
    prompt: "fase 2",
    deps_json: JSON.stringify(["dep-done"]),
  });
  const childWithTransitions: TaskRow = {
    ...child,
    transitions: [pendingTransition(input.creatorCardId)],
  };

  const callbacks = new Proxy(
    {
      listTasks: () => [dep, child],
      getTask: (id: string) => (id === "child" ? childWithTransitions : id === "dep-done" ? dep : undefined),
      getBoardOrchestratorCardId: () => input.orchestratorCardId,
      isCardAlive: (id: string) => input.alive[id] ?? false,
      isBoardAutonomous: () => true,
      getBoardCwd: () => "/tmp", // raiz declarada do rig: sem ela o auto-dispatch RECUSA (2026-09-21)
      countRunningAgentsOnBoard: () => 0,
      getBoardConcurrencyCap: () => 4,
      onAutoConnect: (from: string, to: string, kind: string, label?: string | null) => {
        connectors.push({ from, to, kind, label });
      },
      onSpawnAgentRequest: (requestId: string) => {
        bus?.resolveSpawnAgent(requestId, { ok: true, cardId: input.newCardId });
      },
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];

  bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { bus, connectors };
}

async function flushDispatch() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("auto-dispatch nasce conectado ao orquestrador", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("orquestrador marcado e vivo → origem = orquestrador", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-conn-orch-"));
    const rig = buildRig(dir, {
      orchestratorCardId: "card-orch",
      creatorCardId: "card-creator",
      alive: { "card-orch": true, "card-creator": true },
      newCardId: "card-child",
    });
    bus = rig.bus;

    bus.onTaskDone("dep-done");
    await flushDispatch();

    expect(rig.connectors).toHaveLength(1);
    expect(rig.connectors[0]).toMatchObject({ from: "card-orch", to: "card-child", kind: "spawned" });
    // O rótulo é o MESMO que o spawn manual deriva (`deriveAutoConnectLabel`);
    // sem purpose declarado ele cai no início do título da task.
    expect(rig.connectors[0].label).toBe("fase 2");
  });

  it("sem marca de orquestrador, mas com o criador vivo → origem = criador", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-conn-creator-"));
    const rig = buildRig(dir, {
      orchestratorCardId: null,
      creatorCardId: "card-creator",
      alive: { "card-creator": true },
      newCardId: "card-child",
    });
    bus = rig.bus;

    bus.onTaskDone("dep-done");
    await flushDispatch();

    expect(rig.connectors).toHaveLength(1);
    expect(rig.connectors[0]).toMatchObject({ from: "card-creator", to: "card-child", kind: "spawned" });
  });

  it("marca de orquestrador MORTA cai para o criador vivo", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-conn-dead-orch-"));
    const rig = buildRig(dir, {
      orchestratorCardId: "card-orch",
      creatorCardId: "card-creator",
      alive: { "card-orch": false, "card-creator": true },
      newCardId: "card-child",
    });
    bus = rig.bus;

    bus.onTaskDone("dep-done");
    await flushDispatch();

    expect(rig.connectors).toHaveLength(1);
    expect(rig.connectors[0]).toMatchObject({ from: "card-creator", to: "card-child", kind: "spawned" });
  });

  it("nenhuma origem viva → NENHUM conector (não se inventa origem)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-dispatch-conn-none-"));
    const rig = buildRig(dir, {
      orchestratorCardId: "card-orch",
      creatorCardId: "card-creator",
      alive: { "card-orch": false, "card-creator": false },
      newCardId: "card-child",
    });
    bus = rig.bus;

    bus.onTaskDone("dep-done");
    await flushDispatch();

    expect(rig.connectors).toHaveLength(0);
  });
});

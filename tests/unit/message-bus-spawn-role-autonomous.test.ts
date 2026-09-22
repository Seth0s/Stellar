import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

/**
 * `spawn_agent` COM `role` NO CAMINHO AUTÔNOMO — o lado que ninguém cobria.
 *
 * O ACHADO QUE ORIGINOU ESTE ARQUIVO (task c8f129af): um card de task de
 * review nascia como PRINCIPAL (`tasks.card_id`) e com `role`
 * implementer, e o gate recusava o veredito tipado ("an implementer's own
 * aprovado is not a review"). A causa apontada no enunciado era um campo
 * perdido: `role` é validado, usado em três decisões e (supostamente) não
 * entra em `spawnParams`, então não chegaria ao vínculo.
 *
 * MEDIDO NO HEAD, e é o que este arquivo documenta: a premissa NÃO se
 * sustenta nesse ponto. O vínculo não é escrito a partir de `spawnParams`
 * — é escrito no handler, DEPOIS do dispatch, a partir da variável local
 * `role`, que está no escopo do closure (message-bus.ts, o bloco
 * "Reviewer: role row ONLY" + `linkTaskCard(briefDecision.taskId,
 * spawnResult.cardId, role, profile)`). Por isso tirar `role` de
 * `spawnParams` não muda vínculo nenhum (prova por mutação no relatório),
 * e por isso o caminho INTERATIVO já estava correto e coberto
 * (tests/unit/message-bus-spawn-agent-role.test.ts, `upserted` vazio).
 *
 * O QUE ESTE ARQUIVO COBRE, então, não é o defeito relatado: é a METADE
 * QUE FALTAVA. O aviso do enunciado — "os DOIS caminhos precisam do campo;
 * consertar um só é meio conserto que parece inteiro" — continua valendo
 * como COBERTURA, não como conserto: aquele arquivo roda com
 * `isBoardAutonomous: () => false` (caminho interativo) e nenhum teste
 * exercia `role: "reviewer"` no caminho AUTÔNOMO, nem — o caso agudo — o
 * caminho da FILA, onde `enqueueSpawn` guarda o objeto `params` (que NÃO
 * carrega `role`) e o dispatch acontece depois, noutro tick, por
 * `tryDispatchQueued`. Se o `role` viajasse só nos params, era exatamente
 * aqui que ele se perderia em silêncio.
 */

type Captured = {
  spawned: Record<string, unknown>[];
  linked: { taskId: string; cardId: string; role: string }[];
  /** Todo `upsertTask` — é por aqui que `tasks.card_id` é escrito. */
  principalWrites: (string | null)[];
};


function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t-review",
    prompt: "review the work",
    provider: "cline",
    status: "running",
    card_id: "impl-card",
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
  } as TaskRow;
}

describe("message-bus: spawn_agent role no caminho AUTÔNOMO (c8f129af)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Rig do caminho autônomo: board marcado (`getBoardOrchestratorCardId`)
   * porque em board autônomo o consentimento é PULADO e só a marca do
   * board autoriza spawnar revisor (`decideReviewerSpawnAuthorship`) — sem
   * ela o caso nem chegaria ao vínculo que este arquivo mede. */
  function makeRig(opts: { task?: TaskRow | null; running?: number; cap?: number } = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-autonomous-role-"));
    const state = { running: opts.running ?? 0, cap: opts.cap ?? 4, task: opts.task === undefined ? baseTask() : opts.task };
    const captured: Captured = { spawned: [], linked: [], principalWrites: [] };
    const overrides: Record<string, unknown> = {
      onSpawnAgentRequest: (requestId: string, _requesterId: string, params: Record<string, unknown>) => {
        captured.spawned.push(params);
        bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "new-card" });
      },
      getTask: (id: string) => (state.task && id === state.task.id ? state.task : undefined),
      upsertTask: (row: TaskRow) => {
        captured.principalWrites.push(row.card_id ?? null);
        if (state.task && row.id === state.task.id) state.task = row;
        return {
          status: row.status ?? "running",
          statusChanged: false,
          divergedStatus: null,
          divergedActor: null,
          recordDeclaration: false,
          warnAgent: false,
          declaredStatus: null,
        };
      },
      linkTaskCard: (taskId: string, cardId: string, role: string) => {
        captured.linked.push({ taskId, cardId, role });
      },
      listTaskCardsForCard: () => [],
      listCards: () => [
        { id: "new-card", kind: "terminal", provider: "claude", cwd: "/tmp", label: null },
        { id: "impl-card", kind: "terminal", provider: "claude", cwd: "/tmp", label: null },
      ],
      getAnyCard: () => ({ id: "impl-card", kind: "terminal", provider: "claude", cwd: "/tmp", label: null }),
      isCardAlive: () => true,
      getCardBoardId: () => "b1",
      isBoardAutonomous: () => true,
      getBoardOrchestratorCardId: () => "orch",
      boardExists: () => true,
      countRunningAgentsOnBoard: () => state.running,
      getBoardConcurrencyCap: () => state.cap,
      listAllConnectors: () => [],
      listSpawnsByParent: () => [],
      findSpawnByChild: () => undefined,
      recordSpawn: () => ({ id: "spawn-stub" }),
      deriveAutoConnectLabel: () => null,
      onAutoConnect: () => undefined,
    };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy({}, { get: (_t, prop: string) => overrides[prop] ?? (() => undefined) }) as never,
    );
    return { captured, state };
  }

  const spawnReviewer = (taskId: string) =>
    ({
      cmd: "spawn_agent",
      provider: "claude",
      taskId,
      role: "reviewer",
      brief: "revise o diff desta task; reporte um veredito",
      reason: "revisão da entrega",
      requesterId: "orch",
    }) as BusRequest;

  it("board AUTÔNOMO com vaga: o vínculo nasce 'reviewer' e `tasks.card_id` NÃO é tocado", async () => {
    const { captured } = makeRig();
    const res = (await bus!.handleRequest(spawnReviewer("t-review"))) as { ok: boolean; cardId?: string; error?: string };

    expect(res.ok, `recusa inesperada: ${res.error}`).toBe(true);
    expect(res.cardId).toBe("new-card");
    expect(captured.linked).toEqual([{ taskId: "t-review", cardId: "new-card", role: "reviewer" }]);
    // O invariante que dá título à task: um revisor NUNCA vira principal.
    expect(captured.principalWrites).toEqual([]);
  });

  it("board AUTÔNOMO na FILA: o spawn só acontece depois, e AINDA ASSIM o vínculo é 'reviewer'", async () => {
    // Cap cheio: `autonomousSpawn` desvia para `enqueueSpawn`, que guarda o
    // objeto `params` — que NÃO carrega `role`. O dispatch real acontece
    // depois, noutro tick, por `tryDispatchQueued`. É aqui que um `role`
    // que viajasse só nos params se perderia em silêncio.
    const { captured, state } = makeRig({ running: 4, cap: 4 });
    const pending = bus!.handleRequest(spawnReviewer("t-review")) as Promise<{ ok: boolean; cardId?: string }>;

    await new Promise((r) => setTimeout(r, 10));
    expect(captured.spawned).toHaveLength(0); // ainda na fila: nada nasceu

    state.running = 0;
    bus!.notifyConcurrencyCapChanged("b1"); // uma vaga abriu
    const res = await pending;

    expect(res.ok).toBe(true);
    expect(captured.spawned).toHaveLength(1);
    expect(captured.spawned[0].taskId).toBe("t-review");
    expect(captured.linked).toEqual([{ taskId: "t-review", cardId: "new-card", role: "reviewer" }]);
    expect(captured.principalWrites).toEqual([]);
  });

  it("reviewer numa task SEM principal: continua não virando principal", async () => {
    // A versão mais forte do invariante: não é só "não rouba o principal de
    // outro" — a vaga de principal fica VAZIA, porque `tasks.card_id`
    // governa orçamento de retry e `accept_failure` da task.
    const { captured } = makeRig({ task: baseTask({ card_id: null }) });
    const res = (await bus!.handleRequest(spawnReviewer("t-review"))) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(captured.linked).toEqual([{ taskId: "t-review", cardId: "new-card", role: "reviewer" }]);
    expect(captured.principalWrites).toEqual([]);
  });

  it("CONTROLE autônomo: sem `role`, o card VIRA principal (o caminho não é inerte)", async () => {
    // Sem este controle, os casos acima passariam num caminho que não faz
    // nada — o gênero de verde falso que este board já contou doze vezes.
    const { captured } = makeRig();
    const res = (await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t-review",
      reason: "implementar a task",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(captured.linked).toEqual([{ taskId: "t-review", cardId: "new-card", role: "implementer" }]);
    expect(captured.principalWrites).toEqual(["new-card"]);
  });

  it("CONTROLE autônomo: `role` inválido é recusado ANTES de spawnar — nada nasce, nada é vinculado", async () => {
    const { captured } = makeRig();
    const res = (await bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      taskId: "t-review",
      role: "revisor",
      reason: "typo",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toContain('"implementer", "reviewer"');
    expect(captured.spawned).toEqual([]);
    expect(captured.linked).toEqual([]);
    expect(captured.principalWrites).toEqual([]);
  });

  /**
   * ITEM 3 DO ENUNCIADO — "o que existe hoje para religar [um card nascido
   * errado] sem cirurgia manual, e se não existir, diga isso". MEDIDO, não
   * lido: o que existe é o par de chamadas SUPORTADAS abaixo, e a ordem
   * importa. Não há migração a inventar, e nada aqui toca o banco.
   *
   * O que NÃO existe, e é a segunda metade da resposta: o próprio card não
   * consegue se religar como revisor. `decideTaskCardLinkAuthorship`
   * (judgment-write-decision.ts:820-825) recusa o auto-vínculo de revisor
   * (o P1: qualquer card se declarava revisor e assinava o próprio
   * trabalho) — quem religa é a marca do board ou o humano.
   */
  describe("item 3 — religar um card nascido errado, sem cirurgia", () => {
    it("o caminho existe: `link_task_card` recusa nomeando 'detach it first', `update_task {cardId:null}` destaca, e então o vínculo de revisor é aceito", async () => {
      const { captured, state } = makeRig();
      // O card nasceu errado: é o PRINCIPAL desta task.
      expect(state.task?.card_id).toBe("impl-card");

      // 1) Religar direto como revisor: RECUSADO, com o remédio no texto.
      const refused = (await bus!.handleRequest({
        cmd: "link_task_card",
        taskId: "t-review",
        cardId: "impl-card",
        role: "reviewer",
        requesterId: "orch",
      } as BusRequest)) as { ok: boolean; error?: string };
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("detach it first");
      expect(refused.error).toContain("update_task cardId: null");
      expect(captured.linked).toEqual([]); // nada foi gravado pela recusa

      // 2) O destaque, por uma chamada SUPORTADA (sem cirurgia de banco).
      const detached = (await bus!.handleRequest({
        cmd: "update_task",
        taskId: "t-review",
        cardId: null,
        requesterId: "orch",
      } as BusRequest)) as { ok: boolean; error?: string };
      expect(detached.ok, `recusa inesperada: ${detached.error}`).toBe(true);
      expect(captured.principalWrites).toContain(null);
      expect(state.task?.card_id ?? null).toBeNull();

      // 3) Agora sim: o mesmo card entra como revisor, e o principal fica
      // VAZIO (o revisor não o ocupa).
      const relinked = (await bus!.handleRequest({
        cmd: "link_task_card",
        taskId: "t-review",
        cardId: "impl-card",
        role: "reviewer",
        requesterId: "orch",
      } as BusRequest)) as { ok: boolean; error?: string };
      expect(relinked.ok, `recusa inesperada: ${relinked.error}`).toBe(true);
      expect(captured.linked).toEqual([{ taskId: "t-review", cardId: "impl-card", role: "reviewer" }]);
      expect(state.task?.card_id ?? null).toBeNull();
    });
  });
});



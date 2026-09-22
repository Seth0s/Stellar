import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { SPAWN_QUEUE_NOTICE_MIN_WAIT_MS } from "../../src/main/spawn-queue-notice-decision";

/**
 * O CASO REAL de `97924155` × `97924157` — item 3 do enunciado ("por que o
 * spawn DUPLICOU cards").
 *
 * O QUE ACONTECEU, medido (task bf1fb0a7; medição completa em
 * tmp/spawn-probe/MEASUREMENTS.md):
 *
 *   - `97924155`: linha em `spawns` com `origin = "human"`, `from_card_id` NULL,
 *     `reason` NULL, cwd = RAIZ do board — criada 14:12:20Z, ou seja 3min19s
 *     ANTES da primeira chamada antigravity (14:15:39Z). `origin = "human"` só é
 *     escrito pelos caminhos de criação humana do renderer
 *     (`store:spawns:record-human`); o caminho de agente grava pelo `recordSpawn`
 *     do bus. Esse card NÃO veio do spawn.
 *   - `97924157`: `origin = "agent"`, `from_card_id = 97924064`, cwd =
 *     `…/Stellar`, `reason` = o enunciado da 1172cb32 — é o card DA chamada de
 *     14:15:39Z, e ele só nasceu às 14:23:07Z: 444s depois de ser emitida.
 *   - o mesmo enunciado acabou entregue aos DOIS cards: o orquestrador briefou
 *     `97924155` à mão (14:21:54Z) porque a chamada não lhe devolveu cardId
 *     nenhum, e às 14:32:30Z escreveu para ele "não faça a 1172cb32. Outro card
 *     (97924157) já a fez enquanto você estava parado".
 *
 * CONCLUSÃO medida: o app não criou dois cards de uma chamada. Fez algo pior de
 * diagnosticar — criou UM card que o chamador não tinha como identificar, minutos
 * depois de o watchdog do cliente abortar a chamada. Sem cardId, o chamador
 * adivinhou, briefou um card que não era o dele, e o trabalho foi feito duas
 * vezes na MESMA árvore.
 *
 * Este arquivo prova as duas metades do conserto com os argumentos REAIS do
 * incidente: (1) a chave de idempotência fecha a retentativa; (2) quando a fila
 * despacha depois do watchdog, o cardId chega ao chamador por outro canal — o
 * mesmo FIFO de entrega que já leva os ponteiros de report/exit.
 */

/** O brief REAL da chamada de 14:15:39Z (primeiro parágrafo, verbatim do
 * transcript do orquestrador; o texto tinha 4180 caracteres). */
const REAL_BRIEF_14_15_39 =
  "Você assume uma entrega JÁ APROVADA (task 1172cb32) que ficou a UM passo de fechar. " +
  "O card anterior morreu por cota no meio; o trabalho dele está INTEIRO na árvore e a suíte " +
  "está verde (tsc 0, 220 arquivos / 2405 testes, zero falha). Você não está a começar nada — está a fechar.";

/** A chamada REAL, campo por campo (provider/label/cwd do transcript). */
const REAL_CALL = {
  cmd: "spawn_agent",
  provider: "antigravity",
  label: "Veredito escopado",
  cwd: "/home/lucas/Workplace/Projects/Stellar",
  brief: REAL_BRIEF_14_15_39,
  reason: "O card commandcode que implementava a 1172cb32 morreu por cota a um passo de fechar.",
  requesterId: "97924064",
} as BusRequest;

type Rig = {
  spawned: Record<string, unknown>[];
  /** Textos escritos em card pelo FIFO de entrega (o canal do aviso). */
  writes: { target: string; text: string }[];
  state: { running: number; cap: number };
};


describe("caso real 97924155 × 97924157 (bf1fb0a7)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  let nowMs = 0;

  beforeEach(() => {
    // Só o RELÓGIO é falso: os timers seguem de verdade (o FIFO de entrega usa
    // setTimeout nas esperas do laço de confirmação; congelá-los deixaria a
    // escrita do aviso pendurada). É a espera MEDIDA — `Date.now()` — que decide
    // se o aviso vale a pena.
    nowMs = Date.parse("2026-09-21T14:15:39.137Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    bus?.close();
    bus = null;
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function rig(opts: { running?: number; cap?: number } = {}): Rig {
    dir = mkdtempSync(join(tmpdir(), "stellar-dup-real-"));
    const out: Rig = { spawned: [], writes: [], state: { running: opts.running ?? 0, cap: opts.cap ?? 14 } };
    const overrides: Record<string, unknown> = {
      onSpawnAgentRequest: (requestId: string, _requesterId: string, params: Record<string, unknown>) => {
        out.spawned.push(params);
        bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "97924157" });
      },
      // O FIFO lê a tela antes de digitar; sem isto a entrega fica pendurada no
      // READ_CARD_TIMEOUT_MS e o aviso nunca chega a ser escrito.
      onReadCardRequest: (requestId: string) => {
        bus?.resolveReadCard(requestId, { ok: true, text: "❯ Ask anything…\n" });
      },
      writeToCardWithOrigin: (id: string, data: string, origin: string) => {
        if (origin === "delivery") out.writes.push({ target: id, text: data });
      },
      writeToCard: (id: string, data: string) => out.writes.push({ target: id, text: data }),
      isCardAlive: () => true,
      getCardBoardId: () => "118",
      isBoardAutonomous: () => true,
      getBoardOrchestratorCardId: () => "97924064",
      boardExists: () => true,
      countRunningAgentsOnBoard: () => out.state.running,
      getBoardConcurrencyCap: () => out.state.cap,
      listCards: () => [{ id: "97924157", kind: "terminal", provider: "antigravity", cwd: "/tmp", label: null }],
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
    return out;
  }

  const flush = () => new Promise((r) => setTimeout(r, 5));

  it("SEM chave, a retentativa depois do abort cria DOIS cards — o mecanismo que o dono viu", async () => {
    const out = rig();
    const first = (await bus!.handleRequest(REAL_CALL)) as Record<string, unknown>;
    expect(first.ok).toBe(true);
    // A retentativa que um orquestrador faz ao ver a chamada morrer (watchdog de
    // 300s): mesma intenção, chamada nova.
    await bus!.handleRequest(REAL_CALL);
    expect(out.spawned).toHaveLength(2);
  });

  it("COM a mesma chave, a retentativa devolve o MESMO card e diz que é reuso", async () => {
    const out = rig();
    const call = { ...REAL_CALL, idempotencyKey: "bf1fb0a7/1172cb32-retry" } as BusRequest;
    const first = (await bus!.handleRequest(call)) as Record<string, unknown>;
    const retry = (await bus!.handleRequest(call)) as Record<string, unknown>;
    expect(out.spawned).toHaveLength(1);
    expect(retry.cardId).toBe(first.cardId);
    expect(retry.idempotentReplay).toBe(true);
    // A verdade sobre o brief continua a mesma na segunda via.
    expect(retry.briefMode).toBe(first.briefMode);
    expect(retry.briefDelivered).toBe(first.briefDelivered);
  });

  it("fila que despacha DEPOIS do watchdog: o cardId chega ao chamador pelo canal de entrega", async () => {
    // Board no teto: a chamada real vai para a fila em vez de nascer na hora.
    const out = rig({ running: 14, cap: 14 });
    const pending = bus!.handleRequest(REAL_CALL);
    await flush();
    expect(out.spawned).toHaveLength(0); // ainda na fila: nada nasceu

    // 111s de espera (o caso real esperou 444s) e uma vaga abre. O teto da fila
    // é 10min, então a entrada sobrevive inteira.
    nowMs += 111_000;
    out.state.running = 13;
    bus!.notifyConcurrencyCapChanged("118");
    const res = (await pending) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(out.spawned).toHaveLength(1);
    await flush();

    // O aviso: o MESMO cardId que a chamada abortada não conseguiu devolver.
    const notice = out.writes.find((w) => w.target === "97924064");
    expect(notice, `nada foi escrito para o chamador: ${JSON.stringify(out.writes)}`).toBeDefined();
    expect(notice!.text).toContain(String(res.cardId));
    expect(notice!.text).toMatch(/do not spawn another/);
  });

  it("espera curta NÃO gera aviso — o chamador recebeu a própria resposta", async () => {
    const out = rig({ running: 14, cap: 14 });
    const pending = bus!.handleRequest(REAL_CALL);
    await flush();
    nowMs += SPAWN_QUEUE_NOTICE_MIN_WAIT_MS - 1_000; // abaixo do piso
    out.state.running = 13;
    bus!.notifyConcurrencyCapChanged("118");
    await pending;
    await flush();
    expect(out.writes).toHaveLength(0);
  });
});

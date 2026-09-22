import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * `spawn_agent` DIZENDO A VERDADE SOBRE O BRIEF (task bf1fb0a7).
 *
 * O defeito medido no board 118 (2026-09-22): a ferramenta devolvia
 * `{ok:true, cardId}` sem dizer nada sobre o texto que lhe pediram para
 * entregar. Quatro situações diferentes chegavam ao orquestrador como a MESMA
 * string:
 *
 *   1. o card nasceu com o brief no argv (entrega que não depende de nada);
 *   2. o texto só foi ENFILEIRADO para digitação posterior (entrega que pode
 *      não acontecer — e a `get_delivery` é o único veredito);
 *   3. o chamador NÃO mandou brief nenhum (foi o caso real das quatro chamadas
 *      de 2026-09-22: o transcript do próprio orquestrador, linhas
 *      17194/17223/17224/17269, mostra `provider`/`label`/`cwd`/`reason`, sem
 *      `brief` e sem `taskId`);
 *   4. o texto foi enfileirado e morreu na fila.
 *
 * E o efeito de segunda ordem: o orquestrador leu as quatro como "o app não
 * entrega o brief" e passou a entregar TUDO à mão com `send_to_card`. Uma
 * ferramenta que não distingue "não entreguei" de "não me deram nada para
 * entregar" fabrica exatamente isso.
 *
 * Este arquivo nasceu VERMELHO nesta árvore (nenhum destes campos existia).
 */
function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "getCardBoardId") return () => undefined;
        if (prop === "isBoardAutonomous") return () => false;
        if (prop === "getTask") return () => undefined;
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: spawn_agent e a verdade sobre o brief", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** `autoResolve: false` deixa as chamadas EM VOO para o teste de corrida. */
  async function harness(autoResolve = true) {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-brief-"));
    const spawned: Array<Record<string, unknown>> = [];
    const pending: string[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        onSpawnAgentRequest: ((requestId: string, _requesterId: string, params: Record<string, unknown>) => {
          spawned.push(params);
          if (autoResolve) bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "new-card" });
          else pending.push(requestId);
        }) as never,
      }),
    );
    return { spawned, pending };
  }

  const spawn = (extra: Partial<Record<string, unknown>> = {}) =>
    bus!.handleRequest({
      cmd: "spawn_agent",
      provider: "claude",
      requesterId: "orch",
      reason: "test",
      ...extra,
    } as BusRequest);

  it("sem brief: a resposta diz que NADA foi entregue", async () => {
    const { spawned } = await harness();
    const res = (await spawn()) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(spawned[0].brief).toBeUndefined();
    expect(res.briefDelivered).toBe(false);
    expect(res.briefMode).toBe("none");
    expect(String(res.briefNote)).toMatch(/NO brief/);
  });

  it("brief que cabe no argv: a resposta diz que o processo nasceu com ele", async () => {
    const { spawned } = await harness();
    const res = (await spawn({ brief: "make the thing" })) as Record<string, unknown>;
    expect(spawned[0].brief).toBe("make the thing");
    expect(res.briefDelivered).toBe(true);
    expect(res.briefMode).toBe("argv");
    expect(res.briefDeliveryId).toBeUndefined();
  });

  it("brief grande demais para o argv: diz que está só NA FILA, e entrega o recibo", async () => {
    await harness();
    const res = (await spawn({ brief: "x".repeat(130_001) })) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.briefMode).toBe("typed");
    // O ponto: a entrega digitada NÃO aconteceu ainda. Dizer `true` aqui é a
    // classe "sucesso afirmado que o sistema não pode sustentar".
    expect(res.briefDelivered).toBe(false);
    const id = res.briefDeliveryId;
    expect(typeof id).toBe("string");
    const settled = (await bus!.handleRequest({ cmd: "get_delivery", id } as BusRequest)) as Record<string, unknown>;
    expect(settled.ok).toBe(true);
    expect(typeof settled.delivery).toBe("string");
  });

  it("mesma chave de idempotência: UM card, não dois", async () => {
    const { spawned } = await harness();
    const a = (await spawn({ idempotencyKey: "bf1fb0a7/op-1" })) as Record<string, unknown>;
    const b = (await spawn({ idempotencyKey: "bf1fb0a7/op-1" })) as Record<string, unknown>;
    expect(spawned).toHaveLength(1);
    expect(b.cardId).toBe(a.cardId);
    // A retentativa recebe a MESMA verdade (não uma versão degradada dela) — e
    // sabe que é reuso, não um card novo.
    expect(b.briefMode).toBe(a.briefMode);
    expect(b.briefDelivered).toBe(a.briefDelivered);
    expect(b.idempotentReplay).toBe(true);
    expect(a.idempotentReplay).toBeUndefined();
  });

  it("duas chamadas EM VOO com a mesma chave: UM card", async () => {
    const { spawned, pending } = await harness(false);
    const first = spawn({ idempotencyKey: "op-2" });
    const second = spawn({ idempotencyKey: "op-2" });
    // Uma única requisição chegou ao renderer; ela resolve as duas.
    expect(spawned).toHaveLength(1);
    expect(pending).toHaveLength(1);
    bus!.resolveSpawnAgent(pending[0], { ok: true, cardId: "card-42" });
    const [a, b] = (await Promise.all([first, second])) as Array<Record<string, unknown>>;
    expect(a.cardId).toBe("card-42");
    expect(b.cardId).toBe("card-42");
  });

  it("chave DIFERENTE (ou nenhuma) continua criando card novo — a chave não é um cache global", async () => {
    const { spawned } = await harness();
    await spawn({ idempotencyKey: "op-3" });
    await spawn({ idempotencyKey: "op-4" });
    await spawn();
    expect(spawned).toHaveLength(3);
  });
});

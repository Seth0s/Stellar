import { describe, it, expect } from "vitest";
import {
  SPAWN_IDEMPOTENCY_WINDOW_MS,
  decideSpawnIdempotency,
  normalizeSpawnIdempotencyKey,
  pruneSpawnIdempotency,
} from "../../src/main/spawn-idempotency-decision";

/**
 * `spawn_agent` com chave: uma chave, no máximo UM card (task bf1fb0a7).
 *
 * O caso real que isto fecha: board autônomo no teto → a chamada fica na fila
 * por minutos, o watchdog de 300s do cliente aborta, o card nasce DEPOIS
 * (medido: `97924157`/`97924159` nasceram 358 ms um do outro, 4 e 7,5 minutos
 * depois das chamadas). Retentar ali é legítimo — e sem chave cria um segundo
 * card para o mesmo trabalho na mesma árvore.
 */
const entry = (over: Partial<{ key: string; requesterId: string; atMs: number }> = {}) => ({
  key: "k1",
  requesterId: "card-a",
  atMs: 1_000,
  ...over,
});

describe("spawn idempotency", () => {
  it("chave vazia ou só espaços é AUSÊNCIA, nunca um id que casa com tudo", () => {
    expect(normalizeSpawnIdempotencyKey(undefined)).toBeNull();
    expect(normalizeSpawnIdempotencyKey("   ")).toBeNull();
    expect(normalizeSpawnIdempotencyKey(123)).toBeNull();
    expect(normalizeSpawnIdempotencyKey("  k1 ")).toBe("k1");
    expect(decideSpawnIdempotency({ entries: [entry()], key: "  ", requesterId: "card-a", nowMs: 1_001 })).toEqual({
      action: "proceed",
      key: null,
    });
  });

  it("mesma chave, mesmo chamador, dentro da janela → replay (um card, não dois)", () => {
    const d = decideSpawnIdempotency({ entries: [entry()], key: "k1", requesterId: "card-a", nowMs: 2_000 });
    expect(d.action).toBe("replay");
    if (d.action === "replay") expect(d.ageMs).toBe(1_000);
  });

  it("a chave é DO CHAMADOR: outro card com a mesma string não é roubado", () => {
    expect(decideSpawnIdempotency({ entries: [entry()], key: "k1", requesterId: "card-b", nowMs: 2_000 }).action).toBe(
      "proceed",
    );
  });

  it("fora da janela a chave não protege mais — é pedido de card novo", () => {
    const now = 1_000 + SPAWN_IDEMPOTENCY_WINDOW_MS + 1;
    expect(decideSpawnIdempotency({ entries: [entry()], key: "k1", requesterId: "card-a", nowMs: now }).action).toBe(
      "proceed",
    );
  });

  it("relógio para trás (ageMs negativo) fica DENTRO da janela: reusar é mais seguro que duplicar", () => {
    expect(decideSpawnIdempotency({ entries: [entry()], key: "k1", requesterId: "card-a", nowMs: 500 }).action).toBe(
      "replay",
    );
  });

  it("a poda só descarta o que envelheceu", () => {
    const kept = pruneSpawnIdempotency([entry({ key: "old", atMs: 0 }), entry({ key: "new", atMs: 9_000 })], 10_000, 5_000);
    expect(kept.map((e) => e.key)).toEqual(["new"]);
  });
});

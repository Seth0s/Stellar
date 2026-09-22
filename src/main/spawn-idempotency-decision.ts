/**
 * Idempotência do `spawn_agent` — uma chave, no máximo UM card.
 *
 * MEDIDO (task bf1fb0a7, 2026-09-22): o caminho de fila do board autônomo
 * (`enqueueSpawn`, DEFAULT_QUEUE_TIMEOUT_MS = 10 min) segura a chamada sem
 * nenhum sinal de progresso. O cliente MCP do orquestrador tem watchdog de
 * 300s: ele ABORTA uma chamada que já foi aceita e que VAI criar um card
 * minutos depois. Medido no board 118: as chamadas de 14:15:39Z e 14:19:09Z
 * de 2026-09-21 resolveram as DUAS às 14:23:07Z (358 ms de diferença), 4 e 7,5
 * minutos depois de terem sido emitidas — e os cards `97924157`/`97924159`
 * nasceram ali (linhas do transcript `k088iryvc`, `k5unoc13f`). O orquestrador
 * já tinha desistido; às 14:30:56Z escreveu "há um card que eu não sabia que
 * existia".
 *
 * A retentativa é legítima nesse cenário — e hoje ela cria um SEGUNDO card
 * para o mesmo trabalho, na mesma árvore. Numa árvore compartilhada isso é
 * como se fabricam sobrescritas silenciosas (AGENTS.md §3). A chave resolve:
 * o mesmo chamador, com a mesma chave, dentro da janela, recebe O MESMO card.
 *
 * Escopo: (requesterId, chave). Dois cards diferentes usando a mesma string de
 * chave não se roubam — a chave é uma obrigação do CHAMADOR para com a própria
 * retentativa, não um nome global. Chamador sem identidade (humano/acbridge)
 * casa com chamador sem identidade, e nada mais.
 *
 * A janela é o orçamento de retentativa, não um cache: passado
 * `SPAWN_IDEMPOTENCY_WINDOW_MS` o efeito antigo não é mais um efeito
 * "recente", e reusar a chave depois disso é pedir um card novo.
 */

/** Orçamento da chave. Igual ao teto da fila autônoma (10 min) de propósito:
 * é a janela em que o watchdog de um cliente pode ter abortado uma chamada que
 * ainda vai produzir efeito. */
export const SPAWN_IDEMPOTENCY_WINDOW_MS = 600_000;

/** Chave vazia/só-espaços é AUSÊNCIA (não um id degenerado que casa com tudo). */
export function normalizeSpawnIdempotencyKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type SpawnIdempotencyEntry = {
  key: string;
  requesterId: string;
  atMs: number;
  /** Resultado FINAL já decorado (brief, dep note). Ausente = ainda em voo. */
  result?: unknown;
};

export type SpawnIdempotencyDecision =
  | { action: "proceed"; key: string | null }
  | { action: "replay"; key: string; entry: SpawnIdempotencyEntry; ageMs: number };

export function decideSpawnIdempotency(input: {
  entries: Iterable<SpawnIdempotencyEntry>;
  key: unknown;
  requesterId: string;
  nowMs: number;
  windowMs?: number;
}): SpawnIdempotencyDecision {
  const key = normalizeSpawnIdempotencyKey(input.key);
  if (!key) return { action: "proceed", key: null };
  const windowMs = input.windowMs ?? SPAWN_IDEMPOTENCY_WINDOW_MS;
  for (const entry of input.entries) {
    if (entry.key !== key) continue;
    if (entry.requesterId !== input.requesterId) continue;
    const ageMs = input.nowMs - entry.atMs;
    // `ageMs < 0` (relógio para trás) conta como dentro da janela: reusar é
    // mais seguro que duplicar.
    if (ageMs > windowMs) continue;
    return { action: "replay", key, entry, ageMs };
  }
  return { action: "proceed", key };
}

/** Chaves fora da janela saem. Puro pra que a poda não dependa do Map vivo. */
export function pruneSpawnIdempotency(
  entries: Iterable<SpawnIdempotencyEntry>,
  nowMs: number,
  windowMs: number = SPAWN_IDEMPOTENCY_WINDOW_MS,
): SpawnIdempotencyEntry[] {
  const kept: SpawnIdempotencyEntry[] = [];
  for (const entry of entries) {
    if (nowMs - entry.atMs > windowMs) continue;
    kept.push(entry);
  }
  return kept;
}

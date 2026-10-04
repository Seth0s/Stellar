/**
 * LOCK DE GATE (task ff24b36d) — a fila que serializa comando PESADO, venha
 * ele do APP (gate-runner) ou de um AGENTE (`acbridge gate-lock` / `run_locked`).
 *
 * DEFEITO MEDIDO (2026-10-04): os agentes rodavam os mesmos comandos pesados
 * à mão, FORA do lock do gate-runner. Com vários cards no mesmo repo, o
 * Lighthouse de uma página deu desempenho 0.72 e CLS 0.14 numa corrida contra
 * 1.0 e 0.005 rodando sozinho. Um falso vermelho que custou rodadas.
 *
 * ESCOPO:
 *   - `repo`    → a MESMA chave do gate-runner (`lockKeyFor`: raiz do git, ou
 *                 o cwd resolvido) — é o que garante que um `gate-lock` de
 *                 agente e um gate do app no mesmo repositório se serializem;
 *   - `machine` → uma chave GLOBAL, para o comando que não pode concorrer com
 *                 NADA na máquina (ex.: medição de desempenho).
 *
 * LIMITE DECLARADO: o lock é em MEMÓRIA, por processo do app — o MESMO escopo
 * que o lock de repo do gate-runner sempre teve (dois cards do MESMO Stellar).
 * Um segundo processo Electron sobre o mesmo userData é fora de escopo, dito
 * e não fingido. Um processo FILHO que morre libera o lock porque quem chama
 * o `release` é o handler de saída/erro do spawn (ver gate-runner); se o
 * PRÓPRIO app morrer, não há estado persistido para vazar — o Map some com o
 * processo.
 *
 * Sem I/O: só decide QUEM roda quando. Quem executa chama `acquire`/`release`.
 */

export type GateLockScope = "repo" | "machine";

/** Chave global do lock de máquina. Não colide com chave de repo (que é um
 * caminho absoluto). */
export const MACHINE_LOCK_KEY = "\u0000machine";

/** Quem segura (ou espera) o lock — o que a Fila mostra. */
export type GateLockHolder = {
  /** Task de onde partiu o comando (`null` quando o chamador não tem task). */
  taskId: string | null;
  /** Card responsável (implementer do gate do app; chamador no gate-lock). */
  cardId: string | null;
  /** Texto curto para a UI (id curto da task ou do card). */
  label: string;
};

export type GateLockRunning = { holder: GateLockHolder; startedAt: number };
export type GateLockWaiter = { position: number; holder: GateLockHolder; enqueuedAt: number };

export type GateLockSnapshot = {
  key: string;
  scope: GateLockScope;
  running: GateLockRunning | null;
  queue: GateLockWaiter[];
};

type Waiter = { holder: GateLockHolder; enqueuedAt: number; grant: () => void };
type KeyState = { running: GateLockRunning | null; waiters: Waiter[] };

const locks = new Map<string, KeyState>();

export type GateLockAcquisition = {
  release: () => void;
  /** Tempo esperando na fila antes de obter o lock (0 quando entrou direto). */
  waitedMs: number;
  /** Quem segurava o lock quando este chamador entrou na fila (`null` se livre). */
  holderWhileWaiting: GateLockHolder | null;
  /** Posição na fila no instante do pedido (0 = entrou direto). */
  positionAtRequest: number;
};

/** A chave do lock para um escopo. `repo` recebe a chave já resolvida pelo
 * chamador (`lockKeyFor`). */
export function gateLockKey(scope: GateLockScope, repoKey: string): string {
  return scope === "machine" ? MACHINE_LOCK_KEY : repoKey;
}

/**
 * Pede o lock `key`. Resolve QUANDO for a vez do chamador (entrou direto, ou
 * depois que todos os anteriores liberaram — FIFO). O `release` devolvido é
 * idempotente e passa a vez para o próximo.
 */
export function acquireGateLock(key: string, holder: GateLockHolder): Promise<GateLockAcquisition> {
  const state = locks.get(key) ?? { running: null, waiters: [] };
  locks.set(key, state);
  const enqueuedAt = Date.now();
  const holderWhileWaiting = state.running?.holder ?? null;
  const positionAtRequest = state.running ? state.waiters.length + 1 : 0;

  return new Promise((resolve) => {
    const grant = () => {
      state.running = { holder, startedAt: Date.now() };
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const next = state.waiters.shift();
        if (next) {
          next.grant();
        } else {
          state.running = null;
          // Ninguém mais na fila: esquece a chave (o Map não cresce por repo
          // visto). Só apaga se ainda for este estado — um novo chamador pode
          // ter recriado a entrada entre o release e este ponto.
          if (locks.get(key) === state && state.waiters.length === 0) locks.delete(key);
        }
      };
      resolve({ release, waitedMs: Date.now() - enqueuedAt, holderWhileWaiting, positionAtRequest });
    };
    if (!state.running && state.waiters.length === 0) grant();
    else state.waiters.push({ holder, enqueuedAt, grant });
  });
}

/** Estado de UMA chave — para a Fila e para o aviso de fila do gate-lock. */
export function gateLockSnapshot(key: string, scope: GateLockScope): GateLockSnapshot {
  const state = locks.get(key);
  return {
    key,
    scope,
    running: state?.running ?? null,
    queue: (state?.waiters ?? []).map((w, i) => ({ position: i + 1, holder: w.holder, enqueuedAt: w.enqueuedAt })),
  };
}

/** TODAS as chaves ativas (running ou com fila), para a UI. Vazio = nenhum
 * gate pesado rodando — nunca inventa uma linha. */
export function allGateLockSnapshots(): GateLockSnapshot[] {
  const out: GateLockSnapshot[] = [];
  for (const [key, state] of locks) {
    if (!state.running && state.waiters.length === 0) continue;
    out.push({
      key,
      scope: key === MACHINE_LOCK_KEY ? "machine" : "repo",
      running: state.running,
      queue: state.waiters.map((w, i) => ({ position: i + 1, holder: w.holder, enqueuedAt: w.enqueuedAt })),
    });
  }
  return out;
}

/** Seam de teste: descarta todo o estado do lock (nenhum teste depende de
 * estado global entre casos). A produção NUNCA chama isto. */
export function resetGateLocks(): void {
  locks.clear();
}

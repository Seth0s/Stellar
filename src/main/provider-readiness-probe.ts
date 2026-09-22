/**
 * A CASCA DE I/O DA PRONTIDÃO (task 1777060e) — roda o probe DECLARADO e
 * guarda a última resposta num cache por TTL.
 *
 * POR QUE O CACHE É PARTE DO DESENHO, e não otimização: a sonda do `omp` custa
 * 0,69s (medido) e o `checkAgentAvailability` é SÍNCRONO (`which()`); rodá-la no
 * caminho da chamada congelaria o main por 0,69s por provider. Ela roda em
 * BACKGROUND, com TTL, e quem pergunta recebe a última resposta conhecida —
 * `unknown` enquanto não houver nenhuma. Os números de novo, para quem for
 * mexer: 0,69s (probe `auth-broker status --json`) contra os ~1,7s que o spec do
 * opencode JÁ recusou para validação por spawn; a alternativa barata (contar
 * linhas de `auth_credentials` no `agent.db`) custa 0,78ms mas lê um schema
 * PRIVADO do tool — uma atualização dele quebraria a sonda em SILÊNCIO, e
 * resposta errada é pior que `unknown`.
 *
 * NUNCA imprime credencial: o probe lê um CAMPO BOOLEANO do JSON que o próprio
 * tool imprime, e nada aqui loga stdout. O `stdout` fica no resultado só para
 * ser interpretado por `decideProviderReadiness`; quem relata, relata o veredito
 * e a razão NOMEADA pelo tool (ex.: `not_configured`), nunca o conteúdo.
 */
import { spawn } from "node:child_process";
import {
  decideProviderReadiness,
  type ProviderReadinessState,
  type ReadinessProbe,
  type ReadinessProbeResult,
} from "./provider-readiness-decision";

/** Quanto tempo uma resposta vale antes de valer a pena perguntar de novo. */
export const READINESS_TTL_MS = 30_000;

/** Teto do probe quando o spec não declarar um. Curto: é LEITURA de estado, não
 *  validação de trabalho — o mesmo motivo que fez o opencode recusar 1,7s. */
export const READINESS_DEFAULT_TIMEOUT_MS = 2_000;

/** Roda o probe declarado. Nunca lança: falha de spawn/timeout/exit vira
 *  `unanswered`, que a decisão pura lê como `unknown` — não como "sem
 *  credencial". */
export function runReadinessProbe(
  binary: string,
  probe: ReadinessProbe,
): Promise<ReadinessProbeResult> {
  const timeoutMs = probe.timeoutMs > 0 ? probe.timeoutMs : READINESS_DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: ReadinessProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Sem shell, por argv — a mesma postura endurecida de `pty-registry` e
      // `gate-runner` (um valor com espaço é UM argumento, não uma linha de shell).
      child = spawn(binary, [...probe.args], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ kind: "unanswered", why: "spawn-failed" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ kind: "unanswered", why: "timeout" });
    }, timeoutMs);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Um probe que vomita saída sem parar é um probe quebrado: corta.
      if (stdout.length > 64_000) {
        child.kill("SIGKILL");
        done({ kind: "unanswered", why: "timeout" });
      }
    });
    child.on("error", () => done({ kind: "unanswered", why: "spawn-failed" }));
    child.on("close", (code) => {
      if (code !== 0) {
        done({ kind: "unanswered", why: "exit-code" });
        return;
      }
      done({ kind: "answered", stdout });
    });
  });
}

/**
 * O cache: última resposta por provider + instante. `now` é injetado para o
 * teste poder envelhecer a resposta sem esperar TTL nenhum (mesmo recurso dos
 * outros relógios deste repo).
 */
export function createReadinessCache(opts: { ttlMs?: number } = {}) {
  const ttlMs = opts.ttlMs ?? READINESS_TTL_MS;
  const entries = new Map<string, { result: ReadinessProbeResult; at: number }>();
  return {
    /** A última resposta, ou `null` (nunca perguntado / já vencida). */
    get(id: string, now: number): ReadinessProbeResult | null {
      const hit = entries.get(id);
      if (!hit) return null;
      if (now - hit.at > ttlMs) return null;
      return hit.result;
    },
    /** Existe resposta VENCIDA? É o gatilho do refresh em background — sem ele,
     *  um provider nunca perguntado nunca seria sondado. */
    needsRefresh(id: string, now: number): boolean {
      const hit = entries.get(id);
      return !hit || now - hit.at > ttlMs;
    },
    set(id: string, result: ReadinessProbeResult, now: number): void {
      entries.set(id, { result, at: now });
    },
    clear(id?: string): void {
      if (id === undefined) entries.clear();
      else entries.delete(id);
    },
  };
}

export type ReadinessCache = ReturnType<typeof createReadinessCache>;

/** O cache de produção — um só, do main. Quem pergunta (o caminho síncrono do
 *  `checkAgentAvailability`) lê daqui; quem sonda (`refreshProviderReadiness`)
 *  escreve aqui. */
export const readinessCache: ReadinessCache = createReadinessCache();

/** A decisão a partir do cache — o que o caminho SÍNCRONO responde. */
export function cachedReadiness(input: {
  installed: boolean;
  probe: ReadinessProbe | null;
  cached: ReadinessProbeResult | null;
}): { state: ProviderReadinessState; evidence: string } {
  return decideProviderReadiness({
    installed: input.installed,
    probe: input.probe,
    result: input.cached,
  });
}

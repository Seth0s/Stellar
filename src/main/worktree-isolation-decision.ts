/**
 * Decisões puras de `spawn_agent({ isolation: "worktree" })` — um card que
 * precisa nascer numa git worktree descartável do seu projeto, nunca na
 * árvore compartilhada (AGENTS.md §3.5: nenhum comando git que descarte
 * estado "para isolar a própria entrega" — a árvore é compartilhada e o
 * custo de um reset destrutivo nunca é local).
 *
 * Duas coisas que um `git worktree add` cru não resolve, e que vivem aqui
 * (puro, sem I/O — `worktree-prep.ts` aplica):
 *
 * 1. A worktree só contém o que o git rastreia. Um projeto que precisa de
 *    `.env`, um `vendor/` COPIADO (symlink quebra o autoload), `storage/jwt`,
 *    `bootstrap/cache` ou `storage/framework` para sequer subir tem tudo
 *    isso escondido pelo `.gitignore` — a worktree nasce sem conseguir rodar
 *    um teste, e o buraco foi fechado à mão cinco vezes antes disto. QUAIS
 *    caminhos copiar é POR PROJETO (a lista do backend do IdyPlatform não é
 *    a de outro projeto), então quem declara é o próprio projeto, em
 *    `WORKTREE_CONFIG_REL_PATH`, lido do checkout de origem — nunca uma
 *    lista hardcoded aqui.
 * 2. O caminho gerado precisa ser CURTO. Socket Unix limita `sun_path` a 108
 *    bytes (docs/ORCHESTRATION.md §15): uma worktree sob caminho fundo faz
 *    os testes de socket/MCP do PRÓPRIO projeto falharem por um motivo que
 *    não é o código dele. O caminho é montado sob uma raiz curta e recusado
 *    se ainda assim passar do orçamento.
 *
 * Ausência é dado: sem arquivo de declaração, copia NADA (worktree crua),
 * nunca uma lista default adivinhada.
 */

import { isAbsolute, join } from "node:path";

/** Declaração por projeto, relativa à raiz do repositório. Lida do
 * checkout de ORIGEM (a árvore principal), não da worktree nova. */
export const WORKTREE_CONFIG_REL_PATH = ".stellar/worktree.json";

/**
 * Orçamento do CAMINHO da worktree, abaixo dos 108 bytes do socket Unix
 * (docs/ORCHESTRATION.md §15). Não é o limite do socket — é a folga que
 * sobra para a parte relativa que o próprio projeto acrescenta ao criar um
 * socket dentro da worktree (ex.: `storage/framework/…sock`). Raiz curta +
 * nome curto ficam muito abaixo disto; o teto existe para RECUSAR cedo um
 * caso que passaria do limite, em vez de gerar uma worktree que falha
 * depois, num teste que ninguém liga ao caminho.
 */
export const WORKTREE_PATH_MAX_BYTES = 90;

/** Segmentos ignorados na normalização de um caminho declarado. */
const EMPTY_SEGMENTS = new Set(["", "."]);

export type IsolationDecision =
  { ok: true; isolation: "worktree" | null } | { ok: false; error: string };

/**
 * Valida o valor de `isolation`. Ausente/`""`/`null` = árvore compartilhada
 * (comportamento de sempre). Qualquer outra coisa é RECUSADA nomeando o
 * valor — o mesmo "recuse, nunca remapeie em silêncio" de `effort`/`role`:
 * um `isolation` que não seja honrado deixaria o card na árvore
 * compartilhada achando que está isolado.
 */
export function decideSpawnIsolation(value: unknown): IsolationDecision {
  if (value === undefined || value === null || value === "") return { ok: true, isolation: null };
  if (value === "worktree") return { ok: true, isolation: "worktree" };
  return {
    ok: false,
    error:
      `isolation must be "worktree" (or omitted to keep the shared tree), got ${JSON.stringify(value)} — ` +
      "refusing to spawn rather than run the card in the shared tree by accident",
  };
}

export type WorktreeConfig = {
  copy: string[];
  /** Raiz OPCIONAL onde as worktrees deste projeto nascem. Ausente = o
   * default curto (`/tmp/stellar-wt`). Existe porque o caminho precisa ser
   * curto (socket, 108 bytes) MAS executável — em distros onde `/tmp` é
   * `noexec`, `vendor/bin/*` não roda de lá; o projeto declara uma raiz
   * curta e executável própria. Sempre absoluta. */
  worktreeRoot?: string;
};

export type WorktreeConfigParse =
  { ok: true; config: WorktreeConfig } | { ok: false; error: string };

/**
 * Parseia a declaração por projeto. Contrato:
 * - ausente/vazio → `{ copy: [] }` (worktree crua; ausência é dado).
 * - JSON quebrado, não-objeto, `copy` não-array, entrada não-string, vazio,
 *   absoluto ou que escape a raiz (`..`), `worktreeRoot` não-absoluto →
 *   RECUSA nomeando o problema: uma declaração malformada é um erro do
 *   projeto, e copiar um subconjunto adivinhado esconderia a worktree
 *   quebrada até o teste falhar.
 * - caminhos normalizados (`a//b`, `./a` → `a/b`), deduplicados.
 */
export function parseWorktreeConfig(raw: string | null | undefined): WorktreeConfigParse {
  if (raw === null || raw === undefined || raw.trim() === "")
    return { ok: true, config: { copy: [] } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${WORKTREE_CONFIG_REL_PATH} is not valid JSON` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${WORKTREE_CONFIG_REL_PATH} must be a JSON object like {"copy": ["vendor", ".env"]}`,
    };
  }
  const rawRoot = (parsed as Record<string, unknown>).worktreeRoot;
  let worktreeRoot: string | undefined;
  if (rawRoot !== undefined) {
    if (typeof rawRoot !== "string" || rawRoot.trim().length === 0) {
      return {
        ok: false,
        error: `${WORKTREE_CONFIG_REL_PATH} "worktreeRoot" must be a non-empty absolute path`,
      };
    }
    if (!isAbsolute(rawRoot.trim())) {
      return {
        ok: false,
        error: `${WORKTREE_CONFIG_REL_PATH} "worktreeRoot" must be absolute, got "${rawRoot.trim()}"`,
      };
    }
    worktreeRoot = rawRoot.trim();
  }
  const rawCopy = (parsed as Record<string, unknown>).copy;
  if (rawCopy === undefined) return { ok: true, config: { copy: [], worktreeRoot } };
  if (!Array.isArray(rawCopy)) {
    return {
      ok: false,
      error: `${WORKTREE_CONFIG_REL_PATH} "copy" must be an array of repo-relative paths`,
    };
  }
  const copy: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawCopy) {
    if (typeof entry !== "string") {
      return { ok: false, error: `${WORKTREE_CONFIG_REL_PATH} "copy" entries must be strings` };
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0)
      return { ok: false, error: `${WORKTREE_CONFIG_REL_PATH} has an empty "copy" path` };
    if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      return {
        ok: false,
        error: `${WORKTREE_CONFIG_REL_PATH} path "${trimmed}" must be relative to the repo root`,
      };
    }
    const parts = trimmed.split(/[\\/]+/);
    if (parts.some((p) => p === "..")) {
      return {
        ok: false,
        error: `${WORKTREE_CONFIG_REL_PATH} path "${trimmed}" escapes the repo root`,
      };
    }
    const normalized = parts.filter((p) => !EMPTY_SEGMENTS.has(p)).join("/");
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    copy.push(normalized);
  }
  return { ok: true, config: { copy, worktreeRoot } };
}

/** Nome de repo → segmento de diretório seguro e curto. Nunca vazio. */
export function sanitizeRepoName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 24);
  return cleaned.length > 0 ? cleaned : "repo";
}

export type WorktreePathDecision = { ok: true; path: string } | { ok: false; error: string };

/**
 * Monta `<root>/<repo>-<uniqueId>` e recusa se passar do orçamento de bytes.
 * Determinístico de propósito (sem `Date.now()`/random aqui): o id único é
 * responsabilidade do chamador impuro, para o teste fixar o valor.
 */
export function buildWorktreePath(opts: {
  root: string;
  repoName: string;
  uniqueId: string;
}): WorktreePathDecision {
  const path = join(opts.root, `${sanitizeRepoName(opts.repoName)}-${opts.uniqueId}`);
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > WORKTREE_PATH_MAX_BYTES) {
    return {
      ok: false,
      error:
        `generated worktree path "${path}" is ${bytes} bytes, over the ${WORKTREE_PATH_MAX_BYTES}-byte budget ` +
        "(Unix socket sun_path is 108 bytes; docs/ORCHESTRATION.md §15) — use a shorter worktree root",
    };
  }
  return { ok: true, path };
}

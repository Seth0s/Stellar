import { open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ResumeTargetEvidence } from "./session-resume-validation";

const POLL_MS = 1500;
const TIMEOUT_MS = 30_000;
// Achado ao vivo (2026-09-07) — Codex nunca restaurava sessão: o Codex TUI
// só grava a entrada em `~/.codex/session_index.jsonl` bem depois do início
// real da sessão (embedded timestamp do rollout vs. mtime do index, medido
// neste mesmo host): 36s num caso, 211s (3.5min) noutro. Ambos passam do
// TIMEOUT_MS de 30s compartilhado por todo provider, então o watcher sempre
// desistia antes do Codex escrever o índice — `resumeId` ficava `null` pra
// sempre e o próximo launch simplesmente abria uma sessão nova vazia
// (indistinguível de "falhou a restaurar"). Cursor grava quase
// instantaneamente (~2s) — 30s continua certo pra ele.
//
// CORREÇÃO (2026-09-11, investigação do achado 1 abaixo) — "Claude...
// grava quase instantaneamente" acima estava ERRADO, nunca tinha sido
// medido contra o CLI real: `claude` deixado ocioso por 40s (pty real,
// env limpo de CLAUDE_CODE_*/CLAUDECODE/CLAUDE_PID/CLAUDE_EFFORT/AI_AGENT
// como `pty-registry.ts::isInheritedClaudeSessionEnvKey` já faz — sem
// isso o processo filho herda `CLAUDE_CODE_CHILD_SESSION` de QUEM RODOU O
// TESTE e desliga "transcript saving" sozinho, invalidando a medição) não
// cria arquivo NENHUM em `~/.claude/projects/<slug>/` — nem um stub. O
// primeiro byte só sai ~0.1s DEPOIS do primeiro prompt ser submetido, não
// perto do spawn. `opencode` tem o mesmo padrão (zero linha na tabela
// `session` até o submit). Ver `REARM_ON_INPUT_PROVIDERS` logo abaixo,
// que essa medição levou a corrigir.
const CODEX_TIMEOUT_MS = 6 * 60_000;

/**
 * Review adversarial (2026-09-11), achado 1 (o mais grave) — estender
 * `REARM_ON_INPUT_PROVIDERS` para claude/opencode (logo abaixo) fecha o
 * achado 1 original, mas PIORA a corrida que a própria investigação já
 * tinha provado existir (10/10 rodadas, script isolado fora do board):
 * `claimedSessionIds` impede RECLAIM do mesmo id por dois watchers, mas
 * não amarra arquivo nenhum ao PTY que o escreveu — atribuição é "primeiro
 * watcher a ver". Antes desta rodada, a janela de um card "faminto" (sem
 * sessão ainda) era fixa: `TIMEOUT_MS` a partir do SPAWN, e morria de vez.
 * Com rearm-on-input, a janela se RENOVA a cada linha de input — um card A
 * que recebe input aos 40s e cujo arquivo demora/falha continua com
 * watcher vivo indefinidamente, pronto pra sequestrar o arquivo que um
 * card B, mesmo cwd, cria ao receber SEU PRÓPRIO input aos 50s.
 *
 * Fix: a medição desta mesma investigação já deu a evidência de posse que
 * faltava — o arquivo nasce ~0.13s (claude) / ~70ms (opencode) DEPOIS do
 * input real ser processado, não em qualquer ponto de uma janela de 30s.
 * Isso é um vínculo TEMPORAL forte entre "um candidato apareceu" e "QUAL
 * card acabou de receber input". `MATCH_GRACE_MS` é esse vínculo: quando
 * um watcher é REARMADO por uma linha de input real (nunca no watch
 * inicial do spawn — ver `rearmSessionWatch`/`write` em `pty-registry.ts`),
 * um candidato só é aceito se `mtime` cair dentro de
 * `[floor, momento-deste-rearm + MATCH_GRACE_MS]`, não em qualquer ponto
 * até o `TIMEOUT_MS` inteiro. Generoso o bastante acima da latência
 * medida (75×+ pro pior caso, opencode) pra tolerar uma máquina mais lenta
 * sem virar falso negativo, mas reduz o antigo "qualquer ponto numa janela
 * de 30s renovada pra sempre" pra "poucos segundos depois do MEU último
 * input real" — encolhe a corrida por ordens de grandeza, não a elimina
 * (dois cards recebendo input a menos de `MATCH_GRACE_MS` um do outro, no
 * mesmo cwd, ainda podem colidir — residual, documentado, não escondido).
 * Ancorado no momento do REARM (não no `floor`, que RODADA 7 pode manter
 * pinado por várias linhas seguidas enquanto um watcher já está em voo —
 * ver o histórico de `scanFloorMs` em `pty-registry.ts`) porque só assim
 * uma sequência de rearms ao longo de um período longo continua
 * estendendo a tolerância a partir da atividade mais recente de verdade,
 * em vez de travar num prazo calculado a partir de uma linha antiga.
 * `cursor`/`codex` não usam isto — não estão em `REARM_ON_INPUT_PROVIDERS`
 * e não têm a janela que se renove, então não ganham a exposição nova que
 * este mecanismo existe pra fechar.
 */
export const MATCH_GRACE_MS = 10_000;

/** Pura, testável (mesmo precedente de `decideRearmOnLine`/
 * `decideResumeValidity`): um candidato é "fresco" se seu `mtime` for mais
 * novo que o piso E (quando um prazo de correspondência foi passado — só
 * acontece num watcher rearmado por input real, nunca no watch inicial do
 * spawn) não mais novo que esse prazo. `matchDeadlineMs` `undefined`
 * preserva o comportamento de sempre (sem teto, só o piso). */
export function isFreshCandidate(mtimeMs: number, floorMs: number, matchDeadlineMs?: number): boolean {
  if (mtimeMs <= floorMs) return false;
  if (matchDeadlineMs !== undefined && mtimeMs > matchDeadlineMs) return false;
  return true;
}

/**
 * DESIGN-BACKLOG.md item 57, ponto 5 — real bug, confirmed live: two
 * fresh (no resumeId) terminal cards for the same provider+cwd each run
 * their own `watchForSession` poller, but every `find*Session` below used
 * to just return the single most-recently-modified session file across
 * the WHOLE shared directory/log — with no notion of which watcher a
 * candidate "belongs" to. A session file that's still being actively
 * appended to (a real, ongoing conversation in ANOTHER card) could
 * out-rank a different card's own, quieter, brand-new session, so two
 * cards converged on the exact same discovered session id. Module-level
 * (not per-watcher) because the whole point is cross-watcher visibility:
 * once a session id is attributed to one card, no other still-polling
 * watcher may claim it, no matter whose poll tick sees it next. Lives for
 * the app's lifetime, deliberately never cleared — a claimed id should
 * never be handed to a second card later either.
 *
 * Achado ao vivo (2026-09-06) — a "narrow residual race" documentada
 * abaixo aconteceu de verdade em produção: dois cards com o MESMO cwd
 * (`/home/lucas/Workplace/Projects`) persistiram o mesmo `resume_id` no
 * banco (`SELECT resume_id, count(*) ... GROUP BY resume_id HAVING
 * count(*) > 1` no `agent-canvas.db` ao vivo confirmou o par). Cada
 * watcher faz `readdir`+`stat` (I/O assíncrono, `findClaudeSession`) antes
 * de decidir seu "best" candidato — se os dois pollers (setInterval
 * independentes, um por watcher) disparam perto o bastante um do outro,
 * o segundo pode terminar seu próprio `readdir`/`stat` e computar o MESMO
 * "best" ANTES do primeiro ter chamado `claimSessionId()`, já que
 * nada serializa essa seção crítica entre watchers diferentes — só
 * dentro do mesmo watcher (um `setInterval` nunca sobrepõe consigo
 * mesmo). Fix: `runExclusive` abaixo — uma fila de promises COMPARTILHADA
 * entre TODOS os watchers (não só claude/codex/cursor entre si, o mesmo
 * global) — garante que o "achar candidato + reivindicar" de qualquer
 * watcher nunca roda concorrente com o de outro, não importa como os
 * timers reais caiam. `session-watch-collision-stress.mjs` reproduz a
 * colisão de verdade (watchers simultâneos, mesmo spawnedAtMs, um único
 * arquivo candidato) — falha ~sempre sem isto, nunca falhou com isto.
 */
/**
 * RODADA 8 (2026-09-10), achado 2 — `Set<string>` até esta rodada, com um
 * `delete()` assumindo (errado) que um id só tem UM detentor por vez. Dois
 * cards restaurados com o MESMO `resumeId` explícito (achado real: um
 * board reaberto com dois cards apontando pro mesmo `resume_id` — ver o
 * histórico de `claimSessionId` logo abaixo) chamam `claimSessionId` cada
 * um o seu, e os dois legitimamente "detêm" o mesmo id ao mesmo tempo. Se
 * um deles depois troca de sessão via `/resume` e `releaseSessionId`
 * apaga o id do Set incondicionalmente, o OUTRO card — que continua
 * usando aquela sessão de verdade — fica sem proteção: um terceiro
 * watcher pode reivindicar (e sobrescrever) uma sessão em uso ativo.
 * `Map<string, number>` (contagem de referências) em vez de `Set`:
 * liberar só derruba a proteção quando o ÚLTIMO detentor solta o id.
 */
const claimedSessionIds = new Map<string, number>();

type SessionCandidate = {
  id: string;
  /**
   * The provider's best cheap timestamp for the candidate's first visible
   * write. Files use mtime, cursor uses meta.createdAtMs, and opencode uses
   * session.time_created (not a later turn's time_updated). Codex never enters the rearm path, so its index
   * candidates do not need a timestamp here.
   */
  timestampMs?: number;
};

type RearmReservation = {
  ownerId: string;
  rearmAtMs: number;
  matchStartMs: number;
  matchDeadlineMs: number;
};

/**
 * One card's watcher must not win merely because it polls first. There is no
 * provider-independent session-to-PTY id in these on-disk stores, but a
 * rearm gives us two cheap pieces of ownership evidence: the card id and the
 * input timestamp that caused the rearm. Keep those reservations by
 * provider+cwd so a candidate created after two nearby inputs is awarded to
 * the most recent input, while a candidate created before the newer input is
 * still available to the earlier watcher. A reservation is removed when its
 * watcher is cancelled, finds a session, or times out.
 */
const rearmReservations = new Map<string, Map<string, RearmReservation>>();

function reservationScope(providerId: string, cwd: string): string {
  return `${providerId}\u0000${cwd}`;
}

function registerRearmReservation(
  providerId: string,
  cwd: string,
  reservation: RearmReservation,
): () => void {
  const scope = reservationScope(providerId, cwd);
  let reservations = rearmReservations.get(scope);
  if (!reservations) {
    reservations = new Map();
    rearmReservations.set(scope, reservations);
  }
  reservations.set(reservation.ownerId, reservation);
  return () => {
    if (reservations?.get(reservation.ownerId) !== reservation) return;
    reservations.delete(reservation.ownerId);
    if (reservations.size === 0) rearmReservations.delete(scope);
  };
}

function canClaimRearmedCandidate(providerId: string, cwd: string, candidate: SessionCandidate, ownerId?: string): boolean {
  // A rearm reservation is only meaningful for providers whose candidate has
  // a creation/update timestamp. The only provider without one (codex) never
  // enters this path, but keeping the fallback makes the helper conservative
  // if another index-backed provider is added later.
  if (!ownerId || candidate.timestampMs === undefined) return true;
  const reservations = rearmReservations.get(reservationScope(providerId, cwd));
  if (!reservations) return true;

  let newestMatchingReservation: RearmReservation | null = null;
  for (const reservation of reservations.values()) {
    // A candidate that predates a later input cannot belong to that later
    // input. The deadline is included for clarity and protects this helper
    // if a caller ever supplies a candidate outside its own find* filter.
    if (candidate.timestampMs <= reservation.matchStartMs || candidate.timestampMs > reservation.matchDeadlineMs) {
      continue;
    }
    if (!newestMatchingReservation || reservation.rearmAtMs > newestMatchingReservation.rearmAtMs) {
      newestMatchingReservation = reservation;
    }
  }
  return newestMatchingReservation === null || newestMatchingReservation.ownerId === ownerId;
}

/**
 * Achado ao vivo (2026-09-07) — 3 cards Claude diferentes exibindo o MESMO
 * `resume:<id>` no rodapé. Causa: um card restaurado do DB (`spawnOpts.
 * resumeId` já preenchido) pula `watchForSession` inteiramente (ver o `if
 * (!spawnOpts.resumeId)` em pty-registry.ts) — logo seu id nunca passava por
 * `claimedSessionIds`. Pra qualquer watcher de um card novo no mesmo cwd,
 * esse arquivo de sessão (que pode estar sendo escrito ativamente pelo
 * card restaurado) parecia livre pra reivindicar. Chame isto assim que um
 * `resumeId` conhecido é usado pra spawnar/restaurar um card, antes de
 * qualquer watcher rodar — fecha o gap sem esperar um "found" que nunca vem.
 *
 * RODADA 8, achado 2 — agora incrementa uma contagem em vez de só marcar
 * presença: chamar isto duas vezes pro MESMO id (dois cards restaurados
 * com o mesmo `resumeId`) soma 2 detentores, não é idempotente à toa.
 */
export function claimSessionId(id: string): void {
  claimedSessionIds.set(id, (claimedSessionIds.get(id) ?? 0) + 1);
}

/**
 * Review adversarial RODADA 7 (2026-09-10), achado 2 — `claimSessionId`
 * era push sem pop. Um card que troca de sessão via `/resume` claim a
 * NOVA id (via `watchForSession`'s próprio `claimSessionId`, ver o achado
 * abaixo) mas a ANTIGA, agora abandonada por aquele card, ficava
 * reivindicada pra sempre neste processo — nenhum card futuro (nem outro
 * `/resume` do mesmo card, se ele voltar atrás) conseguiria descobrir
 * aquele arquivo de sessão de novo.
 *
 * Chamada só por `pty-registry.ts` quando um card CONFIRMADAMENTE troca
 * de sessão (no callback de sucesso de um rearm por trigger, nunca antes
 * — enquanto o `/resume` ainda está em aberto no picker, o card
 * continua efetivamente "usando" a sessão antiga, cancelável) — e só com
 * o id que aquele MESMO card tinha reivindicado antes (`entry.
 * claimedSessionId`, rastreado por-card), nunca um id arbitrário.
 *
 * RODADA 8, achado 2 — a suposição de exclusividade ("um id só pertence a
 * um card de cada vez", texto original deste comentário) era falsa: dois
 * cards podem legitimamente compartilhar o mesmo `resumeId` (dois cards
 * restaurados do mesmo `resume_id`, cenário real). Decrementa em vez de
 * apagar — o id só sai de `claimedSessionIds` de fato quando o ÚLTIMO
 * detentor o libera, então o card irmão que ainda está usando a sessão
 * continua protegido contra um terceiro watcher roubá-la em pleno uso.
 */
export function releaseSessionId(id: string): void {
  const count = claimedSessionIds.get(id);
  if (count === undefined) return;
  if (count <= 1) claimedSessionIds.delete(id);
  else claimedSessionIds.set(id, count - 1);
}

/**
 * RODADA 8, achado 2 — hook só de observação, pra teste: deixa uma
 * suíte checar o estado da contagem de referências direto (isSessionId
 * Claimed), sem precisar mockar filesystem/`watchForSession` inteiro só
 * pra provar que dois `claimSessionId` + um `releaseSessionId` no mesmo id
 * deixam a proteção de pé. Nenhum chamador real usa isto.
 */
export function isSessionIdClaimed(id: string): boolean {
  return claimedSessionIds.has(id);
}

/**
 * Pedido ao vivo (2026-09-07) — nada nunca refresca `resumeId` depois do
 * spawn: quem roda `/resume` DENTRO de um card já aberto troca de sessão
 * por baixo (o processo passa a escrever num arquivo de sessão diferente,
 * já existente, escolhido no picker), mas o rodapé do card continua
 * mostrando o id antigo pra sempre — só o id descoberto no spawn é
 * reportado (ver `reportedRef` em TerminalCard.tsx). Único trigger
 * confirmado até agora: o slash command `/resume` do próprio Claude Code
 * (documentado). Os outros providers podem ter equivalentes, mas não
 * foram confirmados contra um CLI real rodando — mesmo critério das
 * lacunas documentadas acima (antigravity) — então ficam de fora até
 * serem confirmados, não adivinhados.
 */
export const RESUME_TRIGGER_COMMANDS: Partial<Record<string, string>> = {
  claude: "/resume",
};

/**
 * Review adversarial RODADA 2 (2026-09-09), achado 1 — antigravity's own
 * problem, distinct from `RESUME_TRIGGER_COMMANDS` above: `agy` only
 * writes its on-disk conversation file (what `findAntigravitySession`
 * scans for) after a prompt is submitted, not at spawn. A card spawned
 * and left idle for a real orchestrator briefing (`send_to_card` — a
 * real pattern on this board, not hypothetical) can sit well past
 * `TIMEOUT_MS` before any prompt ever arrives, exactly what happened to
 * real cards 294/296/298. Inflating the timeout only delays the same
 * failure for an even-idler card. The actual fix:
 * `pty-registry.ts::write` rearms this provider's `watchForSession` on
 * EVERY non-empty input line that reaches the card's PTY — reusing the
 * exact same input-buffering/line-detection machinery
 * `RESUME_TRIGGER_COMMANDS` already established, just triggering on any
 * completed line instead of one specific trigger phrase. This list says
 * which providers want that "rearm on input" behavior — originally just
 * antigravity, on the ASSUMED premise that every other provider's session
 * file already appears close enough to spawn time that a rearm would add
 * nothing.
 *
 * CORREÇÃO (2026-09-11) — essa premissa nunca tinha sido testada contra
 * um CLI real, e caiu: DESIGN-BACKLOG.md's "resume_id nao sobrevive ao
 * restart" achado 1, relatado ao vivo pelo dono do repo, listava 3 cards
 * `claude` reais (321/323/325/327, spawnados via `spawn_agent` e
 * briefados só depois via `send_to_card` — exatamente o padrão
 * "spawnado-e-deixado-ocioso" que a RODADA 2 já tinha documentado pro
 * antigravity) com `resume_id` NULL depois de trabalharem a noite
 * inteira. Medido ao vivo (pty real via `pty.fork`, env limpo dos mesmos
 * `CLAUDE_CODE_*`/`CLAUDECODE`/`CLAUDE_PID`/`CLAUDE_EFFORT`/`AI_AGENT`
 * que `pty-registry.ts::isInheritedClaudeSessionEnvKey` já remove antes
 * de todo spawn real — sem isso o processo filho herda
 * `CLAUDE_CODE_CHILD_SESSION` de quem RODOU o teste e desliga "transcript
 * saving" sozinho, invalidando a medição):
 *   - `claude`: 40s de idle puro (dialog de trust já dispensado) não
 *     cria NENHUM arquivo em `~/.claude/projects/<slug>/` — nem um stub.
 *     Um prompt de verdade cria o primeiro arquivo em ~0.1s depois do
 *     submit, não do spawn. Ou seja, o arquivo nasce no SUBMIT, e este
 *     provider tem exatamente o mesmo problema que o antigravity: um
 *     card spawnado e briefado só depois pode facilmente passar de
 *     `TIMEOUT_MS` (30s) antes do primeiro prompt sequer existir.
 *   - `opencode`: mesmo padrão — 15s de idle sem NENHUMA linha nova na
 *     tabela `session` de `~/.local/share/opencode/opencode.db`; a linha
 *     só aparece ~70ms depois de um prompt real ser enviado. Estava
 *     ausente desta lista E de `RESUME_TRIGGER_COMMANDS` — pior cobertura
 *     que claude, que ao menos tinha o gancho explícito de `/resume`.
 *   - `cursor`: confirmado SEGURO como estava — `meta.json` com o `cwd`
 *     certo aparece ~0.7s depois de confirmar o dialog de "workspace
 *     trust", ANTES de qualquer prompt. Continua fora desta lista.
 * `codex` fica de fora também, mas por razão distinta: já tem
 * `CODEX_TIMEOUT_MS` (6min) cobrindo a mesma classe de atraso (medido:
 * 36s–211s pra escrever o índice) — funciona hoje, mas é "esperar mais"
 * em vez de rearm-on-input; se o pior caso já medido crescer, vale
 * reconsiderar. `bash` nunca teve conceito de sessão, fora de cogitação.
 *
 * RODADA 3 (review adversarial, 2026-09-09), achado 1 — a first pass
 * here rearmed only on the FIRST such line (once per card, guarded by a
 * flag), reasoning that "idle since spawn" only needed converting once
 * into "idle since the last real interaction". Wrong: the first line of
 * a multi-line paste (shift+enter, a long pasted briefing) restarts the
 * clock too early, and it can expire again before the actual submit —
 * the exact class of bug this whole fix exists to close, just moved one
 * step later. Rearming on EVERY non-empty line for the card's whole
 * lifetime fixes that: the window always counts from the card's last
 * real activity, not from an arbitrary earlier point, and each rearm is
 * cheap (`rearmSessionWatch` cancels its own previous watch first — see
 * that function's own doc comment — so repeated rearms never leak a
 * timer or stack a second poller). Not exact-submission-precise even
 * now (a `\r` mid multi-line-paste still restarts the clock before the
 * final Enter) — still good enough on purpose: the point was never
 * detecting the precise submit moment, just keeping the window's start
 * honest relative to real activity instead of a spawn-time guess.
 */
export const REARM_ON_INPUT_PROVIDERS: readonly string[] = ["antigravity", "claude", "opencode"];

let claimQueue: Promise<unknown> = Promise.resolve();
/** Serializa a seção crítica (achar candidato + `claimSessionId`)
 * entre TODOS os watchers, não só os de um mesmo provider — a fila é
 * módulo-level de propósito, mesmo raciocínio de `claimedSessionIds`
 * acima: o ponto é visibilidade entre watchers, não por-watcher. */
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = claimQueue.then(fn, fn);
  claimQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

async function findClaudeSession(cwd: string, spawnedAtMs: number, matchDeadlineMs?: number): Promise<SessionCandidate | null> {
  const dir = join(homedir(), ".claude", "projects", encodeCwdForClaude(cwd));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: { id: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (claimedSessionIds.has(id)) continue;
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st || !isFreshCandidate(st.mtimeMs, spawnedAtMs, matchDeadlineMs)) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { id, mtimeMs: st.mtimeMs };
    }
  }
  return best ? { id: best.id, timestampMs: best.mtimeMs } : null;
}

// Codex's session_index.jsonl is append-only — track byte offset at spawn
// time and only parse what's new, per watcher (module-level, keyed by cwd
// isn't needed: each watcher tracks its own offset independently).
async function findCodexSession(sinceOffset: number): Promise<{ candidate: SessionCandidate | null; newOffset: number }> {
  const file = join(homedir(), ".codex", "session_index.jsonl");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return { candidate: null, newOffset: sinceOffset };
  }
  if (content.length <= sinceOffset) return { candidate: null, newOffset: content.length };
  const added = content.slice(sinceOffset);
  const lines = added.split("\n").filter((l) => l.trim());
  let id: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.id === "string" && !claimedSessionIds.has(parsed.id)) id = parsed.id;
    } catch {
      // partial line (file mid-write) — ignore, next poll will re-read it whole.
    }
  }
  return { candidate: id ? { id } : null, newOffset: content.length };
}

async function findCursorSession(cwd: string, spawnedAtMs: number, matchDeadlineMs?: number): Promise<SessionCandidate | null> {
  const chatsDir = join(homedir(), ".cursor", "chats");
  let hashDirs: string[];
  try {
    hashDirs = await readdir(chatsDir);
  } catch {
    return null;
  }
  let best: { id: string; createdAtMs: number } | null = null;
  for (const hash of hashDirs) {
    const hashPath = join(chatsDir, hash);
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(hashPath);
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      if (claimedSessionIds.has(sessionId)) continue;
      const metaPath = join(hashPath, sessionId, "meta.json");
      let meta: { cwd?: string; createdAtMs?: number };
      try {
        meta = JSON.parse(await readFile(metaPath, "utf8"));
      } catch {
        continue;
      }
      if (
        meta.cwd !== cwd ||
        typeof meta.createdAtMs !== "number" ||
        !isFreshCandidate(meta.createdAtMs, spawnedAtMs, matchDeadlineMs)
      ) continue;
      if (!best || meta.createdAtMs > best.createdAtMs) {
        best = { id: sessionId, createdAtMs: meta.createdAtMs };
      }
    }
  }
  return best ? { id: best.id, timestampMs: best.createdAtMs } : null;
}

async function findOpenCodeSession(cwd: string, spawnedAtMs: number, matchDeadlineMs?: number): Promise<SessionCandidate | null> {
  // opencode (sst/opencode, see providers.ts) keeps its own sessions in a
  // real sqlite db (`~/.local/share/opencode/opencode.db`, `session` table
  // — schema confirmed live on this machine via `PRAGMA table_info`), not
  // in loose files like the others. Opened readonly: this db belongs to a
  // separate app that may have it open (WAL mode) at the same time.
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    // `time_created`, not `time_updated`: an old session receiving a later
    // turn is not evidence that this newly rearmed card created it.
    const rows = db
      .prepare("SELECT id, time_created FROM session WHERE directory = ? AND time_created > ? ORDER BY time_created DESC")
      .all(cwd, spawnedAtMs) as { id: string; time_created: number }[];
    for (const row of rows) {
      if (!claimedSessionIds.has(row.id) && isFreshCandidate(row.time_created, spawnedAtMs, matchDeadlineMs)) {
        return { id: row.id, timestampMs: row.time_created };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * DESIGN-BACKLOG.md, achado 2 (2026-09-11) — encaminhamento 3: validação na
 * LEITURA, antes de honrar um `resumeId` restaurado (`pty-registry.ts`'s
 * `spawn`, quando `spawnOpts.resumeId` já vem preenchido do DB). Cada
 * provider guarda sessão num formato/lugar diferente — este é o único
 * módulo que já precisa conhecer esses layouts (mesma razão dos `find*`
 * acima), então a leitura de evidência mora aqui; a DECISÃO pura fica em
 * `session-resume-validation.ts` (mesmo split que `decideRearmOnLine` já
 * estabeleceu — I/O de um lado, lógica testável do outro).
 *
 * Síncrono de propósito: `pty-registry.ts::spawn` monta os argumentos do
 * CLI (incluindo `--resume <id>`) e chama `pty.spawn` de forma síncrona;
 * validar antes precisa terminar antes dessa decisão, e um `stat`/leitura
 * de índice é barato o bastante (uma vez por spawn, nunca num loop) pra
 * não justificar reestruturar `spawn` inteiro em async só por isto.
 *
 * `hasContent` por provider (guarda de sanidade, NÃO a definição de
 * "turno completo" do encaminhamento 2 — ver o próprio doc comment de
 * `decideResumeValidity`). Duas rodadas de review adversarial (2026-09-11)
 * já provaram furos em versões anteriores desta lista — ver os doc
 * comments de `findCursorSessionEvidence` e `findOpenCodeSessionEvidence`
 * pra cada achado específico:
 *   - claude/antigravity: tamanho do arquivo de sessão. `MIN_CONTENT_BYTES`
 *     é deliberadamente minúsculo (bem abaixo do menor stub real medido —
 *     ~268 bytes pro primeiro write do claude) — o objetivo aqui é só
 *     pegar "não existe conteúdo nenhum" (0 bytes / arquivo truncado),
 *     nunca arriscar marcar uma conversa real e curta como inválida.
 *   - cursor: EXISTÊNCIA de `store.db` dentro do diretório da sessão (não
 *     mais um limiar de bytes — uma versão anterior comparava a soma do
 *     diretório com `MIN_CONTENT_BYTES`, mas até uma sessão vazia real já
 *     tem 138-169 bytes só de `meta.json`, sempre acima do limiar: a
 *     checagem nunca reprovava nada).
 *   - opencode: pelo menos uma linha na tabela `message` pra este
 *     `session_id` (não mais `tokens_input`/`tokens_output`/`cost` da
 *     própria linha — uma versão anterior usava isso, mas essas colunas
 *     continuam zeradas até o FIM do turno, então um prompt real cujo
 *     processo morre antes da resposta terminar era descartado como
 *     "vazio", perdendo conteúdo de verdade).
 *   - codex: melhor esforço, mais fraco que os outros de propósito
 *     assumido — o conteúdo real do rollout não foi localizado nesta
 *     investigação (só o índice `session_index.jsonl`, que não carrega
 *     nenhum sinal de tamanho/atividade). `exists` aqui só confirma que o
 *     id aparece no índice; `hasContent` acompanha `exists` sem checagem
 *     adicional. Não regride nada (codex nunca teve este tipo de
 *     validação antes), mas não teve a mesma medição ao vivo que
 *     claude/opencode/cursor tiveram — documentado, não escondido.
 */
const MIN_CONTENT_BYTES = 16;

function fileEvidence(path: string): ResumeTargetEvidence {
  if (!existsSync(path)) return { exists: false, hasContent: false };
  try {
    const size = statSync(path).size;
    return { exists: true, hasContent: size >= MIN_CONTENT_BYTES };
  } catch {
    // Achado entre o `existsSync` e o `statSync` (arquivo apagado por
    // fora bem no meio da checagem) — trata como "não existe", nunca
    // deixa uma exceção subir e derrubar o spawn inteiro por causa de uma
    // checagem que é só uma guarda de sanidade.
    return { exists: false, hasContent: false };
  }
}

function findClaudeSessionDirEvidence(cwd: string, resumeId: string): ResumeTargetEvidence {
  const path = join(homedir(), ".claude", "projects", encodeCwdForClaude(cwd), `${resumeId}.jsonl`);
  return fileEvidence(path);
}

function findAntigravitySessionEvidence(resumeId: string): ResumeTargetEvidence {
  const path = join(homedir(), ".gemini", "antigravity-cli", "conversations", `${resumeId}.db`);
  return fileEvidence(path);
}

/**
 * Review adversarial (2026-09-11), achado 3 — a versão original somava o
 * tamanho de TODOS os arquivos do diretório e comparava com
 * `MIN_CONTENT_BYTES` (16). Furo provado pela PRÓPRIA medição desta
 * investigação: uma sessão cursor vazia (nunca recebeu prompt) já tem
 * `meta.json` sozinho com 138-169 bytes — bem acima de 16 — então a
 * checagem sempre devolvia `hasContent: true`, pra QUALQUER sessão,
 * fantasma ou real. Nunca reprovava nada.
 *
 * Investigado ao vivo (fora do board, diretórios de teste limpos depois):
 * o conteúdo de verdade de uma conversa cursor mora em `store.db` (sqlite,
 * modo WAL) dentro do diretório da sessão — `meta.json`/
 * `prompt_history.json` são só metadados, sempre pequenos, presentes
 * mesmo numa sessão nunca usada. Confirmado com 3 diretórios reais: um
 * vazio (só `meta.json`, 138-169 bytes, sem `store.db` nenhum) e dois
 * com conversa de verdade (ambos com `store.db` presente desde a primeira
 * troca — uma sessão de "say hi" já tinha `store.db-wal` de 230KB). A
 * EXISTÊNCIA de `store.db` já é um sinal binário limpo — a app cursor só
 * cria esse arquivo quando uma conversa de fato começa, nunca no spawn da
 * sessão vazia — então usar tamanho aqui seria reintroduzir o mesmo tipo
 * de número mágico que acabou de provar furado, sem necessidade.
 */
function findCursorSessionEvidence(resumeId: string): ResumeTargetEvidence {
  const chatsDir = join(homedir(), ".cursor", "chats");
  let hashDirs: string[];
  try {
    hashDirs = readdirSync(chatsDir);
  } catch {
    return { exists: false, hasContent: false };
  }
  for (const hash of hashDirs) {
    const sessionDir = join(chatsDir, hash, resumeId);
    if (!existsSync(sessionDir)) continue;
    return { exists: true, hasContent: existsSync(join(sessionDir, "store.db")) };
  }
  return { exists: false, hasContent: false };
}

/**
 * Review adversarial (2026-09-11), achado 2 (falso negativo, o pior tipo)
 * — a versão original usava `tokens_input > 0 || tokens_output > 0 ||
 * cost > 0` da própria linha de `session`. Furo real, reproduzido ao vivo
 * (opencode de verdade, cwd de teste, fora do board): usuário manda um
 * prompt e o processo morre (kill) ANTES do modelo terminar de responder
 * — a linha em `session` nasce com `tokens_input=0, tokens_output=0,
 * cost=0.0` (medido: essas três colunas continuam zeradas mesmo depois de
 * uma mensagem de usuário real já estar gravada) porque opencode só
 * atualiza uso/custo no FIM do turno, não incrementalmente. A checagem
 * antiga descartaria essa sessão como vazia — perda de contexto real, ou
 * seja, exatamente o dano que o encaminhamento 3 existe pra evitar, só
 * que causado pela própria validação.
 *
 * Fix: `message` é uma tabela separada (`session_id` FK), com uma linha
 * por turno — confirmado ao vivo que a linha do usuário já existe ali no
 * mesmo instante em que a sessão nasce, antes de qualquer resposta do
 * modelo. Existência de PELO MENOS UMA linha em `message` é sinal direto
 * de "teve conteúdo real", sem depender de uso/custo terem sido
 * contabilizados.
 */
function findOpenCodeSessionEvidence(resumeId: string): ResumeTargetEvidence {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return { exists: false, hasContent: false };
  }
  try {
    const session = db.prepare("SELECT id FROM session WHERE id = ?").get(resumeId) as { id: string } | undefined;
    if (!session) return { exists: false, hasContent: false };
    const messageCount = db.prepare("SELECT COUNT(*) as n FROM message WHERE session_id = ?").get(resumeId) as { n: number };
    return { exists: true, hasContent: messageCount.n > 0 };
  } catch {
    return { exists: false, hasContent: false };
  } finally {
    db.close();
  }
}

function findCodexSessionEvidence(resumeId: string): ResumeTargetEvidence {
  const file = join(homedir(), ".codex", "session_index.jsonl");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { exists: false, hasContent: false };
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.id === resumeId) return { exists: true, hasContent: true };
    } catch {
      // linha parcial (índice sendo escrito nesse instante) — ignora.
    }
  }
  return { exists: false, hasContent: false };
}

/** Ponto único chamado por `pty-registry.ts::spawn` antes de honrar um
 * `resumeId` restaurado. Providers sem conceito de sessão (`bash`) nunca
 * chegam aqui — o chamador já filtra por isso, mesmo critério de
 * `watchForSession` abaixo. */
export function getResumeTargetEvidence(providerId: string, cwd: string, resumeId: string): ResumeTargetEvidence {
  switch (providerId) {
    case "claude":
      return findClaudeSessionDirEvidence(cwd, resumeId);
    case "antigravity":
      return findAntigravitySessionEvidence(resumeId);
    case "cursor":
      return findCursorSessionEvidence(resumeId);
    case "opencode":
      return findOpenCodeSessionEvidence(resumeId);
    case "codex":
      return findCodexSessionEvidence(resumeId);
    default:
      return { exists: false, hasContent: false };
  }
}

// Achado ao vivo (2026-09-07) — reverse-engineered `~/.gemini/antigravity-cli/
// conversations/<id>.db` (one sqlite file per conversation, id = filename)
// against 8 real conversations on this machine: byte-for-byte, the file's
// working-directory is stored as a standard protobuf length-delimited string
// field — tag byte 0x0a or 0x12 (field 1/2, wire type 2), a single-byte
// varint length, then that many raw UTF-8 bytes of a `file://<cwd>` URI —
// inside the `trajectory_metadata_blob` row whose id is `main`. Confirmed via
// the byte immediately preceding "file://" always equalling the exact
// encoded byte-length of that URI (proper length-prefix, not a guessed
// delimiter). Always landed within the first ~40KB of the file regardless of
// total size (one file was 21MB) — same sqlite page every time — so reads
// are bounded to ANTIGRAVITY_READ_WINDOW_BYTES instead of the whole db.
const ANTIGRAVITY_READ_WINDOW_BYTES = 128 * 1024;

async function extractAntigravityWorkspaceUri(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(ANTIGRAVITY_READ_WINDOW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ANTIGRAVITY_READ_WINDOW_BYTES, 0);
    const slice = buffer.subarray(0, bytesRead);
    const needle = Buffer.from("file://");
    let idx = slice.indexOf(needle);
    while (idx > 1) {
      const lenByte = slice[idx - 1];
      const tagByte = slice[idx - 2];
      if ((tagByte === 0x0a || tagByte === 0x12) && lenByte > 0 && idx + lenByte <= slice.length) {
        const candidate = slice.toString("utf8", idx, idx + lenByte);
        if (Buffer.byteLength(candidate, "utf8") === lenByte && candidate.startsWith("file://")) {
          return candidate;
        }
      }
      idx = slice.indexOf(needle, idx + 1);
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// DESIGN-BACKLOG.md §2.1 "Cards antigravity não têm retomada de sessão" —
// REVERTIDO (review adversarial RODADA 1, 2026-09-09): a hipótese original
// era ler `ANTIGRAVITY_CONVERSATION_ID` do env do próprio processo via
// `/proc/<pid>/environ`, supostamente confirmada por um explorer lendo o
// env de um card antigravity vivo. Provado FALSO por execução real contra
// os `agy` de verdade rodando neste host (`tr '\0' '\n' <
// /proc/<pid>/environ | grep -c ANTIGRAVITY_CONVERSATION_ID` devolveu 0
// nos três processos vivos): `agy` define essa variável em RUNTIME
// (`os.Setenv` em Go), o que muda o `environ` do processo NA MEMÓRIA e é
// herdado por filhos que ele venha a spawnar, mas o kernel NUNCA atualiza
// `/proc/<pid>/environ` depois do `execve` inicial — só reflete o env
// ORIGINAL do processo, nunca uma mutação em runtime. A evidência do
// explorer não provava o que parecia: ele viu a variável rodando `env`
// dentro de um SHELL FILHO do agy (que herda o env de runtime de verdade),
// não lendo o procfs do próprio agy. Conclusão honesta: não há caminho de
// env viável aqui, sem rodar um subprocesso dentro do card (fora de
// cogitação — mexeria no PTY que o usuário está usando).
//
// RODADA 1 do conserto (também revertida) — inflar TIMEOUT_MS pro
// antigravity, copiando CODEX_TIMEOUT_MS. Errado pelo motivo apontado em
// review RODADA 2: o codex só DEMORA a gravar depois de já ter processado
// um prompt; o antigravity espera o PRIMEIRO PROMPT chegar — se um card
// ficar ocioso esperando um briefing por `send_to_card` (padrão real
// deste board, não hipotético) por mais tempo que o timeout escolhido, o
// watcher ainda desiste antes. Aumentar o número só empurra o mesmo
// problema pra um card ainda mais ocioso.
//
// Conserto real: `REARM_ON_INPUT_PROVIDERS` abaixo — o relógio de
// `findAntigravitySession` reinicia a CADA input de verdade que chega no
// PTY deste card (via `pty-registry.ts::write`, o mesmo caminho que
// `send_to_card`/`writeToCard` usam — não um mecanismo paralelo), não num
// tempo fixo contado desde o spawn. Isso dá ao scan em
// disco uma janela de TIMEOUT_MS normal a partir do momento em que `agy`
// está de fato prestes a escrever algo, em vez de adivinhar quanto tempo
// um card vai ficar ocioso.

async function findAntigravitySession(cwd: string, spawnedAtMs: number, matchDeadlineMs?: number): Promise<SessionCandidate | null> {
  const dir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const cwdUri = `file://${cwd}`;
  let best: { id: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".db")) continue; // skip sqlite's own -wal/-shm siblings
    const id = name.slice(0, -".db".length);
    if (claimedSessionIds.has(id)) continue;
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st || !isFreshCandidate(st.mtimeMs, spawnedAtMs, matchDeadlineMs)) continue;
    if (best && st.mtimeMs <= best.mtimeMs) continue;
    const workspaceUri = await extractAntigravityWorkspaceUri(full);
    if (workspaceUri !== cwdUri) continue;
    best = { id, mtimeMs: st.mtimeMs };
  }
  return best ? { id: best.id, timestampMs: best.mtimeMs } : null;
}

/**
 * Polls the on-disk location each provider (undocumented, reverse-engineered
 * on this machine — see AGENTS.md) writes new sessions to, looking for one
 * created after `spawnedAtMs`. Stops after finding one or after ~30s (longer
 * for codex — see CODEX_TIMEOUT_MS). `bash` has no session concept —
 * callers should never call this for it. `opencode` also has no branch
 * needed beyond `findOpenCodeSession` below: unlike the others it keeps a
 * real sqlite db, not loose files.
 *
 * `onTimeout` — review adversarial RODADA 7 (2026-09-10), achado 1. Before
 * this, a natural expiration (ran the full `TIMEOUT_MS` without finding
 * anything) was invisible to the caller: the returned stop function still
 * sat there, callable but stale, with nothing distinguishing "still
 * polling" from "already gave up" — `pty-registry.ts` needs that exact
 * distinction to decide whether a rearm may reuse the current scan floor
 * (a watcher genuinely still in flight — two fast submits landing in the
 * same poll window) or must start a fresh one at "now" (no watcher in
 * flight — the card sat idle long enough for the previous attempt to
 * expire, so anything on disk from that idle stretch, e.g. a session the
 * user opened by hand outside Stellar, must NOT be treated as this card's
 * own). Called ONLY on a real expiration, never when the caller cancels
 * via the returned stop function (that's an intentional supersession —
 * about to start a new watch and log it as the new "in flight" one right
 * after, not a "we're done" signal).
 */
export function watchForSession(
  providerId: string,
  cwd: string,
  spawnedAtMs: number,
  onFound: (sessionId: string) => void,
  onTimeout?: () => void,
  options: {
    /** Card/PTY identity used only for the rearm ownership reservation. */
    ownerId?: string;
    /** Exact input timestamp that caused this rearm. */
    rearmAtMs?: number;
    /** Ownership lower bound; distinct from the candidate scan floor. */
    matchStartMs?: number;
  } = {},
): () => void {
  if (
    providerId !== "claude" &&
    providerId !== "codex" &&
    providerId !== "cursor" &&
    providerId !== "antigravity" &&
    providerId !== "opencode"
  ) {
    return () => {};
  }

  let stopped = false;
  let codexOffset = 0;
  let codexOffsetReady = false;
  const matchStartMs = options.matchStartMs ?? options.rearmAtMs ?? spawnedAtMs;
  const matchDeadlineMs = options.rearmAtMs === undefined ? undefined : options.rearmAtMs + MATCH_GRACE_MS;
  const releaseReservation =
    options.ownerId !== undefined && options.rearmAtMs !== undefined
      ? registerRearmReservation(providerId, cwd, {
          ownerId: options.ownerId,
          rearmAtMs: options.rearmAtMs,
          matchStartMs,
          matchDeadlineMs: options.rearmAtMs + MATCH_GRACE_MS,
        })
      : () => {};
  // Establish the starting offset before the first poll so we only ever
  // look at bytes appended after this watcher started — set once, then
  // `findCodexSession` advances it every subsequent tick.
  const initCodexOffset =
    providerId === "codex"
      ? readFile(join(homedir(), ".codex", "session_index.jsonl"), "utf8")
          .then((c) => c.length)
          .catch(() => 0)
      : Promise.resolve(0);

  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      // `runExclusive` — todo o "achar candidato + reivindicar" roda como
      // seção crítica única entre TODOS os watchers vivos (ver o comentário
      // de `runExclusive` acima); sem isto, dois watchers cujo `readdir`/
      // `stat` interleavam podiam computar o mesmo "best" antes de
      // qualquer um dos dois chamar `claimSessionId`.
      const found = await runExclusive(async () => {
        if (stopped) return null;
        let candidate: SessionCandidate | null;
        if (providerId === "claude") {
          candidate = await findClaudeSession(cwd, spawnedAtMs, matchDeadlineMs);
        } else if (providerId === "codex") {
          if (!codexOffsetReady) {
            codexOffset = await initCodexOffset;
            codexOffsetReady = true;
          }
          const result = await findCodexSession(codexOffset);
          codexOffset = result.newOffset;
          candidate = result.candidate;
        } else if (providerId === "cursor") {
          candidate = await findCursorSession(cwd, spawnedAtMs, matchDeadlineMs);
        } else if (providerId === "antigravity") {
          candidate = await findAntigravitySession(cwd, spawnedAtMs, matchDeadlineMs);
        } else if (providerId === "opencode") {
          candidate = await findOpenCodeSession(cwd, spawnedAtMs, matchDeadlineMs);
        } else {
          candidate = null;
        }
        if (stopped || !candidate || !canClaimRearmedCandidate(providerId, cwd, candidate, options.ownerId)) {
          return null;
        }
        // Claim inside the shared critical section, immediately after the
        // ownership arbitration. This closes the old poller-vs-poller gap:
        // no second watcher can read the same candidate and pass its own
        // `claimedSessionIds` check before this watcher marks it claimed.
        claimSessionId(candidate.id);
        return candidate.id;
      });
      // RODADA 8 (2026-09-10), achado 1 — `stopped` só era checado ANTES
      // do `await runExclusive(...)` acima, no topo deste tick. Se
      // `stop()` (a função devolvida por `watchForSession`, chamada por
      // `pty-registry.ts`'s `rearmSessionWatch` bem antes de reatribuir
      // `entry.stopWatch` pro watcher NOVO) for chamada exatamente
      // enquanto esta tick estava NA FILA do mutex (outro watcher ainda
      // rodando sua própria seção crítica), `stopped` já virava `true`
      // no meio do caminho, mas nada aqui recheca — a tick acordava, via
      // `found` de verdade, e commitava mesmo assim: reivindicava o id,
      // e pior, chamava o `onFound` DESTE watcher (o velho, já
      // cancelado) — que zera `entry.stopWatch` de volta pra `null`,
      // pisando no watcher NOVO que `rearmSessionWatch` já tinha acabado
      // de atribuir ali, e reportando uma sessão pro card com a Entry já
      // corrompida. Recheca aqui, depois do único `await` desta seção
      // crítica, antes de tocar em qualquer estado compartilhado.
      if (stopped) {
        // `stop()` may run in the tiny gap after the critical section
        // returned. The claim was made atomically there, so release it if
        // this cancelled watcher must not commit the result.
        if (found) releaseSessionId(found);
        return;
      }
      if (found) {
        // The remaining ambiguity is provider storage that only exposes a
        // coarse/updated timestamp (an old session can be appended to
        // during the grace interval); there is no portable PTY id in those
        // stores. The temporal reservation is the strongest cheap evidence
        // available and is deliberately conservative about that residual.
        stopped = true;
        clearInterval(timer);
        clearTimeout(timeout);
        releaseReservation();
        onFound(found);
      }
    } catch {
      // Best-effort — a transient read error just means try again next poll.
    }
  }, POLL_MS);

  const timeout = setTimeout(
    () => {
      stopped = true;
      clearInterval(timer);
      releaseReservation();
      onTimeout?.();
    },
    providerId === "codex" ? CODEX_TIMEOUT_MS : TIMEOUT_MS,
  );

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(timeout);
    releaseReservation();
  };
}

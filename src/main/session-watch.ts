import { open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ResumeTargetEvidence } from "./session-resume-validation";
import { decideClaimAmongCandidates, type ReservationView } from "./session-claim-decision";

const POLL_MS = 1500;

/**
 * Descoberta de sessão ancorada em ESTADO, não em relógio. Enquanto o
 * card existir e `resume_id` for null, o poller continua. O gatilho de
 * re-tentativa é uma linha de input real (`REARM_ON_INPUT_PROVIDERS`)
 * ou o próximo tick — nunca um prazo. `claude`/`cursor` normalmente
 * nem entram aqui: o UUID é imposto no spawn e gravado na hora.
 *
 * Corrida (dois cards, mesmo cwd+provider): se dois candidatos sem dono
 * aparecem e nada os distingue, `decideClaimAmongCandidates` recusa o
 * claim — não escolhe por mtime. A reserva de input (quem digitou, e
 * depois de qual instante o arquivo nasceu) é a única evidência barata
 * de posse; se ela empatar ou faltar, o id fica para a ação manual
 * (`pty:identify-session` → `decideIdentifyByProcessEvidence`: ownership
 * via `/proc/<pid>/fd` no Linux, escolha humana se ainda ambíguo —
 * nunca mtime sozinho).
 *
 * HISTÓRICO — não reintroduzir. Até 2026-09-13 a descoberta tinha um
 * prazo de 30s (6min no Codex) e uma janela de graça de 10s após o
 * rearm. As três constantes de relógio foram removidas: um prazo só
 * muda a probabilidade de achar, e uma janela maior aumenta a chance
 * de casar o arquivo ERRADO. A graça temporal encolhia a corrida mas
 * ainda era relógio — dois cards digitando perto um do outro no mesmo
 * cwd ainda colidiam. O desenho atual não tem nenhuma delas.
 */
/** Pura, testável: um candidato é "fresco" se seu `mtime` for mais novo
 * que o piso de scan. Sem teto de relógio — um arquivo que nasce tarde
 * ainda é deste card se for o único candidato atribuível. */
export function isFreshCandidate(mtimeMs: number, floorMs: number): boolean {
  return mtimeMs > floorMs;
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
};

/**
 * One card's watcher must not win merely because it polls first. There is no
 * provider-independent session-to-PTY id in these on-disk stores, but a
 * rearm gives us two cheap pieces of ownership evidence: the card id and the
 * input timestamp that caused the rearm. Keep those reservations by
 * provider+cwd so a candidate created after two nearby inputs is awarded to
 * the most recent input, while a candidate created before the newer input is
 * still available to the earlier watcher. A reservation is removed when its
 * watcher is cancelled or finds a session — never by a clock.
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

function reservationsFor(providerId: string, cwd: string): ReservationView[] {
  const reservations = rearmReservations.get(reservationScope(providerId, cwd));
  if (!reservations) return [];
  return [...reservations.values()];
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
 * Providers whose on-disk session record appears only AFTER a prompt
 * (measured). `pty-registry.ts::write` rearms `watchForSession` on
 * every non-empty input line for these — a retry TRIGGER and an
 * ownership reservation, not a new deadline. The poller already lives
 * while `resume_id` is null; the rearm is what says "this card just
 * typed", so a sibling's file is not claimed as ours.
 *
 * HISTÓRICO — por que a lista existe (RODADA 2, 2026-09-09): `agy` só
 * grava o `.db` depois do prompt, não no spawn. Cards 294/296/298
 * ficaram ociosos esperando `send_to_card` e o watcher de então
 * desistia ao vencer um prazo de 30s contado desde o spawn. Inflar
 * esse prazo só atrasava a mesma falha. Hoje não há timeout nenhum.
 *
 * Medição 2026-09-11 (pty real, env limpo dos mesmos
 * `CLAUDE_CODE_*`/`CLAUDECODE`/`CLAUDE_PID`/`CLAUDE_EFFORT`/`AI_AGENT`
 * que `pty-registry.ts::isInheritedClaudeSessionEnvKey` já remove —
 * sem isso o filho herda `CLAUDE_CODE_CHILD_SESSION` e desliga
 * transcript saving, invalidando a medição):
 *   - `claude`: 40s de idle não cria arquivo; o primeiro write sai
 *     ~0.1s após o submit. HOJE não está nesta lista: Stellar impõe
 *     `--session-id` no spawn. Fica só em `RESUME_TRIGGER_COMMANDS`
 *     por causa do `/resume` interativo.
 *   - `opencode`: mesmo padrão (~70ms após o prompt). Continua aqui.
 *   - `cursor`: `meta.json` já no spawn — e HOJE o id é imposto via
 *     `--resume`. Fora desta lista.
 *   - `codex`: o rollout nasce após o spawn, sem prompt. Fora desta
 *     lista. (Houve um prazo de 6min só para esperar
 *     `session_index.jsonl`; o índice era incompleto e o timeout saiu
 *     junto com ele.)
 *   - `bash`: sem conceito de sessão.
 *
 * RODADA 3 (2026-09-09) — a first pass rearmed only on the FIRST line
 * (once per card). Wrong: the first line of a multi-line paste
 * (shift+enter) fired too early, and the old timeout could then expire
 * before the real submit. Rearm on EVERY non-empty line. The old
 * wording talked about "restarting the clock" because a timeout still
 * existed; today there is no clock to restart — every line still
 * rearms so the reservation tracks the latest real input.
 * `rearmSessionWatch` cancels its previous watch first, so repeated
 * rearms never leak a timer. A `\r` mid-paste still rearms before the
 * final Enter — good enough: the point is "last real activity", not
 * detecting the precise submit.
 */
export const REARM_ON_INPUT_PROVIDERS: readonly string[] = ["antigravity", "opencode"];

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

async function listClaudeSessions(cwd: string, spawnedAtMs: number): Promise<SessionCandidate[]> {
  const dir = join(homedir(), ".claude", "projects", encodeCwdForClaude(cwd));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (claimedSessionIds.has(id)) continue;
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st || !isFreshCandidate(st.mtimeMs, spawnedAtMs)) continue;
    out.push({ id, timestampMs: st.mtimeMs });
  }
  return out;
}

/**
 * Measured 2026-09-13 (task c1064d95): `session_index.jsonl` is incomplete
 * on this machine (4 lines for dozens of rollouts). Discovery reads
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and the first
 * `session_meta` line (`cwd` + `session_id`). Never the index.
 */
async function readCodexSessionMeta(
  filePath: string,
): Promise<{ sessionId: string; cwd: string } | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const first = content.split("\n").find((line) => line.trim());
  if (!first) return null;
  try {
    const parsed = JSON.parse(first) as {
      type?: string;
      payload?: { session_id?: unknown; cwd?: unknown };
    };
    if (parsed.type !== "session_meta") return null;
    const sessionId = parsed.payload?.session_id;
    const cwd = parsed.payload?.cwd;
    if (typeof sessionId !== "string" || typeof cwd !== "string") return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

async function listCodexSessions(cwd: string, spawnedAtMs: number): Promise<SessionCandidate[]> {
  const root = join(homedir(), ".codex", "sessions");
  const out: SessionCandidate[] = [];
  let years: string[];
  try {
    years = await readdir(root);
  } catch {
    return [];
  }
  for (const year of years) {
    const yearPath = join(root, year);
    let months: string[];
    try {
      months = await readdir(yearPath);
    } catch {
      continue;
    }
    for (const month of months) {
      const monthPath = join(yearPath, month);
      let days: string[];
      try {
        days = await readdir(monthPath);
      } catch {
        continue;
      }
      for (const day of days) {
        const dayPath = join(monthPath, day);
        let files: string[];
        try {
          files = await readdir(dayPath);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
          const full = join(dayPath, name);
          const st = await stat(full).catch(() => null);
          if (!st || !isFreshCandidate(st.mtimeMs, spawnedAtMs)) continue;
          const meta = await readCodexSessionMeta(full);
          if (!meta || meta.cwd !== cwd || claimedSessionIds.has(meta.sessionId)) continue;
          out.push({ id: meta.sessionId, timestampMs: st.mtimeMs });
        }
      }
    }
  }
  return out;
}

async function listCursorSessions(cwd: string, spawnedAtMs: number): Promise<SessionCandidate[]> {
  const chatsDir = join(homedir(), ".cursor", "chats");
  let hashDirs: string[];
  try {
    hashDirs = await readdir(chatsDir);
  } catch {
    return [];
  }
  const out: SessionCandidate[] = [];
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
        !isFreshCandidate(meta.createdAtMs, spawnedAtMs)
      ) continue;
      out.push({ id: sessionId, timestampMs: meta.createdAtMs });
    }
  }
  return out;
}

async function listOpenCodeSessions(cwd: string, spawnedAtMs: number): Promise<SessionCandidate[]> {
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
    return [];
  }
  try {
    // `time_created`, not `time_updated`: an old session receiving a later
    // turn is not evidence that this newly rearmed card created it.
    const rows = db
      .prepare("SELECT id, time_created FROM session WHERE directory = ? AND time_created > ?")
      .all(cwd, spawnedAtMs) as { id: string; time_created: number }[];
    return rows
      .filter((row) => !claimedSessionIds.has(row.id) && isFreshCandidate(row.time_created, spawnedAtMs))
      .map((row) => ({ id: row.id, timestampMs: row.time_created }));
  } catch {
    return [];
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
 *   - codex: o arquivo `rollout-*.jsonl` em `~/.codex/sessions/YYYY/MM/DD`
 *     cujo nome contém o id (mesmo store da descoberta). Tamanho do
 *     arquivo via `fileEvidence`. `session_index.jsonl` não é lido —
 *     medido incompleto (task c1064d95).
 */
const MIN_CONTENT_BYTES = 16;

function fileEvidence(path: string): ResumeTargetEvidence {
  if (!existsSync(path)) return { exists: false, hasContent: false, mtimeMs: null };
  try {
    const st = statSync(path);
    return { exists: true, hasContent: st.size >= MIN_CONTENT_BYTES, mtimeMs: st.mtimeMs };
  } catch {
    // Achado entre o `existsSync` e o `statSync` (arquivo apagado por
    // fora bem no meio da checagem) — trata como "não existe", nunca
    // deixa uma exceção subir e derrubar o spawn inteiro por causa de uma
    // checagem que é só uma guarda de sanidade.
    return { exists: false, hasContent: false, mtimeMs: null };
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
    return { exists: false, hasContent: false, mtimeMs: null };
  }
  for (const hash of hashDirs) {
    const sessionDir = join(chatsDir, hash, resumeId);
    if (!existsSync(sessionDir)) continue;
    const storePath = join(sessionDir, "store.db");
    if (!existsSync(storePath)) {
      // Diretório da sessão existe, mas sem conversa real — meta.json
      // sozinho não carrega mtime útil pra stale (sempre presente).
      return { exists: true, hasContent: false, mtimeMs: null };
    }
    try {
      return { exists: true, hasContent: true, mtimeMs: statSync(storePath).mtimeMs };
    } catch {
      return { exists: true, hasContent: true, mtimeMs: null };
    }
  }
  return { exists: false, hasContent: false, mtimeMs: null };
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
    return { exists: false, hasContent: false, mtimeMs: null };
  }
  try {
    // `time_updated` (ms) é o sinal de atividade da própria linha de
    // sessão — medido como presente no schema local; se a coluna não
    // existir numa versão mais velha, o catch devolve mtime null e o
    // ramo stale simplesmente não dispara pra esse provider.
    const session = db
      .prepare("SELECT id, time_updated FROM session WHERE id = ?")
      .get(resumeId) as { id: string; time_updated: number | null } | undefined;
    if (!session) return { exists: false, hasContent: false, mtimeMs: null };
    const messageCount = db.prepare("SELECT COUNT(*) as n FROM message WHERE session_id = ?").get(resumeId) as { n: number };
    const mtimeMs = typeof session.time_updated === "number" && session.time_updated > 0 ? session.time_updated : null;
    return { exists: true, hasContent: messageCount.n > 0, mtimeMs };
  } catch {
    return { exists: false, hasContent: false, mtimeMs: null };
  } finally {
    db.close();
  }
}

function findCodexSessionEvidence(resumeId: string): ResumeTargetEvidence {
  // Same store as discovery — the rollout file, not session_index.jsonl
  // (measured incomplete). Filename embeds the session id.
  const root = join(homedir(), ".codex", "sessions");
  let years: string[];
  try {
    years = readdirSync(root);
  } catch {
    return { exists: false, hasContent: false, mtimeMs: null };
  }
  for (const year of years) {
    let months: string[];
    try {
      months = readdirSync(join(root, year));
    } catch {
      continue;
    }
    for (const month of months) {
      let days: string[];
      try {
        days = readdirSync(join(root, year, month));
      } catch {
        continue;
      }
      for (const day of days) {
        let files: string[];
        try {
          files = readdirSync(join(root, year, month, day));
        } catch {
          continue;
        }
        for (const name of files) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl") || !name.includes(resumeId)) continue;
          return fileEvidence(join(root, year, month, day, name));
        }
      }
    }
  }
  return { exists: false, hasContent: false, mtimeMs: null };
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

export async function extractAntigravityWorkspaceUri(filePath: string): Promise<string | null> {
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
// HISTÓRICO, REVERTIDO (review adversarial RODADA 1, 2026-09-09): a
// hipótese original era ler `ANTIGRAVITY_CONVERSATION_ID` do env do
// próprio processo via `/proc/<pid>/environ`. Provado FALSO contra os
// `agy` reais deste host (`tr '\0' '\n' < /proc/<pid>/environ | grep -c
// ANTIGRAVITY_CONVERSATION_ID` devolveu 0 nos três processos vivos):
// `agy` faz `os.Setenv` em runtime, o que muda o `environ` NA MEMÓRIA e
// é herdado por filhos, mas o kernel NUNCA atualiza `/proc/<pid>/environ`
// depois do `execve` inicial. O explorer viu a variável num SHELL FILHO
// (que herda o env de runtime), não no procfs do próprio agy. Sem
// caminho de env viável — um subprocesso dentro do card mexeria no PTY.
//
// HISTÓRICO — RODADA 1 do conserto (também revertida) tentou inflar um
// timeout do antigravity, copiando o prazo longo que o Codex tinha.
// Errado (RODADA 2): o Codex só DEMORA a gravar depois de já ter
// processado um prompt; o antigravity espera o PRIMEIRO PROMPT. Um
// card ocioso à espera de `send_to_card` ainda perderia qualquer
// prazo. Hoje não há timeout nenhum.
//
// O que ficou: `REARM_ON_INPUT_PROVIDERS`. Cada input real no PTY
// (`pty-registry.ts::write` / `send_to_card`) rearma o watcher — gatilho
// de re-tentativa e reserva de posse, não renovação de prazo. O poller
// já vive enquanto `resume_id` for null.

async function listAntigravitySessions(cwd: string, spawnedAtMs: number): Promise<SessionCandidate[]> {
  const dir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const cwdUri = `file://${cwd}`;
  const out: SessionCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith(".db")) continue; // skip sqlite's own -wal/-shm siblings
    const id = name.slice(0, -".db".length);
    if (claimedSessionIds.has(id)) continue;
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (!st || !isFreshCandidate(st.mtimeMs, spawnedAtMs)) continue;
    const workspaceUri = await extractAntigravityWorkspaceUri(full);
    if (workspaceUri !== cwdUri) continue;
    out.push({ id, timestampMs: st.mtimeMs });
  }
  return out;
}

/**
 * Polls the on-disk location each provider writes new sessions to, looking
 * for one created after `spawnedAtMs`. Lives while the card exists and
 * `resume_id` is still null — no clock cutoff. `claude`/`cursor` normally
 * never enter this path (Stellar imposes the id at spawn); they still
 * can, for `/resume` / `--continue`. `bash` has no session concept.
 *
 * `onTimeout` is kept so existing callers compile, but it never fires:
 * a deadline only changed the odds of matching the wrong file.
 */
export function watchForSession(
  providerId: string,
  cwd: string,
  spawnedAtMs: number,
  onFound: (sessionId: string) => void,
  _onTimeout?: () => void,
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
  const matchStartMs = options.matchStartMs ?? options.rearmAtMs ?? spawnedAtMs;
  const releaseReservation =
    options.ownerId !== undefined && options.rearmAtMs !== undefined
      ? registerRearmReservation(providerId, cwd, {
          ownerId: options.ownerId,
          rearmAtMs: options.rearmAtMs,
          matchStartMs,
        })
      : () => {};

  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const found = await runExclusive(async () => {
        if (stopped) return null;
        let candidates: SessionCandidate[];
        if (providerId === "claude") {
          candidates = await listClaudeSessions(cwd, spawnedAtMs);
        } else if (providerId === "codex") {
          candidates = await listCodexSessions(cwd, spawnedAtMs);
        } else if (providerId === "cursor") {
          candidates = await listCursorSessions(cwd, spawnedAtMs);
        } else if (providerId === "antigravity") {
          candidates = await listAntigravitySessions(cwd, spawnedAtMs);
        } else if (providerId === "opencode") {
          candidates = await listOpenCodeSessions(cwd, spawnedAtMs);
        } else {
          candidates = [];
        }
        if (stopped) return null;
        const decision = decideClaimAmongCandidates({
          candidates,
          isClaimed: (id) => claimedSessionIds.has(id),
          ownerId: options.ownerId,
          reservations: reservationsFor(providerId, cwd),
          requiresInputReservation: REARM_ON_INPUT_PROVIDERS.includes(providerId),
        });
        if (decision.action !== "claim") return null;
        claimSessionId(decision.id);
        return decision.id;
      });
      if (stopped) {
        if (found) releaseSessionId(found);
        return;
      }
      if (found) {
        stopped = true;
        clearInterval(timer);
        releaseReservation();
        onFound(found);
      }
    } catch {
      // Best-effort — a transient read error just means try again next poll.
    }
  }, POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    releaseReservation();
  };
}

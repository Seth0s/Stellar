import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const POLL_MS = 1500;
const TIMEOUT_MS = 30_000;
// Achado ao vivo (2026-09-07) — Codex nunca restaurava sessão: o Codex TUI
// só grava a entrada em `~/.codex/session_index.jsonl` bem depois do início
// real da sessão (embedded timestamp do rollout vs. mtime do index, medido
// neste mesmo host): 36s num caso, 211s (3.5min) noutro. Ambos passam do
// TIMEOUT_MS de 30s compartilhado por todo provider, então o watcher sempre
// desistia antes do Codex escrever o índice — `resumeId` ficava `null` pra
// sempre e o próximo launch simplesmente abria uma sessão nova vazia
// (indistinguível de "falhou a restaurar"). Claude/Cursor gravam quase
// instantaneamente (~2s) — 30s continua certo pra eles.
const CODEX_TIMEOUT_MS = 6 * 60_000;

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
 * which providers want that "rearm on input" behavior — just antigravity
 * for now; every other provider's session file already appears close
 * enough to spawn time that a rearm would add nothing.
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
export const REARM_ON_INPUT_PROVIDERS: readonly string[] = ["antigravity"];

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

async function findClaudeSession(cwd: string, spawnedAtMs: number): Promise<string | null> {
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
    if (!st || st.mtimeMs <= spawnedAtMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { id, mtimeMs: st.mtimeMs };
    }
  }
  return best?.id ?? null;
}

// Codex's session_index.jsonl is append-only — track byte offset at spawn
// time and only parse what's new, per watcher (module-level, keyed by cwd
// isn't needed: each watcher tracks its own offset independently).
async function findCodexSession(sinceOffset: number): Promise<{ id: string | null; newOffset: number }> {
  const file = join(homedir(), ".codex", "session_index.jsonl");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return { id: null, newOffset: sinceOffset };
  }
  if (content.length <= sinceOffset) return { id: null, newOffset: content.length };
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
  return { id, newOffset: content.length };
}

async function findCursorSession(cwd: string, spawnedAtMs: number): Promise<string | null> {
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
      if (meta.cwd !== cwd || typeof meta.createdAtMs !== "number" || meta.createdAtMs <= spawnedAtMs) continue;
      if (!best || meta.createdAtMs > best.createdAtMs) {
        best = { id: sessionId, createdAtMs: meta.createdAtMs };
      }
    }
  }
  return best?.id ?? null;
}

async function findOpenCodeSession(cwd: string, spawnedAtMs: number): Promise<string | null> {
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
    const rows = db
      .prepare("SELECT id, time_updated FROM session WHERE directory = ? AND time_updated > ? ORDER BY time_updated DESC")
      .all(cwd, spawnedAtMs) as { id: string; time_updated: number }[];
    for (const row of rows) {
      if (!claimedSessionIds.has(row.id)) return row.id;
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
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

async function findAntigravitySession(cwd: string, spawnedAtMs: number): Promise<string | null> {
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
    if (!st || st.mtimeMs <= spawnedAtMs) continue;
    if (best && st.mtimeMs <= best.mtimeMs) continue;
    const workspaceUri = await extractAntigravityWorkspaceUri(full);
    if (workspaceUri !== cwdUri) continue;
    best = { id, mtimeMs: st.mtimeMs };
  }
  return best?.id ?? null;
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
        if (providerId === "claude") {
          return findClaudeSession(cwd, spawnedAtMs);
        } else if (providerId === "codex") {
          if (!codexOffsetReady) {
            codexOffset = await initCodexOffset;
            codexOffsetReady = true;
          }
          const result = await findCodexSession(codexOffset);
          codexOffset = result.newOffset;
          return result.id;
        } else if (providerId === "cursor") {
          return findCursorSession(cwd, spawnedAtMs);
        } else if (providerId === "antigravity") {
          return findAntigravitySession(cwd, spawnedAtMs);
        } else if (providerId === "opencode") {
          return findOpenCodeSession(cwd, spawnedAtMs);
        }
        return null;
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
      if (stopped) return;
      if (found) {
        // Claim synchronously, before anything else runs — the narrow
        // remaining race is two watchers' own filesystem reads
        // interleaving (see claimedSessionIds' doc comment); this at
        // least closes the much wider window of "already claimed, but a
        // later watcher hasn't polled again yet to see that."
        claimSessionId(found);
        stopped = true;
        clearInterval(timer);
        clearTimeout(timeout);
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
      onTimeout?.();
    },
    providerId === "codex" ? CODEX_TIMEOUT_MS : TIMEOUT_MS,
  );

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(timeout);
  };
}

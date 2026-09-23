import { open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { ResumeTargetEvidence } from "./session-resume-validation";
import { decideClaimAmongCandidates, type ReservationView } from "./session-claim-decision";
import { providerById } from "./providers";

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

export type SessionCandidate = {
  id: string;
  /**
   * The provider's best cheap timestamp for the candidate's first visible
   * write. Files use mtime, cursor uses meta.createdAtMs, and opencode uses
   * session.time_created (not a later turn's time_updated). Codex never enters the rearm path, so its index
   * candidates do not need a timestamp here.
   */
  timestampMs?: number;
  /**
   * EVIDÊNCIA do registro, para quem precisa dizer "este card trabalhou" sem
   * adivinhar (task 5d47312c — a confrontação entre o store do harness e o que
   * o Stellar capturou). O `stat` que produz `timestampMs` já era feito; o
   * caminho e o tamanho saem do MESMO syscall nos stores de arquivo, então
   * expor isto não custa I/O nenhum. `null` em store de sqlite, onde a linha
   * não tem "tamanho de arquivo" — e inventar um número para preencher o campo
   * seria a mentira que este campo existe para evitar.
   *
   * O que isto NÃO prova, e quem lê tem de saber: um arquivo grande pode ser um
   * turno enorme sem trabalho nenhum, e um arquivo pequeno pode ser o começo de
   * um trabalho real interrompido cedo. É evidência de ESCRITA, não de
   * resultado.
   */
  path?: string;
  sizeBytes?: number | null;
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

// ---------------------------------------------------------------------------
// O STORE DE SESSÃO É DECLARAÇÃO — a gramática que substitui as tabelas de
// funções por provider
//
// O QUE EXISTIA: dez funções escritas à mão — cinco de descoberta
// (`listClaudeSessions`, `listCodexSessions`, …) e cinco de leitura
// (`findClaudeSessionDirEvidence`, …) — mais DUAS tabelas que as indexavam
// por id (`SESSION_DISCOVERY_CHANNELS`, `RESUME_EVIDENCE_FINDERS`). É o
// `switch` por provider que o resto do sistema existe para não ter, só que
// com outro formato: um provider genérico (cline, commandcode) só entrava
// ali escrevendo função NOVA no código — e deixava de ser genérico no ato.
// A alternativa à varredura cega não precisa ser código por provider:
// precisa ser DECLARAÇÃO. `providers-dynamic.ts` já declara o mesmo
// princípio para o resto ("é DADO declarativo, não código por provider").
//
// O LEVANTAMENTO — os cinco nativos lado a lado, nos quatro eixos que um
// leitor precisa. Ele É o desenho desta gramática:
//
//   provider      raiz (como o cwd entra)      id vem de          "nasceu depois" de   cwd
//   claude        projects/<cwd com / → ->      nome do arquivo    mtime do arquivo     o próprio caminho
//   codex         sessions/YYYY/MM/DD/          JSON da 1ª linha   mtime do arquivo     JSON da 1ª linha
//   cursor        chats/<hash>/<id>/            nome do diretório  meta.json createdAtMs meta.json cwd
//   antigravity   conversations/                nome do arquivo    mtime do arquivo     blob protobuf (*)
//   opencode      sqlite (coluna `directory`)   coluna `id`        coluna `time_created` coluna `directory`
//
// O que se repete em TODOS: raiz → registro → id/cwd/tempo, a mesma
// checagem de frescor (`isFreshCandidate`) e o mesmo filtro de id já
// reivindicado (`claimedSessionIds`). O que diverge é só ONDE cada valor
// sai: nome de arquivo, nome de diretório, JSON (de uma linha ou do
// arquivo inteiro), coluna de sqlite. Não há heurística em lugar nenhum —
// cada campo é uma medição da CLI.
//
// (*) O ÚNICO CASO ESPECIAL NOMEADO: o cwd do antigravity mora dentro de um
// blob protobuf (campo length-delimited com uma URI `file://<cwd>`), sem
// caminho de texto para apontar — daí `{ from: "binaryWorkspaceUri" }`,
// interpretado por `extractAntigravityWorkspaceUri`. Um caso nomeado COM
// motivo é aceitável; cinco seriam a tabela de hoje com outro nome.
//
// O QUE O SPEC VAI CARREGAR (o formato, para a fiação ser PLUGAR e não
// redesenhar): a declaração abaixo vira campo do provider, ao lado da
// `capacity.session` que `providers-dynamic.ts` já valida —
//
//     capacity.session.store: SessionStore      // a MESMA forma, sem tradução
//
// e um provider genérico passa a se declarar no `providers.json`. O
// commandcode exatamente como está em `SESSION_STORES`:
//
//   "session": { "canImposeSessionId": false, "resumeFlag": "--resume",
//     "store": { "kind": "files",
//                "root": "~/.commandcode/projects/{cwd:slug}",
//                "pattern": "*.meta.json",
//                "id": { "from": "fileName", "strip": ".meta.json" },
//                "cwd": { "from": "root" },
//                "time": { "from": "mtime" },
//                "read": { "exists": "{id}.jsonl",
//                          "content": { "minBytes": 16 } } } }
//
// A fiação é só isto: `discoverSessionCandidates` e
// `getResumeTargetEvidence` passam a ler o store do SPEC primeiro
// (`providerById(id)?.capacity.session.store`) e mantêm `SESSION_STORES` como
// o catálogo EMBUTIDO. As DUAS camadas são necessárias, e isso já foi medido
// pelo card do seed (2026-09-20, cinco casos contra o código real): mover o
// catálogo embutido para o arquivo do usuário é REGRESSÃO — quem apaga o
// arquivo perde o provider. O campo do spec diz ONDE a sessão mora e tem
// precedência por id; ele NÃO substitui a camada embutida. Nenhum leitor
// novo, nenhuma tabela nova — a presença do store É o canal, e um provider
// sem store continua não observável de propósito: sem âncora medida de cwd e
// de tempo, varrer às cegas acharia o arquivo de outro card.
//
// O que a validação do spec precisa cobrir quando o campo entrar (o parser
// recusa o spec inteiro DIZENDO o motivo, nunca aceita e larga):
//   - `kind` ∈ {files, sqlite}, com os campos da variante presentes;
//   - `timeFormat` ∈ {epoch-ms, iso-8601} quando declarado;
//   - identificadores SQL com a MESMA forma que `sqlIdentifier` exige;
//   - `content.minBytes` numérico e > 0;
//   - `pattern`/`exists` não vazios, e `{id}` só onde faz sentido.
// ---------------------------------------------------------------------------

import {
  MIN_CONTENT_BYTES,
  SQL_IDENTIFIER_RE,
  type SessionCwdSource,
  type SessionIdSource,
  type SessionStore,
  type SessionTimeSource,
  type SqliteReadSpec,
  type SqliteStore,
  type SqliteTimeFormat,
} from "./session-store-spec";

/**
 * A LINGUAGEM da declaração mora em `session-store-spec.ts` — forma pura,
 * sem runtime, importável pelas DUAS camadas que declaram (as specs nativas
 * em `providers.ts` e as de `providers-dynamic.ts`) sem ciclo e sem inverter
 * a direção do registro. AQUI fica a FERRAMENTA que a interpreta.
 *
 * `SqliteTimeFormat` é reexportado porque já era superfície pública deste
 * módulo; `SessionStore` idem (o teste que prova a equivalência o importa
 * daqui desde a task 2ea0269f).
 */
export type { SessionStore, SqliteTimeFormat } from "./session-store-spec";

/** A DECLARAÇÃO viva do provider — a única fonte desde a task 2ea0269f.
 *
 * O que era uma tabela local (`SESSION_STORES`) virou campo do SPEC: os cinco
 * nativos declaram em `providers.ts`, e os dois genéricos medidos em
 * `providers-dynamic.ts` (catálogo embutido, que o arquivo do usuário pode
 * sobrescrever por id). A presença do store É o canal; a ausência continua
 * significando "provider não observável", com o motivo escrito em
 * `session-store-spec.ts`.
 *
 * Ler do MESMO lugar que o resto do app lê a capacidade é o ponto da task:
 * um provider novo passa a ser observável declarando, sem tocar em código.
 */
function declaredSessionStore(providerId: string): SessionStore | undefined {
  return providerById(providerId)?.capacity.session.store;
}

/**
 * OS ENCODINGS DE CWD — cada um é uma MEDIÇÃO, com a amostra declarada:
 *
 *  - `{cwd:dashes}` (claude): `/` → `-`. Medido contra os diretórios reais de
 *    `~/.claude/projects/`.
 *  - `{cwd:slug}` (commandcode): `/` → `-`, tira o `-` inicial, MINÚSCULAS.
 *    AMOSTRA: os DOIS diretórios de projeto reais desta máquina —
 *    `/home/lucas/Workplace/Projects` → `home-lucas-workplace-projects` e
 *    `/home/lucas/Workplace/Projects/Stellar` →
 *    `home-lucas-workplace-projects-stellar` (o segundo é o que prova as
 *    minúsculas). O QUE FICA INDETERMINADO: o tratamento de QUALQUER
 *    caractere que não seja `/` — espaço, acento, ponto, `_`, contrabarra.
 *    Nenhum dado em disco discrimina: não existe, aqui, um cwd com um desses
 *    e diretório de projeto criado. Se o seu cwd tiver espaço ou acento,
 *    NINGUÉM MEDIU essa regra — a conta desta função pode não achar o
 *    diretório, e o lado em que isso falha é o seguro (sem candidato, não
 *    premia a sessão errada). A medição que fecha isto é rodar o CLI num cwd
 *    com um ponto e comparar o diretório criado.
 *  - `{cwd}` cru: nenhum store medido usa hoje.
 *
 * `~` → home. Lê `homedir()` na CHAMADA, nunca no load do módulo: é o que
 * deixa um teste apontar o store para uma árvore de fixture só mexendo em
 * `$HOME`.
 */
function expandRoot(root: string, cwd: string): string {
  const slug = cwd.replace(/\//g, "-").replace(/^-/, "").toLowerCase();
  const resolved = root
    .replace("{cwd:dashes}", cwd.replace(/\//g, "-"))
    .replace("{cwd:slug}", slug)
    .replace("{cwd}", cwd);
  return resolved.startsWith("~/") ? join(homedir(), resolved.slice(2)) : resolved;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Um segmento do glob: `*` = qualquer coisa DENTRO do segmento; `\x` é
 * literal (é assim que um id entra — ver `substituteId`). */
function segmentMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*") && !pattern.includes("\\")) return pattern === name;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\" && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[++i]!);
      continue;
    }
    source += char === "*" ? ".*" : escapeRegExp(char);
  }
  return new RegExp(`^${source}$`).test(name);
}

/** O id entra no padrão de LEITURA como texto literal: um `*` dentro de um
 * id não pode virar curinga. */
function substituteId(pattern: string, resumeId: string): string {
  return pattern.replaceAll("{id}", resumeId.replace(/[*?[\]\\]/g, "\\$&"));
}

/** Expande o glob da declaração da esquerda para a direita. Um segmento com
 * `*` vira `readdir` + filtro; um literal vira só um `join`. Este é o mínimo
 * que os `list*` à mão pediam do filesystem — nomes de diretório e `stat` do
 * registro —, e é de propósito que a descoberta NÃO use `withFileTypes`: o
 * `readdir` de nomes é tudo o que ela precisa. */
async function expandGlob(root: string, segments: readonly string[]): Promise<string[]> {
  let paths = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of paths) {
      if (!segment.includes("*")) {
        next.push(join(dir, segment));
        continue;
      }
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) if (segmentMatches(segment, name)) next.push(join(dir, name));
    }
    paths = next;
  }
  return paths;
}

/** Uma leitura de JSON por arquivo e por varredura: o rollout do codex é
 * lido para o id E para o cwd, e o `meta.json` do cursor para o tempo E para
 * o cwd. Sem o cache seriam duas leituras onde as funções à mão faziam uma. */
type JsonCache = Map<string, unknown>;

async function readJsonFile(path: string, cache: JsonCache): Promise<unknown> {
  if (cache.has(path)) return cache.get(path);
  const value = await readFile(path, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  cache.set(path, value);
  return value;
}

/** O JSON da PRIMEIRA linha não-vazia, sem procurar caminho nenhum, ficou sem
 * uso quando o `jsonLine` passou a varrer o prefixo procurando o `path`
 * declarado (task 99f4f263). Foi DELETADA em vez de mantida: duas respostas
 * para "qual linha é a do cabeçalho" é exatamente a segunda fonte que esta
 * task veio remover — e quem precisa do cabeçalho pede pelo caminho dele,
 * `readFirstJsonLineAtPath`. */



/** Quantas linhas o `jsonLine` varre procurando o CAMINHO declarado (task
 * 99f4f263). Não é escolha estética: o cabeçalho de um log JSONL pode não ser
 * a linha 1 — medido, o `omp` grava um `title` de preenchimento na 1ª e o
 * `session` com `id`/`cwd` na 2ª — e varrer o arquivo INTEIRO parsearia um
 * log de dezenas de MB para achar o que mora no topo. 20 é folga medida
 * (o pior caso medido é a linha 2) e é uma constante, não um campo: uma
 * configuração a mais aqui só criaria uma forma nova de errar. Um caminho
 * que não aparece no prefixo varrido é AUSÊNCIA — o registro não vira
 * candidato —, nunca a última linha lida como se fosse a certa. */
const JSON_LINE_SCAN_LIMIT = 20;

/** A primeira das primeiras linhas não-vazias em que o `path` resolve.
 * Devolve o valor JÁ navegado (quem chama compara tipo) e `undefined` quando
 * nenhuma linha do prefixo varrido tem o caminho. */
async function readFirstJsonLineAtPath(
  path: string,
  needle: readonly string[],
  cache: JsonCache,
): Promise<unknown> {
  const key = `line\u0000${needle.join("\u0000")}\u0000${path}`;
  if (cache.has(key)) return cache.get(key);
  const value = await readFile(path, "utf8")
    .then((content) => {
      const lines = content.split("\n");
      const limit = Math.min(lines.length, JSON_LINE_SCAN_LIMIT);
      for (let i = 0; i < limit; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const found = valueAt(parsed, needle);
        if (found !== undefined) return found;
      }
      return undefined;
    })
    .catch(() => undefined);
  cache.set(key, value);
  return value;
}

/** Navega o objeto pelo caminho declarado; `undefined` quando algum passo não
 * existe (nunca `null` fingindo "achei um vazio"). */
function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Id que sai do CAMINHO, sem abrir o arquivo — é o que permite checar
 * `claimedSessionIds` antes de pagar a leitura do conteúdo, a mesma ordem
 * que as funções à mão tinham. `null` quando o id só sai do conteúdo.
 *
 * A ordem dos dois cortes é a DECLARADA em `SessionIdSource`: `strip` (o
 * sufixo) primeiro, `afterLast` (o separador) depois — o `omp` grava
 * `2026-09-22T12-34-19-909Z_<id>.jsonl`, e é assim que o stem vira `<id>`.
 * Sem o separador no nome, `null`: ausência, nunca o nome inteiro fingindo
 * ser id (task 99f4f263). */
function pathDerivedId(source: SessionIdSource, entryPath: string): string | null {
  if (source.from === "fileName") {
    const name = basename(entryPath);
    if (!name.endsWith(source.strip)) return null;
    const stem = name.slice(0, -source.strip.length);
    if (source.afterLast === undefined) return stem;
    const cut = stem.lastIndexOf(source.afterLast);
    if (cut < 0) return null;
    const tail = stem.slice(cut + source.afterLast.length);
    return tail.length > 0 ? tail : null;
  }
  if (source.from === "dirName") return basename(dirname(entryPath));
  return null;
}

async function contentDerivedId(
  source: SessionIdSource,
  entryPath: string,
  cache: JsonCache,
): Promise<string | null> {
  if (source.from !== "jsonLine") return null;
  if (source.from === "jsonLine") {
    const value = await readFirstJsonLineAtPath(entryPath, source.path, cache);
    return typeof value === "string" ? value : null;
  }
  return null;
}

async function entryTimestamp(
  source: SessionTimeSource,
  entryPath: string,
  cache: JsonCache,
): Promise<number | null> {
  if (source.from === "mtime") {
    const st = await stat(entryPath).catch(() => null);
    return st ? st.mtimeMs : null;
  }
  const value = valueAt(await readJsonFile(entryPath, cache), source.path);
  return typeof value === "number" ? value : null;
}

async function entryMatchesCwd(
  source: SessionCwdSource,
  entryPath: string,
  cwd: string,
  cache: JsonCache,
): Promise<boolean> {
  switch (source.from) {
    case "root":
      return true;
    case "binaryWorkspaceUri":
      return (await extractAntigravityWorkspaceUri(entryPath)) === `file://${cwd}`;
    case "json":
      return valueAt(await readJsonFile(entryPath, cache), source.path) === cwd;
    case "jsonLine":
      return (await readFirstJsonLineAtPath(entryPath, source.path, cache)) === cwd;
  }
}

function sqlIdentifier(name: string): string {
  if (!SQL_IDENTIFIER_RE.test(name)) throw new Error(`not a SQL identifier: ${name}`);
  return name;
}

function openReadonlySqlite(dbPath: string): Database.Database | null {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/** O carimbo da coluna na forma DECLARADA, em epoch-ms. `null` quando o valor
 * não é daquela forma — nunca um chute pelo tamanho do número, que é o que
 * faria uma data de 2026 virar 1970 (ou o contrário) em silêncio. */
function toEpochMs(value: unknown, format: SqliteTimeFormat): number | null {
  if (format === "epoch-ms") return typeof value === "number" && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** O predicado de frescor na forma declarada. Para ISO-8601 é o `julianday()`
 * do SQLite (o parser de data dele) em vez de `>` de texto: `>` de texto
 * funcionaria enquanto todos os valores tivessem a MESMA largura e precisão, e
 * um `…06Z` contra `…06.776Z` ordena errado no próprio segundo. Um valor que
 * ele não consiga parsear vira NULL e a linha sai — o lado seguro. */
function sqliteTimePredicate(column: string, format: SqliteTimeFormat): string {
  const col = sqlIdentifier(column);
  return format === "iso-8601" ? `julianday(${col}) > julianday(?)` : `${col} > ?`;
}

function discoverFromSqlite(store: SqliteStore, cwd: string, spawnedAtMs: number): SessionCandidate[] {
  const db = openReadonlySqlite(expandRoot(store.db, cwd));
  if (!db) return [];
  const timeFormat = store.timeFormat ?? "epoch-ms";
  try {
    const { table, idColumn, cwdColumn, timeColumn } = store.discovery;
    const rows = db
      .prepare(
        `SELECT ${sqlIdentifier(idColumn)} AS id, ${sqlIdentifier(timeColumn)} AS time FROM ${sqlIdentifier(table)}` +
          ` WHERE ${sqlIdentifier(cwdColumn)} = ? AND ${sqliteTimePredicate(timeColumn, timeFormat)}`,
      )
      .all(cwd, timeFormat === "iso-8601" ? new Date(spawnedAtMs).toISOString() : spawnedAtMs) as {
      id: string;
      time: unknown;
    }[];
    const out: SessionCandidate[] = [];
    for (const row of rows) {
      const timestampMs = toEpochMs(row.time, timeFormat);
      if (timestampMs === null || claimedSessionIds.has(row.id)) continue;
      if (!isFreshCandidate(timestampMs, spawnedAtMs)) continue;
      // Sem `path`/`sizeBytes`: uma LINHA de sqlite não tem tamanho de arquivo, e
      // o `null` explícito é a ausência declarada (ver `SessionCandidate`).
      out.push({ id: row.id, timestampMs, sizeBytes: null });
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** O leitor de DESCOBERTA — um só, dirigido pela declaração. A ordem dos
 * passos é a das funções à mão: id barato (do caminho) → filtro de já
 * reivindicado → frescor → id do conteúdo → cwd. */
async function discoverWithStore(
  store: SessionStore,
  cwd: string,
  spawnedAtMs: number,
): Promise<SessionCandidate[]> {
  if (store.kind === "sqlite") return discoverFromSqlite(store, cwd, spawnedAtMs);
  const entries = await expandGlob(expandRoot(store.root, cwd), store.pattern.split("/"));
  const cache: JsonCache = new Map();
  const out: SessionCandidate[] = [];
  for (const entry of entries) {
    const pathId = pathDerivedId(store.id, entry);
    if (pathId !== null && claimedSessionIds.has(pathId)) continue;
    const timestampMs = await entryTimestamp(store.time, entry, cache);
    if (timestampMs === null || !isFreshCandidate(timestampMs, spawnedAtMs)) continue;
    const id = pathId ?? (await contentDerivedId(store.id, entry, cache));
    if (id === null || claimedSessionIds.has(id)) continue;
    if (!(await entryMatchesCwd(store.cwd, entry, cwd, cache))) continue;
    // Um `stat` por candidato ACEITO (não por entrada varrida): o mesmo dado que
    // já sustentava o frescor, agora explícito para quem confronta evidência.
    const st = await stat(entry).catch(() => null);
    out.push({
      id,
      timestampMs,
      path: entry,
      sizeBytes: st ? st.size : null,
    });
  }
  return out;
}

/**
 * A FERRAMENTA que usa os parâmetros declarados: quem tem store é
 * observável, quem não tem devolve `[]` — sem varredura por heurística.
 *
 * Exportada porque é a costura que o spec vai usar quando a declaração
 * virar campo do provider: um dinâmico com store medido passa a ser
 * observável sem tocar em código.
 */
export async function discoverSessionCandidates(
  providerId: string,
  cwd: string,
  spawnedAtMs: number,
): Promise<SessionCandidate[]> {
  const store = declaredSessionStore(providerId);
  if (!store) return [];
  return discoverWithStore(store, cwd, spawnedAtMs);
}


/**
 * DESIGN-BACKLOG.md, achado 2 (2026-09-11) — encaminhamento 3: validação na
 * LEITURA, antes de honrar um `resumeId` restaurado (`pty-registry.ts`'s
 * `spawn`, quando `spawnOpts.resumeId` já vem preenchido do DB). A DECISÃO
 * pura fica em `session-resume-validation.ts`; a leitura de disco mora aqui
 * (mesmo split de `decideRearmOnLine` — I/O de um lado, lógica testável do
 * outro), e sai da MESMA declaração que a descoberta.
 *
 * Síncrono de propósito: `pty-registry.ts::spawn` monta os argumentos do
 * CLI (incluindo `--resume <id>`) e chama `pty.spawn` de forma síncrona;
 * validar precisa terminar antes dessa decisão, e um `stat` por spawn (nunca
 * num loop) não justifica reestruturar `spawn` inteiro em async por isto.
 *
 * O QUE CONTA COMO "TEM CONTEÚDO" é medição de cada CLI e vive na declaração
 * (`capacity.session.store` do spec, lida por `providerById` — a tabela
 * paralela `SESSION_STORES` que morava aqui foi deletada na task 2ea0269f),
 * não numa lista aqui: bytes para claude/antigravity/
 * codex, EXISTÊNCIA de `store.db` para o cursor e uma linha em `message`
 * para o opencode. Duas rodadas de review adversarial (2026-09-11) provaram
 * furos em versões anteriores — a soma de bytes do diretório do cursor
 * (nunca reprovava nada: `meta.json` sozinho já passa de 16) e
 * `tokens_*`/`cost` do opencode (zerados até o FIM do turno, reprovavam um
 * prompt real cujo processo morreu antes da resposta). As duas medições
 * ficaram no comentário da própria declaração.
 */

function fileEvidence(path: string, minBytes: number = MIN_CONTENT_BYTES): ResumeTargetEvidence {
  if (!existsSync(path)) return { exists: false, hasContent: false, mtimeMs: null };
  try {
    const st = statSync(path);
    return { exists: true, hasContent: st.size >= minBytes, mtimeMs: st.mtimeMs };
  } catch {
    // Achado entre o `existsSync` e o `statSync` (arquivo apagado por
    // fora bem no meio da checagem) — trata como "não existe", nunca
    // deixa uma exceção subir e derrubar o spawn inteiro por causa de uma
    // checagem que é só uma guarda de sanidade.
    return { exists: false, hasContent: false, mtimeMs: null };
  }
}

/** O irmão SÍNCRONO do `expandGlob` — mesma declaração, mesmo glob; muda só
 * o filesystem, porque o `--resume` é decidido de forma síncrona. */
function expandGlobSync(root: string, segments: readonly string[]): string[] {
  let paths = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of paths) {
      if (!segment.includes("*")) {
        next.push(join(dir, segment));
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) if (segmentMatches(segment, name)) next.push(join(dir, name));
    }
    paths = next;
  }
  return paths;
}

/** O leitor de LEITURA — a mesma declaração da descoberta, com o id
 * substituído no padrão. `null` = este store NÃO declara leitura (a resposta
 * sai da declaração do provider, nunca de evidência inventada). */
function readWithStore(store: SessionStore, cwd: string, resumeId: string): ResumeTargetEvidence | null {
  if (store.kind === "sqlite") {
    const read = store.read;
    return read ? readSqliteEvidence(store, read, cwd, resumeId) : null;
  }
  const read = store.read;
  if (!read) return null;
  const match = expandGlobSync(
    expandRoot(store.root, cwd),
    substituteId(read.exists, resumeId).split("/"),
  ).find((candidate) => existsSync(candidate));
  if (!match) return { exists: false, hasContent: false, mtimeMs: null };
  if ("minBytes" in read.content) return fileEvidence(match, read.content.minBytes);
  // `file`: o registro é um DIRETÓRIO e o conteúdo é um arquivo dentro dele.
  // "O diretório da sessão existe" e "a conversa começou" são perguntas
  // diferentes — é este par que o cursor expõe.
  const contentPath = join(match, read.content.file);
  if (!existsSync(contentPath)) return { exists: true, hasContent: false, mtimeMs: null };
  try {
    return { exists: true, hasContent: true, mtimeMs: statSync(contentPath).mtimeMs };
  } catch {
    return { exists: true, hasContent: true, mtimeMs: null };
  }
}

function readSqliteEvidence(
  store: SqliteStore,
  read: SqliteReadSpec,
  cwd: string,
  resumeId: string,
): ResumeTargetEvidence {
  const db = openReadonlySqlite(expandRoot(store.db, cwd));
  if (!db) return { exists: false, hasContent: false, mtimeMs: null };
  try {
    const { table, idColumn, timeColumn, contentTable, contentColumn } = read;
    const row = db
      .prepare(
        `SELECT ${sqlIdentifier(timeColumn)} AS time FROM ${sqlIdentifier(table)} WHERE ${sqlIdentifier(idColumn)} = ?`,
      )
      .get(resumeId) as { time: unknown } | undefined;
    if (!row) return { exists: false, hasContent: false, mtimeMs: null };
    const content = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${sqlIdentifier(contentTable)} WHERE ${sqlIdentifier(contentColumn)} = ?`,
      )
      .get(resumeId) as { n: number };
    // A coluna de atividade da própria linha, na forma DECLARADA; se ela não
    // existir numa versão mais velha do schema, o catch devolve "não existe"
    // e o ramo stale simplesmente não dispara para este provider.
    const mtimeMs = toEpochMs(row.time, store.timeFormat ?? "epoch-ms");
    return { exists: true, hasContent: content.n > 0, mtimeMs };
  } catch {
    return { exists: false, hasContent: false, mtimeMs: null };
  } finally {
    db.close();
  }
}

/** A DECLARAÇÃO diz que este provider retoma sessão existente? Lida de
 * `capacity.session` — nunca de uma lista de ids. Inclui
 * `canImposeSessionId` porque onde a CLI impõe o id ela também o retoma (a
 * mesma flag cria se ausente e retoma se existente: cursor, cline). */
function providerDeclaresSessionResume(providerId: string): boolean {
  const session = providerById(providerId)?.capacity.session;
  return !!session && (session.canImposeSessionId || session.resumeFlag !== undefined || session.continueFlag !== undefined);
}

/** Ponto único chamado por `pty-registry.ts::spawn` antes de honrar um
 * `resumeId` restaurado. Providers sem conceito de sessão (`bash`) nunca
 * chegam aqui — o chamador já filtra por `capacity.role === "agent"`.
 *
 * `null` NÃO é erro: é "não há canal de medição conhecido para este
 * provider". O default deixou de ser `{exists:false}` (que reprovava o id em
 * silêncio) e passa a distinguir pela própria declaração:
 *  - provider que não declara NENHUMA forma de retomada → `{exists:false}`,
 *    e o spawn limpo resultante é a verdade (não havia o que honrar);
 *  - provider que DECLARA retomar mas cujo store ninguém mediu — ou cujo
 *    store mediu só a DESCOBERTA, como o cline → `null`: não há prova de que
 *    o id esteja errado, então não bloqueia. Bloquear por ausência de medição
 *    derrubaria a retomada de um provider capaz — o dano que este
 *    encaminhamento existe pra evitar.
 *
 * As duas perguntas são independentes por desenho: um store pode fechar a
 * descoberta e não fechar a leitura (`store.read` ausente), e aí a resposta
 * volta a ser a da DECLARAÇÃO — nunca uma evidência inventada. */
export function getResumeTargetEvidence(
  providerId: string,
  cwd: string,
  resumeId: string,
): ResumeTargetEvidence | null {
  const store = declaredSessionStore(providerId);
  const measured = store ? readWithStore(store, cwd, resumeId) : null;
  if (measured) return measured;
  return providerDeclaresSessionResume(providerId) ? null : { exists: false, hasContent: false };
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
  // Antes: `providerId !== "claude" && … && providerId !== "opencode"`. Agora
  // a pergunta é "este provider tem STORE declarado?" — a mesma declaração
  // que alimenta a busca abaixo, uma fonte só: um dinâmico com store medido
  // amanhã é observável sem tocar nesta linha.
  if (!declaredSessionStore(providerId)) return () => {};

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
        const candidates = await discoverSessionCandidates(providerId, cwd, spawnedAtMs);
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

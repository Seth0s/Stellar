import Database from "better-sqlite3";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decideStatusWrite, retainStatusAsk, type StatusWriteDecision } from "./status-write-decision";
import { decideSprintClose } from "./sprint-close-decision";
import { normalizeTaskPurpose } from "../task-purpose";

export type CardRow = {
  id: string;
  board_id: string;
  kind: string;
  provider: string;
  cwd: string;
  x: number;
  y: number;
  w: number;
  h: number;
  resume_id: string | null;
  model: string | null;
  /** DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" (relato do
   * dono do repo, 2026-09-09, custo real: "a sessão era um opus medium,
   * mas após reinício do app voltei como high e custou muito"). Started
   * as an Antigravity-only, deliberately never-persisted field (see
   * card-types.ts's own doc comment for the full history) — that stopped
   * being a safe default the moment `claude`'s `--effort` flag (confirmed
   * via its own `--help`, not assumed) meant a restart could silently
   * swap in a MORE expensive effort level than the one actually chosen,
   * not just a cheaper one like Antigravity's fallback. Same nullable
   * TEXT convention as `model`/`system_prompt` above — `null` for every
   * row before this column and for every card kind that doesn't launch a
   * CLI process at all. */
  effort: string | null;
  system_prompt: string | null;
  group_id: string | null;
  /** User-set display name (item: header rename), null = fall back to a
   * kind-specific default (provider id, "arquivos", etc). Deliberately its
   * own column instead of overloading `provider`/`cwd` the way every other
   * per-kind field does — those are already stretched thin (see App.tsx's
   * toRow/fromRow), and every kind needs this one the same way. */
  label: string | null;
  updated_at: number;
  /** DESIGN-BACKLOG.md item 12, Fase C — chat message history. A real
   * dedicated column, not another squeeze into `cwd`/`resume_id`: Fase B
   * put the JSON blob in `cwd` (following stroke's precedent), which
   * worked while chat had no real project root of its own to store —
   * Fase C's file tools need `cwd` back for its normal meaning (the
   * kind's actual root path, same as files/changes/terminal), so the
   * messages needed a column of their own instead. `fromRow` (App.tsx)
   * falls back to parsing a legacy Fase-B row's `cwd` as the messages
   * blob when this column is empty, so an existing chat card from before
   * this migration doesn't lose its history. */
  messages_json: string | null;
  /** DESIGN-BACKLOG.md item 30 — closing a `chat`-kind card archives it
   * (this set to a real timestamp) instead of deleting the row, so its
   * `messages_json` history survives for the sessions sidebar to list
   * and reopen later. `null` = live, showing on its board — every OTHER
   * kind (terminal/browser/files/…) never sets this at all, closing them
   * is still a real `deleteCard` exactly as before; only chat's history
   * is worth keeping around after the card itself is gone. */
  archived_at: number | null;
};

export type ConnectorRow = {
  id: string;
  board_id: string;
  from_card_id: string;
  to_card_id: string;
  updated_at: number;
  /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 4 — `null`
   * (every connector before this, and any the human draws via the UI
   * today) means purely decorative, no semantic — never silently
   * reinterpreted as a hard gate. `'depends'`/`'context'` is meaning an
   * orchestrating agent attaches on purpose via `set_connector_kind`.
   * DELIBERATELY not consumed by item 60 peça 3's task-auto-dispatch
   * engine, and never will be by design, not oversight (flagged live by
   * a reviewing agent as a potential ambiguity, resolved by this note):
   * this links CARDS, which may or may not have a task at all; a task's
   * real dependency graph is `tasks.deps_json` (task ids), which exists
   * and is meaningful even for a task with no card yet. Two different
   * granularities, kept deliberately separate rather than merged into
   * one fragile dual-source-of-truth graph — `kind` here stays whatever
   * an orchestrator wants it to mean for ITS OWN reading, nothing in
   * this app ever dispatches off it.
   *
   * Two kinds this app still treats as lineage on the graph (never for
   * task auto-dispatch). They used to also route a PTY/OS push when a
   * card reported, went idle, or exited without report — those callers
   * are gone; the orchestrator polls `card_status` + `read_report`.
   * - `'spawned'` — lineage from `spawn_agent`. `set_connector_kind`
   *   still guards writes that declare or disarm this kind.
   * - `'modified'` — auto-connect from `send_to_card` (and other
   *   mutation cmds). Persists across main-process restarts; do not
   *   reintroduce an in-memory shadow of this edge. Never promote
   *   `modified` to `spawned` just because a send happened. */
  kind: string | null;
  /** Short free-text motivation for the connector — "aplicou em queue.ts",
   * "ctx: nota fixada" — set once at creation time from whatever text was
   * already in scope for that mutation (sticky content, `send_to_card`
   * text, …), truncated by the caller before it gets here. `null` for
   * every connector before this and for `kind`-only auto-connects with no
   * natural short text (spawn, set_color/set_mode). Same read-only,
   * advisory posture as `kind` above: never overwritten once set (see
   * `autoConnect`'s idempotency in App.tsx), never consumed by dispatch. */
  label: string | null;
};

/** DESIGN-BACKLOG.md §2.1 "próxima rodada" — favoritos do navegador,
 * globais pro app inteiro (decisão explícita do usuário, não por board):
 * um site salvo faz sentido reusar entre projetos diferentes. `url` como
 * chave primária — favoritar a mesma URL duas vezes só atualiza o
 * título, nunca duplica linha. */
export type FavoriteRow = { url: string; title: string; created_at: number };

export type BoardRow = {
  id: string;
  name: string;
  /** Display label for "Projects › {project} › {session}" grouping (item
   * 1) — "" means ungrouped. Derived automatically from `cwd`'s basename
   * at create/edit time (see useBoardStore.ts), not independently typed. */
  project: string;
  /** The session's real working directory (item 1 revisited — "não
   * persiste o caminho correto") — an absolute path under some workspace,
   * picked via PathPicker.tsx's tree. Seeds every terminal/files/changes
   * card spawned into this board (see useBoardStore.ts's seedCards and
   * App.tsx's activeBoardCwd). "" for a board that predates this column;
   * callers fall back to DEFAULT_CWD. */
  cwd: string;
  created_at: number;
  updated_at: number;
  /** Home's "último acesso" (DESIGN-BACKLOG.md item 14) — set on every
   * successful open (create or switch), NOT on metadata edits (rename/
   * project change), which is what `updated_at` already tracks. `null`
   * for a board created before this column existed. */
  last_accessed_at: number | null;
  /** DESIGN-BACKLOG.md item 59 — opt-in, per-board, never inherited by
   * duplicating a board or creating one from a template (every creation
   * path explicitly sets this `false`, it's never copied from another
   * board's row). Only a human flips this via the session UI — no
   * MCP/acbridge command ever touches it, on purpose: an agent must never
   * be able to grant itself the ability to spawn other agents without
   * asking. When `true`, `spawn_agent` requests from a card ON THIS BOARD
   * auto-approve instead of showing `AgentAskModal` (see message-bus.ts's
   * `spawn_agent` handler) — every other board, and every other
   * consent-gated action (open_url, spawn_card), is unaffected. */
  autonomous: boolean;
  /** DESIGN-BACKLOG.md item 60, peça 2 — per-board override of
   * message-bus.ts's DEFAULT_CONCURRENCY_CAP. `null` means "use the
   * default", not "zero" — a board that predates this column, or that
   * never had the cap touched, must not suddenly refuse every spawn. */
  concurrency_cap: number | null;
};

export type BoardCounts = { agents: number; active: number };

/** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 3 — a task's
 * identity is deliberately its own id, not a card's: `card_id` is
 * nullable/stale-able on purpose (closing the card, or the app
 * restarting, must never lose the task's record — only the live process
 * behind it). `deps_json`/`result_json` are opaque JSON blobs, same
 * convention as `cards.messages_json` — parsed at the message-bus/MCP
 * boundary, not here. */
export type TaskRow = {
  id: string;
  prompt: string | null;
  provider: string | null;
  status: string;
  card_id: string | null;
  /** DESIGN-BACKLOG.md item 60, peça 3 — set once at `create_task` (from
   * an explicit `boardId`, else inferred from `cardId`'s board), never
   * re-derived afterward — unlike `card_id`, this outlives the card
   * closing. `null` means the task was created with neither, and is
   * therefore never a candidate for auto-dispatch (the engine has no
   * board to check for autonomous mode) — pure external-orchestrator
   * bookkeeping only, same as before this column existed. */
  board_id: string | null;
  /** Working directory for auto-dispatch spawns. Set at `create_task`
   * (or later via `update_task`); `null` means "use the board root" —
   * the same fallback `App.tsx` already applied when spawn params omitted
   * cwd, now declared on the task instead of hardcoded `undefined` in
   * `onTaskDone`. No repo-heuristic fill-in. */
  cwd: string | null;
  result_json: string | null;
  deps_json: string | null;
  /**
   * Proposal of the task — what it IS (`investigate`/`implement`/`measure`/`fix`).
   * Written ONCE at create (`upsertTask` INSERT); the ON CONFLICT path
   * never lists this column, so a later `update_task` cannot relabel it.
   * The writer is `create_task.purpose` (mcp-server.ts inputSchema +
   * message-bus.ts handler, 2026-09-13), which REFUSES an unknown value
   * before anything is inserted — so `normalizeTaskPurpose` below only
   * ever sees a valid enum or absence from that path; its null fallback
   * covers legacy rows and direct store callers.
   *
   * `null` is NORMAL, not a hole to fill: 2026-09-13 measured 91/91
   * `task_cards.role = implementer` (silent default) and 140/148
   * `task_verdicts.verdict` null. A silent purpose default would make
   * the Fila lie with more confidence. UI degrades to an empty chip.
   * Optional on the type so existing TaskRow constructors stay valid;
   * SQL persists explicit nulls. Never inferred from `prompt` text.
   */
  purpose?: string | null;
  /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 5 —
   * `retry_count` is incremented by the app on each in-line `report`
   * refusal (same agent, same session) and by `update_task.incrementRetry`
   * when a human/orchestrator reassigns by hand. `attempted_providers_json`
   * (JSON array, in order tried) is bookkeeping for that hand reassignment
   * — the app never picks a fallback provider itself. */
  retry_count: number;
  attempted_providers_json: string | null;
  /** DESIGN-BACKLOG.md item 60, peça 4 — set once at `create_task`,
   * never changed after. `null` means "use the app-wide default"
   * (`DEFAULT_MAX_RETRIES` in message-bus.ts), same convention as
   * `boards.concurrency_cap`. Bounds in-line `report` refusals for the
   * same agent; once `retry_count` reaches this, a declared failure is
   * accepted and the task stays `failed`. */
  max_retries: number | null;
  /** Bookkeeping list of substitute providers for a human/orchestrator
   * who reassigns by hand (`update_task.attemptedProvider`). The app
   * never reads this to spawn or reassign — kept public so that loop
   * does not have to track the list elsewhere. */
  fallback_providers_json: string | null;
  /** DESIGN-BACKLOG.md §2.1 "Card `task`", decisão 6 — DOIS DONOS
   * deliberadamente separados: `order` só é escrito por um humano
   * arrastando (nenhuma superfície nesta fase escreve nele — a UI da
   * Fase 2 é quem vai), `suggested_order` só por um agente (via
   * `update_task`/`create_task`). Um campo só faria o próximo agente
   * sobrescrever o palpite humano sem perceber — por isso dois, nunca
   * disputados entre si; o humano vence na leitura (Fase 2), não aqui. */
  order: number | null;
  suggested_order: number | null;
  /** DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 — review adversarial (rodada
   * 3, achado 1, ALTO). O TERCEIRO nível que faltava no modelo: nem
   * "decisão humana" (`order`) nem "opinião do agente"
   * (`suggested_order`) — uma posição que existe só porque OUTRA task
   * vizinha foi arrastada e precisou de alguém comparável do lado (uma
   * vizinha intocada, sort key não-finita, não consegue "ficar entre"
   * duas tasks com chave real sem ganhar uma chave real também). Nunca
   * escrito por um humano nem por um agente — só pelo próprio app,
   * dentro do MESMO lote atômico que grava o `order` real da task
   * arrastada (`store.applyColumnDrop`, nunca solto por fora).
   *
   * Precedência de leitura (`taskSortKey`, task-board-model.ts):
   * `order` (humano, absoluto) > `suggested_order` (agente) >
   * `implicit_order` (app, só posição) > nada (`Infinity`). Isto é o que
   * fecha o achado da rodada 3: escrever `order` numa vizinha intocada a
   * tornava PERMANENTEMENTE imune a um `suggested_order` futuro (`order`
   * sempre vence, uma vez setado, sem exceção) — `implicit_order` fica
   * ABAIXO de `suggested_order` na precedência, então o PRÓXIMO
   * `update_task({suggestedOrder})` de um agente para essa mesma task
   * simplesmente vence, sem nenhuma proteção especial necessária. Uma
   * vizinha materializada aqui nunca teve NADA decidido sobre ela — só
   * ganhou um número comparável, e continua tão aberta a repriorização
   * quanto estava antes. */
  implicit_order: number | null;
  /** DESIGN-BACKLOG.md §2.1 Decisão 8 — sinal VIVO de divergência (não
   * histórico). Quando o humano é o último ator de status e um app/agente
   * tenta outro status, o status humano fica; estes dois campos guardam
   * o que foi declarado. `null`/`null` = sem divergência ativa. Limpos
   * quando o humano escreve de novo ou quando uma escrita posterior
   * propõe exatamente o status humano (alinhamento). Persistidos — o
   * quadro precisa deles depois de um restart, não só em memória. */
  diverged_status: string | null;
  diverged_actor: TaskActor | null;
  /** Third path (status-write-decision.ts `decideStatusAsk`): a live
   * request that the human has not answered yet. Independent of
   * `diverged_*` — an ask coexists with a held-write signal. `null` on
   * every field = no pending ask. Written only by `setStatusAsk`;
   * ordinary upserts retain or clear via `retainStatusAsk`. Optional on
   * the type so existing TaskRow constructors (tests, create_task) stay
   * valid; SQL always persists explicit nulls. */
  requested_status?: string | null;
  requested_reason?: string | null;
  requested_by?: string | null;
  requested_at?: number | null;
  /** DESIGN-BACKLOG.md §2.1 "Historico de sprints" — exatamente UM sprint
   * vivo por vez. Histórico de sprints fechados vive na tabela `sprints`
   * (snapshot congelado), nunca reconsultando status vivo. `null`/ausente
   * na escrita = atribuir ao sprint ativo do board (upsertTaskInternal). */
  sprint_id?: string | null;
  created_at: number;
  updated_at: number;
  /** Transiente — NUNCA uma coluna de `tasks`, nunca lido de volta do
   * banco (`getTaskStmt`/`listTasksStmt` não o selecionam). Único jeito
   * de `actor` atravessar a fronteira de callbacks até `upsertTask`
   * sem tocar em index.ts (que só repassa `task` por referência pro
   * store) — ver o comentário grande de `upsertTask` abaixo pra
   * justificativa completa. Ausente = "agent" (toda chamada de
   * create_task/update_task de hoje vem de um agente via MCP). */
  actor?: TaskActor;
  /**
   * Transient — like `actor`. When `false`, the caller did NOT propose a
   * status change (e.g. `update_task` without a `status` field). Absent
   * or `true` = `status` on this object is an intentional proposal.
   * Distinguishes legitimate alignment (explicit same status → clear
   * divergence) from bookkeeping-only writes (must keep divergence).
   * Adversarial review 2026-09-11, finding 3.
   */
  statusProposed?: boolean;
  /** Transiente, só de LEITURA — anexado só por `getTask` (nunca por
   * `listTasks`, de propósito: manter a listagem em massa barata).
   * DESIGN-BACKLOG.md §2.1 "MCP: exponha a trilha em LEITURA (no
   * get_task, por exemplo)". `upsertTask` ignora este campo mesmo que
   * esteja presente no objeto passado — nunca persistido. */
  transitions?: TaskTransitionRow[];
  /** Transiente, só de LEITURA — mesmo motivo/anexação que `transitions`
   * acima. */
  cards?: TaskCardRow[];
  /** Transiente, só de LEITURA — mesmo motivo/anexação que `transitions`
   * acima. "Histórico de veredito por participação": o log append-only
   * de `task_verdicts` (ver `TaskVerdictRow`'s comentário grande), em
   * ordem cronológica. Exposto no MCP só por aqui (`get_task`), nunca
   * por uma tool que escreve — a restrição não-negociável do item. */
  verdicts?: TaskVerdictRow[];
};

/** `actor` de `task_transitions` — quem causou a transição. "app" é o
 * próprio motor (onTaskDone/card saindo sem reportar,
 * message-bus.ts), "agent" é uma chamada de create_task/update_task via
 * MCP, "human" é reservado pra Fase 2 (arrastar a mão no board). */
export type TaskActor = "app" | "agent" | "human";

/** DESIGN-BACKLOG.md §2.1 "Log de transição (`task_transitions`)" —
 * desenhada e aprovada em separado da tabela `tasks`. `kind` distingue
 * `status` (o que esta fase efetivamente grava, de dentro de
 * `upsertTask`) de `stage` (reservado pra quando o modelo ganhar um
 * conceito de etapa/review — ver DESIGN-BACKLOG decisão 3, "review é
 * etapa, não coluna" — nada aqui inventa essa coluna agora) de
 * `declaration` (Decisão 8: escrita de app/agente que NÃO deslocou o
 * status humano — auditada aqui sem virar `kind:'status'`, senão
 * `last_actor` deixaria de ser `"human"` e a próxima escrita passaria
 * por cima) de `prompt` (o enunciado mudou de verdade — acréscimo ou
 * replace explícito; NÃO é `declaration`, porque a escrita pegou, e NÃO
 * é `status`, senão `last_actor` / o gráfico de ciclo leria um
 * acréscimo de briefing como se fosse mudança de coluna). Guardado pra
 * sempre, podado só junto com a task (nenhuma função de deleteTask
 * existe ainda neste código — nada a podar por enquanto). Nunca inventar
 * histórico sintético pra tasks que já existiam antes desta tabela: a
 * trilha delas começa vazia, de propósito (decisão explícita do dono do
 * repo — pareceria dado real e sujaria os gráficos futuros). */
export type TaskTransitionRow = {
  id: string;
  task_id: string;
  kind: "status" | "stage" | "declaration" | "prompt" | "request" | "request_denied" | "request_resolved";
  from_value: string | null;
  to_value: string;
  actor: TaskActor;
  card_id: string | null;
  at: number;
};

/** DESIGN-BACKLOG.md §2.1 "Vínculo task ↔ vários cards com papel" —
 * `tasks.card_id` continua funcionando exatamente como antes (a task
 * "atual"/principal); esta tabela é o recorte pra "306 implementa, 304
 * revisa" ao mesmo tempo, sem forçar quem já lê `card_id` a mudar nada.
 * PK composta (task_id, card_id): um card só tem UM papel por task —
 * trocar de papel é um upsert, não uma segunda linha.
 *
 * `role: "reviewer"` is what the Fila ` ↔ review` arrow derives from.
 * Measured 2026-09-13: 0 of 91 rows were reviewer — not disuse, there was
 * no writer: `upsertTask` only writes the if-absent `implementer`
 * (`upsertTaskCardIfAbsent`) and nothing called `linkTaskCard`. Same day,
 * two MCP/acbridge writers were added (message-bus.ts): `spawn_agent`
 * accepts `role` alongside `taskId`, and `link_task_card` sets a role on
 * a card that already exists. Both call `linkTaskCard` for `reviewer`
 * and validate against `TASK_CARD_ROLES` (task-purpose.ts), refusing
 * anything else. A reviewer never becomes `tasks.card_id`: `report`
 * derives the retry budget and task failure from that column, and a
 * reviewer's `{ok:false}` is a verdict, not the task failing. */
export type TaskCardRow = { task_id: string; card_id: string; role: string };

/** DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação"
 * (levantado 2026-09-11, ao fechar a fidelidade visual do card Fila —
 * ver o item longo no backlog pro porquê é "um trabalho que paga
 * quatro"). `reports` era um SLOT único por card — bom pro "qual é o
 * relatório mais recente", incapaz de responder "quantas rodadas até
 * aprovar". Em 2026-09-12 `reports` passou a append-only por `seq` (mesmo
 * princípio); esta tabela continua sendo o log por RODADA DE PARTICIPAÇÃO
 * (task+card+papel) com `verdict`, distinto do payload JSON do relatório.
 *
 * `role` é copiado de `task_cards` NO MOMENTO da rodada (não uma
 * referência viva) — se o papel do card mudar depois via `linkTaskCard`,
 * as linhas antigas continuam dizendo qual papel ele tinha QUANDO
 * participou daquela rodada, nunca reescritas.
 *
 * `verdict: null` é um valor real aqui, não "ainda sem informação": uma
 * rodada pode terminar SEM veredito (relatório sem campo `verdict`, ou
 * o processo saiu sem NUNCA chamar `report` — "Sinal 2", já existente).
 * As duas causas de `null` são propositalmente indistinguíveis nesta
 * tabela (nenhuma delas produziu uma decisão), exatamente como
 * `originBadge`/`deriveStage` (task-board-model.ts) já tratam "sem
 * selo" e "ator desconhecido" como o mesmo caso.
 *
 * SEM PK composta de propósito (ao contrário de `task_cards`): nada
 * aqui impede duas rodadas do MESMO (task_id, card_id) — é exatamente
 * o caso mais comum (um reviewer reprova, o mesmo card reporta de novo
 * na rodada seguinte). `id` é um UUID gerado no INSERT, como
 * `task_transitions.id` — a ordem real vem de `idx_tv_task(task_id,
 * at)`. Nunca escrita direto por um chamador: só `store.ts`'s
 * `recordParticipationRound` (definida perto de `applyColumnDrop`)
 * grava aqui, dentro do MESMO choke point que já grava `reports`
 * (`cmd === "report"`, message-bus.ts) e do já existente ramo de
 * saída-sem-relatório de `resolveCardExit` ("Sinal 2"). MCP só LEITURA
 * (`get_task`, mesmo padrão de `transitions`/`cards`) — nenhuma tool
 * escreve aqui, por decisão explícita (ver o comentário grande do
 * item no DESIGN-BACKLOG: "poder ESCREVER veredito transforma registro
 * em narrativa"). */
export type TaskVerdictRow = { id: string; task_id: string; card_id: string; role: string; verdict: string | null; at: number };

/** Lean task row frozen into `sprints.snapshot_json` at close — enough
 * for the Fila card to render a read-only board of that sprint without
 * consulting live `tasks` (migrated rows left; live status would lie). */
export type SprintSnapshotTask = {
  id: string;
  prompt: string | null;
  status: string;
  order: number | null;
  suggested_order: number | null;
  implicit_order: number | null;
  created_at: number;
  updated_at: number;
};

/** DESIGN-BACKLOG.md §2.1 "Historico de sprints — fechamento EXPLICITO".
 * Uma linha por sprint de um board. `closed_at IS NULL` = sprint ativo.
 * Contagens e migrated_* em sprint FECHADO são SNAPSHOT do instante do
 * close (`decideSprintClose`) — nunca recalculadas depois. No sprint
 * ativo, count_* ficam 0 até o fechamento; `migrated_in` já nasce no
 * open (quantas tasks vieram do sprint anterior).
 * `number` = identidade automática por board; `name` editável depois
 * (null → UI mostra "Sprint N"). `snapshot_json` = quadro congelado. */
export type SprintRow = {
  id: string;
  board_id: string;
  number: number;
  name: string | null;
  started_at: number;
  closed_at: number | null;
  count_todo: number;
  count_doing: number;
  count_done: number;
  count_failed: number;
  migrated_in: number;
  migrated_out: number;
  /** JSON of `SprintSnapshotTask[]` — set only on close; null while open. */
  snapshot_json: string | null;
};

/** DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" — achado ao
 * vivo (2026-09-09, sessão real): um card de review chamou `report`, saiu
 * com código 0, o bus respondeu `reported` — e o relatório sumiu. Causa:
 * `cardReports` (message-bus.ts) era um `Map` puro em memória, apagado em
 * TODO restart. Persistência resolveu o restart; o schema ORIGINAL era
 * ainda um SLOT (`card_id` PRIMARY KEY + `ON CONFLICT DO UPDATE`) — um
 * reviewer que reportava rodada 1, 2, 3 só preservava a última, e
 * `afterSeq` depois do fato nunca recuperava o conteúdo das anteriores
 * (DESIGN-BACKLOG.md §0 "Dois avisos de relatorio do mesmo card",
 * 2026-09-12). Agora é APPEND-ONLY por `seq` (PK global monotônica), no
 * mesmo espírito de `task_verdicts`: cada `report` é uma linha, nunca
 * sobrescrita. `getReport(cardId)` sem `afterSeq` continua devolvendo só
 * o mais recente — quem lê "o relatório atual" não muda de contrato.
 *
 * Ciclo de vida — o que ficou e o que foi DESCARTADO:
 * - Histórico por card (guardar as N rodadas): MANTIDO agora (append-only
 *   por `seq`). `read_report` sem `afterSeq` ainda é "o mais recente";
 *   com `afterSeq` devolve o PRÓXIMO (`seq` estritamente maior), para
 *   caminhar o histórico depois do fato sem pular rodadas.
 * - Cascade delete ao fechar/deletar o card: DESCARTADO — fechar um card
 *   hoje já é independente da entrega do relatório; o padrão real é
 *   "spawna, espera o relatório, fecha o card, segue trabalhando".
 * - TTL por tempo: DESCARTADO — um board pode ficar dias fechado e o
 *   relatório continua sendo o resultado que o orquestrador foi buscar.
 * - Limite de TAMANHO por relatório: DESCARTADO — truncar destruiria dado
 *   real.
 * - Limite de CONTAGEM total (`MAX_STORED_REPORTS` abaixo): MANTIDO — agora
 *   o crescimento vem de `card_id` novo E de múltiplas rodadas por card;
 *   o mesmo corte por contagem (descarta as linhas de `seq` mais antigas
 *   quando o total passa do cap) impede crescimento ilimitado sem inventar
 *   regra de "relevância". Roda a cada `upsertReport` (`pruneReports`).
 */
/** `verdict` — DESIGN-BACKLOG.md §2.1 decisão 9: hoje `{"verdict":
 * "aprovado"|"reprovado"}` dentro de `report_json` é só convenção dos
 * briefings do orquestrador, nada valida. Campo real, coluna própria
 * (mesmo padrão aditivo/nullable de `effort`/`board_id` acima) —
 * OPCIONAL, `null` pra todo relatório de antes desta coluna e pra
 * qualquer `report` que não mande verdict. Vira o gancho da Fase 2 pra
 * um review aprovado PROPOR a conclusão da task. Opcional (não
 * obrigatório em todo `ReportRow` literal) pra não quebrar quem já
 * constrói um sem essa chave — `upsertReport` normaliza ausência pra
 * `null` antes de ligar o statement, mesmo padrão de `messages_json`
 * em `upsertCard`.
 *
 * `role` — quem mandou, no sentido de `task_cards.role` do card que
 * reportou, copiado NO MOMENTO do report (mesmo princípio de
 * `TaskVerdictRow.role`: fato daquela rodada, nunca reescrito). Medido
 * 2026-09-13: os 14 `verdict='aprovado'` até então eram TODOS do
 * próprio implementador, e a barra de proposta de conclusão reagia ao
 * valor sem saber quem o escreveu. `null` = papel DESCONHECIDO (card
 * sem vínculo em `task_cards`, ou vinculado a mais de uma task com
 * papéis diferentes — o report é por card, não diz de qual task fala).
 * `null` é registro honesto, não default: NUNCA normalizar pra
 * `implementer` aqui — foi exatamente isso que tornou 156/156 linhas
 * indistinguíveis em `task_verdicts`. Linhas de antes desta coluna
 * ficam `null` de propósito (sem backfill: reescrevê-las inventaria
 * história). */
export type ReportRow = { card_id: string; seq: number; report_json: string; verdict?: string | null; role?: string | null; updated_at: number };

// Cap de contagem TOTAL de LINHAS (não "um por card"). Generoso o bastante
// pra uso normal (KB * 1000 ainda é trivial pro SQLite) e existir só como
// rede de segurança contra crescimento sem fim — o append-only por card
// não vira crescimento ilimitado.
const MAX_STORED_REPORTS = 1000;

const DEFAULT_BOARD_ID = "default";

function migrate(db: Database.Database) {
  for (const col of [
    "resume_id TEXT",
    "model TEXT",
    "system_prompt TEXT",
    "kind TEXT NOT NULL DEFAULT 'terminal'",
    `board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}'`,
    "group_id TEXT",
    "label TEXT",
    "messages_json TEXT",
    "archived_at INTEGER",
    // DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" — see the
    // `CardRow.effort` doc comment above for the full why. Same
    // ALTER-then-catch-duplicate-column pattern as every column above.
    "effort TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE cards ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  try {
    db.exec(`ALTER TABLE connectors ADD COLUMN board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}'`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE connectors ADD COLUMN kind TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE connectors ADD COLUMN label TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  for (const col of ["retry_count INTEGER NOT NULL DEFAULT 0", "attempted_providers_json TEXT"]) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN project TEXT NOT NULL DEFAULT ''`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN last_accessed_at INTEGER`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN cwd TEXT NOT NULL DEFAULT ''`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN concurrency_cap INTEGER`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN board_id TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN max_retries INTEGER`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN fallback_providers_json TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  // DESIGN-BACKLOG.md §2.1, decisão 6 — `"order"` precisa de aspas duplas
  // em TODA referência SQL (aqui e nos statements abaixo): é palavra
  // reservada do grammar do SQLite (ORDER BY), mas válida como nome de
  // coluna quando citada. `suggested_order` não colide, sem aspas.
  for (const col of [`"order" INTEGER`, "suggested_order INTEGER"]) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  // DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 — review adversarial (rodada 3,
  // achado 1, ALTO): `order`/`suggested_order` sozinhos não conseguem
  // exprimir "esta task foi POSICIONADA (efeito colateral de arrastar uma
  // vizinha) sem que um humano tenha DECIDIDO nada sobre ela". Escrever
  // `order` numa vizinha intocada pra fazer a task arrastada caber entre
  // duas outras a tornava PERMANENTEMENTE imune a um `suggestedOrder`
  // futuro do agente (`order` sempre vence, uma vez setado, pra sempre) —
  // exatamente o que a decisão 6 nunca quis dizer com "arrastar". Ver o
  // comentário grande de `TaskRow.implicit_order` abaixo pro modelo
  // completo (3 níveis: `order` > `suggested_order` > `implicit_order` >
  // nada).
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN implicit_order INTEGER`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  // DESIGN-BACKLOG.md §2.1 Decisão 8 — sinal vivo de divergência. Ver
  // `TaskRow.diverged_status` / `diverged_actor` acima.
  for (const col of ["diverged_status TEXT", "diverged_actor TEXT"]) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — membership vivo.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN sprint_id TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  // Auto-dispatch cwd — without this, onTaskDone/retryOrFail hardcoded
  // `cwd: undefined` and the agent opened at the board root (often $HOME),
  // stuck on "trust this folder" until exit 129 + another identical card.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN cwd TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  // Third path — agent asks, human decides. Independent of diverged_*.
  for (const col of [
    "requested_status TEXT",
    "requested_reason TEXT",
    "requested_by TEXT",
    "requested_at INTEGER",
  ]) {
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  try {
    db.exec(`ALTER TABLE reports ADD COLUMN verdict TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  // Papel de quem reportou (ver `ReportRow.role`). Aditiva, nullable,
  // linhas existentes ficam NULL — "papel desconhecido" é o valor
  // correto pra um report de antes da coluna, não `implementer`.
  try {
    db.exec(`ALTER TABLE reports ADD COLUMN role TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  // Task proposal (`investigate|implement|measure|fix`). Nullable on
  // purpose: absence is NORMAL (empty chip), never a silent default.
  // Additive only — existing rows stay NULL. See TaskRow.purpose.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN purpose TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
  }
  // DESIGN-BACKLOG.md §0 "Dois avisos de relatorio do mesmo card" — o
  // schema original tinha `card_id` PRIMARY KEY (slot único). Instalações
  // novas já nascem append-only (`seq` PK) no CREATE TABLE IF NOT EXISTS
  // abaixo; bancos antigos ainda têm o slot e precisam de rebuild. Detecta
  // pelo PK real (`pragma_table_info`), nunca por "a tabela existe".
  const reportCols = db.prepare(`SELECT name, pk FROM pragma_table_info('reports')`).all() as {
    name: string;
    pk: number;
  }[];
  if (reportCols.length > 0) {
    const pkCols = reportCols.filter((c) => c.pk > 0).map((c) => c.name);
    if (pkCols.length === 1 && pkCols[0] === "card_id") {
      db.exec(`ALTER TABLE reports RENAME TO reports_slot_legacy`);
      db.exec(`
        CREATE TABLE reports (
          seq INTEGER PRIMARY KEY,
          card_id TEXT NOT NULL,
          report_json TEXT NOT NULL,
          verdict TEXT,
          role TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
      db.exec(`
        INSERT INTO reports (seq, card_id, report_json, verdict, updated_at)
        SELECT seq, card_id, report_json, verdict, updated_at FROM reports_slot_legacy
      `);
      db.exec(`DROP TABLE reports_slot_legacy`);
    }
  }
}

export function openStore(userDataDir: string) {
  const db = new Database(join(userDataDir, "agent-canvas.db"));
  // Pre-release audit P3 — no journal mode was ever set (SQLite's
  // rollback-journal default), meaning every writer briefly locks
  // readers out. WAL lets the renderer's frequent reads (board/card
  // lists, chat history) proceed concurrently with the frequent small
  // writes (card position drags, chat message appends) this app does
  // constantly. Set once, up front, before anything reads/writes.
  db.pragma("journal_mode = WAL");
  db.exec(`
    -- ENCERRADO (review adversarial, 2026-09-09, achado 2 RODADA 3 —
    -- decisão do coordenador, não do reviewer): a ordem física das
    -- colunas abaixo varia entre gerações de instalação (cada versão do
    -- app rodou 'ALTER TABLE ADD COLUMN' — que sempre acrescenta no fim
    -- físico — numa época diferente; não dá pra reescrever a ordem de
    -- quem já instalou). Isso é ESPERADO e INOFENSIVO: toda query neste
    -- arquivo nomeia colunas explicitamente, nunca 'SELECT *' nem
    -- depende de posição. NÃO tente "consertar" isso de novo — já foram
    -- duas rodadas de review nisso; a ordem abaixo é só a de uma
    -- instalação nova, sem significado além disso.
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      resume_id TEXT,
      model TEXT,
      system_prompt TEXT,
      kind TEXT NOT NULL DEFAULT 'terminal',
      board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}',
      group_id TEXT,
      label TEXT,
      messages_json TEXT,
      archived_at INTEGER,
      effort TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_ID}',
      from_card_id TEXT NOT NULL,
      to_card_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      kind TEXT,
      label TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT,
      provider TEXT,
      status TEXT NOT NULL,
      card_id TEXT,
      result_json TEXT,
      deps_json TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      attempted_providers_json TEXT,
      "order" INTEGER,
      suggested_order INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // DESIGN-BACKLOG.md §2.1 "Log de transição (task_transitions)" — ver o
  // comentário grande de `TaskTransitionRow` acima pro ciclo de vida
  // completo. `id` é um UUID (não rowid) só por consistência com o resto
  // do schema; a ordem real vem de `idx_tt_task(task_id, at)` abaixo.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_transitions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT NOT NULL,
      actor TEXT NOT NULL,
      card_id TEXT,
      at INTEGER NOT NULL
    );
  `);

  // DESIGN-BACKLOG.md §2.1 "Vínculo task ↔ vários cards com papel" — ver
  // o comentário grande de `TaskCardRow` acima.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_cards (
      task_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (task_id, card_id)
    );
  `);

  // Ver o comentário grande de `ReportRow` acima. `seq` (monotônica global,
  // atribuída pelo bus) é a PRIMARY KEY — append-only, uma linha por
  // `report`. Bancos antigos com `card_id` PK são reescritos em `migrate()`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      seq INTEGER PRIMARY KEY,
      card_id TEXT NOT NULL,
      report_json TEXT NOT NULL,
      verdict TEXT,
      role TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  // DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" — ver
  // o comentário grande de `TaskVerdictRow` acima pro modelo completo.
  // Tabela NOVA (não coluna em `task_cards`, não reaproveito de
  // `reports`): `task_cards` tem PK `(task_id, card_id)` de propósito —
  // é "qual papel este card tem AGORA", presente, upsert; guardar
  // rodada ali quebraria essa PK (duas rodadas do mesmo par colidiriam)
  // e mudaria o significado de uma tabela que outro código já lê como
  // "vínculo atual" (`listTaskCardsStmt`/`taskCardsForBoardStmt`).
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_verdicts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      role TEXT NOT NULL,
      verdict TEXT,
      at INTEGER NOT NULL
    );
  `);

  // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — ver SprintRow.
  // Snapshot columns default 0; filled only on close (active rows keep
  // zeros in count_* until then). Exactly one row per board may have
  // closed_at IS NULL (enforced in closeSprint/ensureActiveSprint, not
  // by a partial UNIQUE — SQLite partial indexes work, but the write
  // path already serializes this in a transaction).
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      number INTEGER NOT NULL DEFAULT 1,
      name TEXT,
      started_at INTEGER NOT NULL,
      closed_at INTEGER,
      count_todo INTEGER NOT NULL DEFAULT 0,
      count_doing INTEGER NOT NULL DEFAULT 0,
      count_done INTEGER NOT NULL DEFAULT 0,
      count_failed INTEGER NOT NULL DEFAULT 0,
      migrated_in INTEGER NOT NULL DEFAULT 0,
      migrated_out INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT
    );
  `);
  // Additive columns for DBs that already had the thinner sprints table.
  for (const col of ["number INTEGER NOT NULL DEFAULT 1", "name TEXT", "snapshot_json TEXT"]) {
    try {
      db.exec(`ALTER TABLE sprints ADD COLUMN ${col}`);
    } catch (e) {
      if (!String(e).includes("duplicate column name")) throw e;
    }
  }
  // Backfill sequential `number` per board when rows still share the
  // DEFAULT 1 from ALTER (idempotent: only rewrites boards where two
  // rows collide on the same number).
  {
    const boards = db.prepare(`SELECT DISTINCT board_id FROM sprints`).all() as { board_id: string }[];
    const rowsFor = db.prepare(`SELECT id FROM sprints WHERE board_id = ? ORDER BY started_at ASC, id ASC`);
    const setNum = db.prepare(`UPDATE sprints SET number = ? WHERE id = ?`);
    for (const { board_id } of boards) {
      const rows = rowsFor.all(board_id) as { id: string }[];
      let n = 1;
      for (const r of rows) setNum.run(n++, r.id);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_favorites (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Must run after every CREATE TABLE IF NOT EXISTS above (cards,
  // connectors, AND boards — it now ALTERs all three): on a brand-new
  // database running it any earlier throws "no such table" for whichever
  // table isn't created yet — confirmed live before with cards/connectors,
  // same class of bug would hit boards.project otherwise.
  migrate(db);

  // Pre-release audit P3 — the columns every hot query filters by
  // (board-scoped lists, connector lookups by either endpoint, task
  // scheduling) had no index at all, forcing a full table scan as either
  // table grows. `IF NOT EXISTS` — safe to run on every `openStore`, same
  // idempotent posture as the `CREATE TABLE IF NOT EXISTS` calls above.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cards_board_id ON cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_connectors_board_id ON connectors(board_id);
    CREATE INDEX IF NOT EXISTS idx_connectors_from_card_id ON connectors(from_card_id);
    CREATE INDEX IF NOT EXISTS idx_connectors_to_card_id ON connectors(to_card_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_board_id ON tasks(board_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_sprint_id ON tasks(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_sprints_board_id ON sprints(board_id);
    CREATE INDEX IF NOT EXISTS idx_reports_card_seq ON reports(card_id, seq);
    CREATE INDEX IF NOT EXISTS idx_tt_task ON task_transitions(task_id, at);
    CREATE INDEX IF NOT EXISTS idx_task_cards_task ON task_cards(task_id);
    CREATE INDEX IF NOT EXISTS idx_tv_task ON task_verdicts(task_id, at);
  `);

  // DESIGN-BACKLOG.md §2.1 "Migração de dados: as linhas existentes com
  // card_id viram uma linha de junção com papel razoável" — roda em TODO
  // openStore (idempotente via NOT EXISTS: uma task que já tem QUALQUER
  // linha em task_cards, seja desta migração ou de um `upsertTask`/
  // `linkTaskCard` posterior, nunca é tocada de novo — não sobrescreve um
  // papel que já foi decidido). "implementer" é o papel razoável: é
  // exatamente o que `card_id` sempre significou até aqui (o card
  // trabalhando na task), nunca um reviewer.
  db.exec(`
    INSERT INTO task_cards (task_id, card_id, role)
    SELECT id, card_id, 'implementer' FROM tasks
    WHERE card_id IS NOT NULL AND card_id != ''
      AND NOT EXISTS (SELECT 1 FROM task_cards WHERE task_cards.task_id = tasks.id)
  `);

  // RODADA 4 (DESIGN-BACKLOG.md §2.3, achado do rodapé de escopo — seis
  // tasks presas a `board_id = "1"`, um board REAL que existiu e foi
  // deletado) — `deleteBoard` (abaixo) agora reatribui em vez de
  // abandonar, então isto é rede de segurança pras órfãs que já existiam
  // ANTES desse fix (e pra qualquer instalação mais antiga que ainda não
  // rodou esta versão). Roda em TODO `openStore`, idempotente por
  // construção: `board_id NOT IN (SELECT id FROM boards)` já não acha
  // nada pra tocar depois da primeira vez — 0 linhas afetadas nas
  // chamadas seguintes é o resultado CORRETO, não sinal de bug.
  // `board_id = NULL` reusa o significado que a coluna já tem desde a
  // Fase 1 pra uma task criada sem board nenhum ("bookkeeping externo
  // puro, nunca candidata a auto-dispatch" — ver `TaskRow.board_id`'s
  // doc comment) — não um valor novo inventado. NÃO presume que o id
  // órfão é "1": qualquer `board_id` sem correspondência em `boards` é
  // pego, nunca um board que existe de verdade (ex.: 118/Idyplatform).
  db.exec(`
    UPDATE tasks SET board_id = NULL
    WHERE board_id IS NOT NULL AND board_id NOT IN (SELECT id FROM boards)
  `);

  // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — backfill: every board
  // that already has tasks gets an active sprint (if none), and every
  // task with a board but no sprint_id joins that sprint. Idempotent:
  // boards that already have an open sprint / tasks already assigned are
  // left alone. Done BEFORE prepared statements so the first list/get of
  // this process already sees membership.
  {
    const boardsWithTasks = db
      .prepare(`SELECT DISTINCT board_id FROM tasks WHERE board_id IS NOT NULL`)
      .all() as { board_id: string }[];
    const activeForBoard = db.prepare(
      `SELECT id FROM sprints WHERE board_id = ? AND closed_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    );
    const maxNumberStmt = db.prepare(`SELECT COALESCE(MAX(number), 0) AS m FROM sprints WHERE board_id = ?`);
    const insertSprint = db.prepare(`
      INSERT INTO sprints (id, board_id, number, name, started_at, closed_at, count_todo, count_doing, count_done, count_failed, migrated_in, migrated_out, snapshot_json)
      VALUES (@id, @board_id, @number, NULL, @started_at, NULL, 0, 0, 0, 0, 0, 0, NULL)
    `);
    const assignOrphans = db.prepare(
      `UPDATE tasks SET sprint_id = ? WHERE board_id = ? AND (sprint_id IS NULL OR sprint_id = '')`,
    );
    const now = Date.now();
    for (const { board_id } of boardsWithTasks) {
      let active = activeForBoard.get(board_id) as { id: string } | undefined;
      if (!active) {
        const id = randomUUID();
        const next = ((maxNumberStmt.get(board_id) as { m: number }).m ?? 0) + 1;
        insertSprint.run({ id, board_id, number: next, started_at: now });
        active = { id };
      }
      assignOrphans.run(active.id, board_id);
    }
  }

  // Used to auto-INSERT a "Board 1" here when none existed — that was
  // right back when the app always booted straight into a board (there
  // had to be one to load). DESIGN-BACKLOG.md item 8 changed that: the
  // app now boots to Home, and zero boards is a legitimate, intentional
  // first-run state (Home's own empty-state screen), not a gap to paper
  // over. `DEFAULT_BOARD_ID` itself stays — the cards/connectors schema
  // migration above still needs it as the fallback `board_id` for rows
  // that predate multi-board support.

  // Item 30 — `AND archived_at IS NULL`: an archived chat's row stays in
  // the table (its `messages_json` is the whole point), but must never
  // reappear as a live card on the board it used to live on.
  const listStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, effort, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE board_id = ? AND archived_at IS NULL",
  );
  // Used only by acbridge's `list` command (main/message-bus.ts) — that
  // protocol has no notion of boards, and restricting it to the caller's
  // own board would need the caller's board_id threaded through a wire
  // format that doesn't carry it today. Same "list every terminal card"
  // behavior this already had before boards existed. Archived chats
  // excluded here too — acbridge/MCP `list_cards` is about live, real
  // cards an agent could send/spawn to, not history.
  const listAllStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, effort, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE archived_at IS NULL",
  );
  // DESIGN-BACKLOG.md item 59 — a single card lookup, needed to find
  // which board a `spawn_agent` requester's card belongs to (so the
  // autonomous-mode check can be board-scoped, not global).
  const getCardStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, effort, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE id = ?",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, effort, system_prompt, group_id, label, updated_at, messages_json, archived_at)
    VALUES (@id, @board_id, @kind, @provider, @cwd, @x, @y, @w, @h, @resume_id, @model, @effort, @system_prompt, @group_id, @label, @updated_at, @messages_json, @archived_at)
    ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, kind = excluded.kind, provider = excluded.provider, cwd = excluded.cwd,
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      resume_id = excluded.resume_id, model = excluded.model, effort = excluded.effort, system_prompt = excluded.system_prompt,
      group_id = excluded.group_id, label = excluded.label,
      updated_at = excluded.updated_at, messages_json = excluded.messages_json, archived_at = excluded.archived_at
  `);
  const deleteStmt = db.prepare("DELETE FROM cards WHERE id = ?");
  const deleteCardsForBoardStmt = db.prepare("DELETE FROM cards WHERE board_id = ?");
  // RODADA 4 — ver o comentário grande de `deleteBoard` abaixo. Reatribui
  // (nunca apaga) as tasks do board deletado: "tasks são imortais por
  // design" (ReportRow's doc comment já registrava isso) e apagar
  // destruiria `task_transitions` junto, que é registro de auditoria.
  const reassignTasksForDeletedBoardStmt = db.prepare("UPDATE tasks SET board_id = NULL WHERE board_id = ?");
  // Item 30 — the sessions sidebar's data source: every chat-kind row,
  // archived or not (an open chat is still a legitimate "session" to
  // jump back to from the sidebar, not just closed ones), newest first.
  // Pre-release audit B9 — flagged as a possible omission because this
  // is the only one of the three `cards` queries here without an
  // `archived_at IS NULL` filter. Confirmed intentional, not a bug: the
  // sidebar's whole point is browsing history INCLUDING archived
  // sessions (ChatCard.tsx renders an "arquivada" badge and lets a click
  // re-open one via `unarchiveCard` right below) — filtering them out
  // here would make that feature unreachable.
  const listChatSessionsStmt = db.prepare(
    "SELECT id, board_id, kind, provider, cwd, x, y, w, h, resume_id, model, effort, system_prompt, group_id, label, updated_at, messages_json, archived_at FROM cards WHERE kind = 'chat' ORDER BY updated_at DESC",
  );
  const archiveCardStmt = db.prepare("UPDATE cards SET archived_at = ? WHERE id = ?");
  const unarchiveCardStmt = db.prepare("UPDATE cards SET archived_at = NULL WHERE id = ?");

  const listConnectorsStmt = db.prepare(
    "SELECT id, board_id, from_card_id, to_card_id, updated_at, kind, label FROM connectors WHERE board_id = ?",
  );
  // Item 58, roteiro peça 4 — same "no board scoping" convention as
  // `listAllStmt`/acbridge's `list`: an orchestrating agent reading the
  // DAG has no reason to know which board a connector lives on.
  const listAllConnectorsStmt = db.prepare(
    "SELECT id, board_id, from_card_id, to_card_id, updated_at, kind, label FROM connectors",
  );
  // Inbound `modified` only, highest `updated_at` wins — same selection
  // as `pickLatestDirectiveSender` (report-notify-routing.ts). Exposed
  // for callers that already hold a store handle and don't want to pull
  // the full connector list. Not a push router: nothing in message-bus
  // types or pops a notification off this query anymore.
  const findLatestDirectiveSenderStmt = db.prepare(`
    SELECT from_card_id FROM connectors
    WHERE to_card_id = ? AND kind = 'modified'
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const upsertConnectorStmt = db.prepare(`
    INSERT INTO connectors (id, board_id, from_card_id, to_card_id, updated_at, kind, label)
    VALUES (@id, @board_id, @from_card_id, @to_card_id, @updated_at, @kind, @label)
    ON CONFLICT(id) DO UPDATE SET
      board_id = excluded.board_id, from_card_id = excluded.from_card_id, to_card_id = excluded.to_card_id,
      updated_at = excluded.updated_at, kind = excluded.kind, label = excluded.label
  `);
  const deleteConnectorStmt = db.prepare("DELETE FROM connectors WHERE id = ?");
  const deleteConnectorsForCardStmt = db.prepare(
    "DELETE FROM connectors WHERE from_card_id = ? OR to_card_id = ?",
  );
  const deleteConnectorsForBoardStmt = db.prepare("DELETE FROM connectors WHERE board_id = ?");
  const setConnectorKindStmt = db.prepare("UPDATE connectors SET kind = ?, updated_at = ? WHERE id = ?");
  // Espelha setConnectorKindStmt acima — mesma forma (UPDATE + updated_at),
  // coluna diferente. Backs message-bus.ts's new `set_connector_label` cmd
  // (Parte 2 do pedido "label em tempo real" — 2026-09-09): sem isso, a
  // única forma de mudar `label` era recriar o conector inteiro.
  const setConnectorLabelStmt = db.prepare("UPDATE connectors SET label = ?, updated_at = ? WHERE id = ?");
  // Achado 2 (review adversarial, 2026-09-09) — `connector:label-changed`
  // (index.ts) needs to know which board a connector belongs to before
  // pushing, so a background board's label update doesn't reach the open
  // board's renderer at all (same `board_id === activeBoardId` filter
  // `listCards` already applies for reads, index.ts — this is that same
  // idea, applied at the one write path that pushes instead of waiting to
  // be polled).
  const getConnectorBoardIdStmt = db.prepare("SELECT board_id FROM connectors WHERE id = ?");

  const listBoardsStmt = db.prepare(
    "SELECT id, name, project, cwd, created_at, updated_at, last_accessed_at, autonomous, concurrency_cap FROM boards ORDER BY created_at ASC",
  );
  const getBoardStmt = db.prepare(
    "SELECT id, name, project, cwd, created_at, updated_at, last_accessed_at, autonomous, concurrency_cap FROM boards WHERE id = ?",
  );
  const upsertBoardStmt = db.prepare(`
    INSERT INTO boards (id, name, project, cwd, created_at, updated_at, last_accessed_at, autonomous, concurrency_cap)
    VALUES (@id, @name, @project, @cwd, @created_at, @updated_at, @last_accessed_at, @autonomous, @concurrency_cap)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, project = excluded.project, cwd = excluded.cwd,
      updated_at = excluded.updated_at, autonomous = excluded.autonomous, concurrency_cap = excluded.concurrency_cap
  `);
  const deleteBoardStmt = db.prepare("DELETE FROM boards WHERE id = ?");
  const touchBoardStmt = db.prepare("UPDATE boards SET last_accessed_at = ? WHERE id = ?");
  // DESIGN-BACKLOG.md item 59 — a dedicated single-purpose statement,
  // deliberately separate from the general `upsertBoard` a rename/cwd
  // edit already goes through: this is the one write path a human's
  // explicit toggle click uses, and only that path (see AGENTS.md's
  // architecture entry — no MCP/acbridge cmd ever calls it).
  const setBoardAutonomousStmt = db.prepare("UPDATE boards SET autonomous = ?, updated_at = ? WHERE id = ?");
  // DESIGN-BACKLOG.md item 60, peça 2 — same dedicated-statement pattern:
  // the input field next to the autonomous checkbox fires this directly,
  // not routed through the general board-edit save.
  const setBoardConcurrencyCapStmt = db.prepare("UPDATE boards SET concurrency_cap = ?, updated_at = ? WHERE id = ?");

  // Structural counts for the session-list popover (item 1). Both
  // "agents" and "active" exclude plain bash terminals (provider = 'bash')
  // — DESIGN-BACKLOG.md item 43: the topbar's own label is "N agente(s)",
  // and a bash card isn't an agent, so it must never inflate that count.
  // "active" is a STATIC proxy, not a live PTY signal: a non-loaded
  // board's processes aren't running at all (switching boards kills them,
  // see AGENTS.md), so there's no live state to report for anything but
  // the currently-open board — the best honest signal here is "structurally
  // a real agent card", identical to "agents" for a non-loaded board. The
  // renderer overrides this with real spawnError/exitCode-derived status
  // for whichever board is actually loaded (App.tsx's liveStatus).
  const cardCountsStmt = db.prepare(`
    SELECT board_id,
      SUM(CASE WHEN provider != 'bash' THEN 1 ELSE 0 END) as agents,
      SUM(CASE WHEN provider != 'bash' THEN 1 ELSE 0 END) as active
    FROM cards WHERE kind = 'terminal' GROUP BY board_id
  `);

  // Ids are a single global sequence across every board (a PTY id in the
  // main-process registry, and a connector's from/to reference, both need
  // to stay unique app-wide, not just within one board) — this seeds that
  // counter without fetching every board's full rows on boot.
  const maxIdStmt = db.prepare(`
    SELECT MAX(v) as m FROM (
      SELECT CAST(id AS INTEGER) as v FROM cards
      UNION ALL SELECT CAST(id AS INTEGER) FROM connectors
      UNION ALL SELECT CAST(id AS INTEGER) FROM boards
    )
  `);

  const TASK_COLUMNS = `id, prompt, provider, status, card_id, board_id, cwd, result_json, deps_json, purpose, retry_count, attempted_providers_json, max_retries, fallback_providers_json, "order", suggested_order, implicit_order, diverged_status, diverged_actor, requested_status, requested_reason, requested_by, requested_at, sprint_id, created_at, updated_at`;
  // DESIGN-BACKLOG.md §2.1 Decisão 8 — o choke point precisa do ÚLTIMO
  // ator de `kind:'status'` ANTES de gravar. Filtra `declaration` e
  // `prompt` de propósito: uma declaração estacionada ou um acréscimo de
  // briefing NÃO pode virar o last_actor, senão o lock humano se desfaz
  // na próxima escrita.
  const lastStatusActorStmt = db.prepare(
    `SELECT actor FROM task_transitions WHERE task_id = ? AND kind = 'status' ORDER BY at DESC, rowid DESC LIMIT 1`,
  );
  // RODADA 3 (DESIGN-BACKLOG.md §2.1, decisão 7 / peça 5 do recorte) —
  // contagem GLOBAL por board (todos os sprints). Alimenta o rodapé de
  // escopo em DOIS papéis só: (1) "N em outros boards" e (2) o dado
  // secundário rotulado "total N" do board ativo. NÃO é o número
  // principal do rodapé — esse é o sprint em foco (quadro vivo /
  // `snapshot_json` quando se vê um fechado). Contar `COUNT(*)` sem
  // filtro de sprint aqui é intencional pro "total"; reusar esse mapa
  // como "N tasks" do card Fila foi o bug de §0 (2026-09-12).
  // `WHERE board_id IS NOT NULL` — bookkeeping externo sem board não entra.
  const taskCountsByBoardStmt = db.prepare(`SELECT board_id, COUNT(*) as n FROM tasks WHERE board_id IS NOT NULL GROUP BY board_id`);
  // RODADA 3, peça 6 — gráfico 3 (tempo em cada estado), o único dos três
  // com fonte de dado real (`task_transitions` já grava `status`+`at`).
  // Fica atrás de um toggle escondido por padrão — carregado SÓ quando o
  // painel de gráficos é aberto (TaskCard.tsx), nunca junto do
  // `buildTaskBoard` que roda a cada push. Mesmo cuidado de N+1 que
  // `taskCardsForBoardStmt` já tem: um JOIN board inteiro, nunca um
  // `getTaskTransitions` por task. `kind = 'status'` — `'stage'` está no
  // tipo mas nenhum caminho escreve isso ainda (ver TaskTransitionRow's
  // doc comment).
  const transitionsForBoardStmt = db.prepare(`
    SELECT tt.task_id, tt.to_value, tt.at
    FROM task_transitions tt
    JOIN tasks t ON t.id = tt.task_id
    WHERE t.board_id = ? AND tt.kind = 'status'
    ORDER BY tt.task_id, tt.at ASC, tt.rowid ASC
  `);
  const listTasksStmt = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at ASC`);
  // DESIGN-BACKLOG.md §2.1, decisão 7 / item 6 — variante filtrada,
  // usando o mesmo `idx_tasks_board_id` que já existia sem nunca ser
  // consultado por coluna. `listTasksStmt` acima fica intocado: quem
  // chama sem board continua vendo exatamente o que via antes.
  const listTasksByBoardStmt = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? ORDER BY created_at ASC`);
  const getTaskStmt = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`);
  // `purpose` is on INSERT only. Omitting it from ON CONFLICT is the
  // immutability: a later upsert (update_task, drag, retry) cannot
  // relabel the proposal. Typo at create is a new task, not an edit —
  // see TaskRow.purpose.
  const upsertTaskStmt = db.prepare(`
    INSERT INTO tasks (id, prompt, provider, status, card_id, board_id, cwd, result_json, deps_json, purpose, retry_count, attempted_providers_json, max_retries, fallback_providers_json, "order", suggested_order, implicit_order, diverged_status, diverged_actor, requested_status, requested_reason, requested_by, requested_at, sprint_id, created_at, updated_at)
    VALUES (@id, @prompt, @provider, @status, @card_id, @board_id, @cwd, @result_json, @deps_json, @purpose, @retry_count, @attempted_providers_json, @max_retries, @fallback_providers_json, @order, @suggested_order, @implicit_order, @diverged_status, @diverged_actor, @requested_status, @requested_reason, @requested_by, @requested_at, @sprint_id, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      prompt = excluded.prompt, provider = excluded.provider, status = excluded.status,
      card_id = excluded.card_id, board_id = excluded.board_id, cwd = excluded.cwd, result_json = excluded.result_json, deps_json = excluded.deps_json,
      retry_count = excluded.retry_count, attempted_providers_json = excluded.attempted_providers_json,
      max_retries = excluded.max_retries, fallback_providers_json = excluded.fallback_providers_json,
      "order" = excluded."order", suggested_order = excluded.suggested_order, implicit_order = excluded.implicit_order,
      diverged_status = excluded.diverged_status, diverged_actor = excluded.diverged_actor,
      requested_status = excluded.requested_status, requested_reason = excluded.requested_reason,
      requested_by = excluded.requested_by, requested_at = excluded.requested_at,
      sprint_id = excluded.sprint_id, updated_at = excluded.updated_at
  `);
  // DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 — review adversarial (rodada 3,
  // achado 2). `applyColumnDrop` (mais abaixo) precisa gravar isto SEM
  // passar pelo `upsertTaskStmt` inteiro (que exigiria reconstruir a
  // linha inteira da vizinha só pra mudar 1 coluna, e re-avaliaria
  // `upsertTaskCardIfAbsentStmt` à toa) — um `UPDATE` pontual, sem tocar
  // `status`/`order`/`suggested_order`/nada mais. Nunca dispara transição
  // (`task_transitions` só grava mudança de `status`, e esta escrita
  // nunca muda status) — comportamento correto: `implicit_order` não é
  // uma decisão de ninguém, não tem o que auditar.
  const setImplicitOrderStmt = db.prepare(`UPDATE tasks SET implicit_order = @implicit_order, updated_at = @updated_at WHERE id = @id`);
  // Sprint membership migration on close — same posture as
  // setImplicitOrderStmt: dedicated UPDATE, never touches status, so
  // Decisão 8's human lock cannot block (and must not — migration is app
  // bookkeeping of which sprint owns the row, not a status write).
  const setTaskSprintStmt = db.prepare(`UPDATE tasks SET sprint_id = @sprint_id, updated_at = @updated_at WHERE id = @id`);
  // Third path — dedicated writer. Must NOT go through upsertTaskInternal:
  // that path decides status/divergence, and a request never touches either.
  const setStatusAskStmt = db.prepare(`
    UPDATE tasks
    SET requested_status = @requested_status, requested_reason = @requested_reason,
        requested_by = @requested_by, requested_at = @requested_at, updated_at = @updated_at
    WHERE id = @id
  `);

  const SPRINT_COLUMNS =
    `id, board_id, number, name, started_at, closed_at, count_todo, count_doing, count_done, count_failed, migrated_in, migrated_out, snapshot_json`;
  const getActiveSprintStmt = db.prepare(
    `SELECT ${SPRINT_COLUMNS} FROM sprints WHERE board_id = ? AND closed_at IS NULL ORDER BY started_at DESC LIMIT 1`,
  );
  const getSprintStmt = db.prepare(`SELECT ${SPRINT_COLUMNS} FROM sprints WHERE id = ?`);
  const listSprintsStmt = db.prepare(
    `SELECT ${SPRINT_COLUMNS} FROM sprints WHERE board_id = ? ORDER BY number DESC, started_at DESC`,
  );
  const maxSprintNumberStmt = db.prepare(`SELECT COALESCE(MAX(number), 0) AS m FROM sprints WHERE board_id = ?`);
  const insertSprintStmt = db.prepare(`
    INSERT INTO sprints (id, board_id, number, name, started_at, closed_at, count_todo, count_doing, count_done, count_failed, migrated_in, migrated_out, snapshot_json)
    VALUES (@id, @board_id, @number, @name, @started_at, @closed_at, @count_todo, @count_doing, @count_done, @count_failed, @migrated_in, @migrated_out, @snapshot_json)
  `);
  const freezeSprintStmt = db.prepare(`
    UPDATE sprints SET
      closed_at = @closed_at,
      count_todo = @count_todo,
      count_doing = @count_doing,
      count_done = @count_done,
      count_failed = @count_failed,
      migrated_out = @migrated_out,
      snapshot_json = @snapshot_json
    WHERE id = @id
  `);
  const renameSprintStmt = db.prepare(`UPDATE sprints SET name = ? WHERE id = ?`);
  /** Undo accidental open/close: clear freeze so the previous sprint is
   * live again. Snapshot + count_* are discarded — the board is live, not
   * a frozen history view. migrated_in is kept (how the sprint started). */
  const reopenSprintStmt = db.prepare(`
    UPDATE sprints SET
      closed_at = NULL,
      count_todo = 0,
      count_doing = 0,
      count_done = 0,
      count_failed = 0,
      migrated_out = 0,
      snapshot_json = NULL
    WHERE id = ?
  `);
  const deleteSprintRowStmt = db.prepare(`DELETE FROM sprints WHERE id = ?`);
  const previousClosedSprintStmt = db.prepare(
    `SELECT ${SPRINT_COLUMNS} FROM sprints
     WHERE board_id = ? AND id != ? AND closed_at IS NOT NULL
     ORDER BY number DESC, started_at DESC LIMIT 1`,
  );
  const tasksForSprintStmt = db.prepare(
    `SELECT id, prompt, status, result_json, "order", suggested_order, implicit_order, created_at, updated_at FROM tasks WHERE sprint_id = ?`,
  );
  const getBoardExistsStmt = db.prepare(`SELECT id FROM boards WHERE id = ?`);

  /** Ensure the board has exactly one open sprint. Creates one if missing.
   * Idempotent when an active sprint already exists. */
  function ensureActiveSprintInternal(boardId: string, at: number, migratedIn = 0): SprintRow {
    const existing = getActiveSprintStmt.get(boardId) as SprintRow | undefined;
    if (existing) return existing;
    const nextNumber = ((maxSprintNumberStmt.get(boardId) as { m: number }).m ?? 0) + 1;
    const row: SprintRow = {
      id: randomUUID(),
      board_id: boardId,
      number: nextNumber,
      name: null,
      started_at: at,
      closed_at: null,
      count_todo: 0,
      count_doing: 0,
      count_done: 0,
      count_failed: 0,
      migrated_in: migratedIn,
      migrated_out: 0,
      snapshot_json: null,
    };
    insertSprintStmt.run(row);
    return row;
  }

  /**
   * Close the active sprint: freeze snapshot counts + board JSON, migrate
   * unfinished todo/doing via setTaskSprintStmt (NOT upsertTask — status
   * lock must not block membership), open the next sprint with migrated_in.
   *
   * Product answer 3: empty queue and already-closed are REFUSED with a
   * visible reason — never silent no-op / never invent an empty boundary.
   */
  const closeSprintInternal = db.transaction((boardId: string, at: number): { closed: SprintRow; opened: SprintRow } => {
    const active = getActiveSprintStmt.get(boardId) as SprintRow | undefined;
    if (!active) {
      throw Object.assign(new Error(`no active sprint on board "${boardId}" — already closed or never opened`), {
        code: "sprint_already_closed",
      });
    }
    const members = tasksForSprintStmt.all(active.id) as {
      id: string;
      prompt: string | null;
      status: string;
      result_json: string | null;
      order: number | null;
      suggested_order: number | null;
      implicit_order: number | null;
      created_at: number;
      updated_at: number;
    }[];
    if (members.length === 0) {
      throw Object.assign(new Error(`sprint ${active.number} is empty — add tasks before closing`), {
        code: "sprint_empty",
      });
    }
    const decision = decideSprintClose(
      members.map((m) => ({
        id: m.id,
        status: m.status,
      })),
    );
    const snapshot: SprintSnapshotTask[] = members.map((m) => ({
      id: m.id,
      prompt: m.prompt,
      status: m.status,
      order: m.order,
      suggested_order: m.suggested_order,
      implicit_order: m.implicit_order,
      created_at: m.created_at,
      updated_at: m.updated_at,
    }));
    const snapshotJson = JSON.stringify(snapshot);
    freezeSprintStmt.run({
      id: active.id,
      closed_at: at,
      count_todo: decision.countTodo,
      count_doing: decision.countDoing,
      count_done: decision.countDone,
      count_failed: decision.countFailed,
      migrated_out: decision.migratedOut,
      snapshot_json: snapshotJson,
    });
    const opened: SprintRow = {
      id: randomUUID(),
      board_id: boardId,
      number: active.number + 1,
      name: null,
      started_at: at,
      closed_at: null,
      count_todo: 0,
      count_doing: 0,
      count_done: 0,
      count_failed: 0,
      migrated_in: decision.migratedOut,
      migrated_out: 0,
      snapshot_json: null,
    };
    // If a higher number already exists (rare race / renumber), bump.
    const maxExisting = (maxSprintNumberStmt.get(boardId) as { m: number }).m ?? 0;
    if (opened.number <= maxExisting) opened.number = maxExisting + 1;
    insertSprintStmt.run(opened);
    for (const id of decision.migrateIds) {
      setTaskSprintStmt.run({ id, sprint_id: opened.id, updated_at: at });
    }
    const closed: SprintRow = {
      ...active,
      closed_at: at,
      count_todo: decision.countTodo,
      count_doing: decision.countDoing,
      count_done: decision.countDone,
      count_failed: decision.countFailed,
      migrated_out: decision.migratedOut,
      snapshot_json: snapshotJson,
    };
    return { closed, opened };
  });

  /**
   * DESIGN-BACKLOG.md §2.0 item 2 — delete recovers from an accidental
   * open/close. Only the ACTIVE sprint may be deleted (closed rows keep
   * frozen history). Tasks move to the previous closed sprint, which is
   * reopened (snapshot discarded — live board again). No previous + still
   * has tasks → refuse. No previous + empty → just delete the row.
   */
  const deleteSprintInternal = db.transaction(
    (
      sprintId: string,
      at: number,
    ): { deleted: SprintRow; restored: SprintRow | null; movedTaskCount: number } => {
      const target = getSprintStmt.get(sprintId) as SprintRow | undefined;
      if (!target) {
        throw Object.assign(new Error(`no such sprint "${sprintId}"`), { code: "sprint_missing" });
      }
      if (target.closed_at != null) {
        throw Object.assign(
          new Error(`sprint ${target.number} is closed — frozen history cannot be deleted`),
          { code: "sprint_closed" },
        );
      }
      const members = tasksForSprintStmt.all(target.id) as { id: string }[];
      const previous = previousClosedSprintStmt.get(target.board_id, target.id) as SprintRow | undefined;
      if (!previous) {
        if (members.length > 0) {
          throw Object.assign(
            new Error(`cannot delete the only sprint while it still has ${members.length} task(s)`),
            { code: "sprint_only_with_tasks" },
          );
        }
        deleteSprintRowStmt.run(target.id);
        return { deleted: target, restored: null, movedTaskCount: 0 };
      }
      for (const m of members) {
        setTaskSprintStmt.run({ id: m.id, sprint_id: previous.id, updated_at: at });
      }
      reopenSprintStmt.run(previous.id);
      deleteSprintRowStmt.run(target.id);
      const restored = getSprintStmt.get(previous.id) as SprintRow;
      return { deleted: target, restored, movedTaskCount: members.length };
    },
  );

  /** Corpo de `upsertTask` (ver seu comentário grande na definição do
   * método, mais abaixo) extraído pra função nomeada — `applyColumnDrop`
   * (peça 3, review adversarial rodada 3) precisa chamar EXATAMENTE a
   * mesma lógica (grava a task arrastada + a transição de status, se
   * houve) de DENTRO de uma `db.transaction`, sem duplicar o corpo.
   *
   * DESIGN-BACKLOG.md §2.1 Decisão 8 — AQUI mora o algoritmo de
   * precedência (`decideStatusWrite`): consulta o last_actor de
   * `kind:'status'` ANTES de gravar. Retorna a decisão pra o chamador
   * (message-bus / persistTask) poder avisar o agente e empurrar o
   * sinal no quadro — a decisão em si nunca depende do chamador lembrar. */
  function upsertTaskInternal(task: TaskRow): StatusWriteDecision {
    const {
      actor,
      statusProposed,
      transitions: _transitions,
      cards: _cards,
      verdicts: _verdicts,
      ...rest
    } = task;
    const existing = getTaskStmt.get(task.id) as TaskRow | undefined;
    const newActor = actor ?? "agent";
    const previousActor = existing
      ? ((lastStatusActorStmt.get(task.id) as { actor: TaskActor } | undefined)?.actor ?? null)
      : null;
    // `statusProposed !== false` — absent/true means the status on the
    // row is intentional (create, drag, markFailed, explicit update_task
    // status). Only an explicit `false` (update_task omitting status)
    // becomes `proposedStatus: null` for the decision.
    const decision = decideStatusWrite({
      previousActor,
      previousStatus: existing ? existing.status : null,
      proposedStatus: statusProposed === false ? null : task.status,
      newActor,
      existingDivergedStatus: existing?.diverged_status ?? null,
      existingDivergedActor: existing?.diverged_actor ?? null,
    });
    // Sprint membership: assign to the board's active sprint when the
    // caller left sprint_id empty (create paths, legacy rows). Never
    // steals an explicit sprint_id. Does NOT go through status
    // precedence — membership ≠ status.
    //
    // Product answer 1 (failed NÃO migra): when a task LEAVES `failed`
    // (human drag back to "a fazer", or any resume), it joins the
    // CURRENT active sprint — the closed sprint's frozen counts stay put.
    let sprintId = rest.sprint_id ?? existing?.sprint_id ?? null;
    const boardId = rest.board_id ?? existing?.board_id ?? null;
    const previousStatus = existing ? existing.status : null;
    const leavingFailed = previousStatus === "failed" && decision.status !== "failed";
    if (leavingFailed && boardId) {
      sprintId = ensureActiveSprintInternal(boardId, Date.now()).id;
    } else if (!sprintId && boardId) {
      sprintId = ensureActiveSprintInternal(boardId, Date.now()).id;
    }
    const retained = retainStatusAsk({
      existing: {
        requestedStatus: existing?.requested_status ?? null,
        requestedReason: existing?.requested_reason ?? null,
        requestedBy: existing?.requested_by ?? null,
        requestedAt: existing?.requested_at ?? null,
      },
      newActor,
      proposedStatus: statusProposed === false ? null : task.status,
      resultingStatus: decision.status,
    });
    const ask = retained.ask;
    const persistable = {
      ...rest,
      // Create: accept a valid enum or persist NULL (NORMAL). Update:
      // keep whatever the row already has — ON CONFLICT also omits
      // `purpose`, so this is belt-and-suspenders against a caller
      // stuffing a new label into the object.
      purpose: existing ? (existing.purpose ?? null) : normalizeTaskPurpose(rest.purpose),
      status: decision.status,
      diverged_status: decision.divergedStatus,
      diverged_actor: decision.divergedActor,
      requested_status: ask.requestedStatus,
      requested_reason: ask.requestedReason,
      requested_by: ask.requestedBy,
      requested_at: ask.requestedAt,
      sprint_id: sprintId,
    };
    upsertTaskStmt.run(persistable);
    const at = Date.now();
    if (decision.statusChanged) {
      insertTransitionStmt.run({
        id: randomUUID(),
        task_id: task.id,
        kind: "status",
        from_value: existing ? existing.status : null,
        to_value: decision.status,
        actor: newActor,
        card_id: task.card_id,
        at,
      });
    }
    if (decision.recordDeclaration && existing && decision.declaredStatus) {
      insertTransitionStmt.run({
        id: randomUUID(),
        task_id: task.id,
        kind: "declaration",
        from_value: existing.status,
        to_value: decision.declaredStatus,
        actor: newActor,
        card_id: task.card_id,
        at,
      });
    }
    // Ask closed because this write made the requested status true —
    // not a human Allow (that is kind:status). Without this row the
    // ask would just vanish from the live columns with no trail.
    if (retained.resolvedBy === "applied-ask" && existing?.requested_status) {
      insertTransitionStmt.run({
        id: randomUUID(),
        task_id: task.id,
        kind: "request_resolved",
        from_value: existing.requested_status,
        to_value: decision.status,
        actor: newActor,
        card_id: task.card_id,
        at,
      });
    }
    // Prompt write is information, not noise — same choke point as
    // status/declaration, so no caller has to remember to log it.
    // Create (`!existing`) is the original statement, not a change.
    // `to_value` is NOT NULL; a cleared prompt persists as "".
    if (existing && existing.prompt !== persistable.prompt) {
      insertTransitionStmt.run({
        id: randomUUID(),
        task_id: task.id,
        kind: "prompt",
        from_value: existing.prompt,
        to_value: persistable.prompt ?? "",
        actor: newActor,
        card_id: task.card_id,
        at,
      });
    }
    if (task.card_id) {
      upsertTaskCardIfAbsentStmt.run({ task_id: task.id, card_id: task.card_id, role: "implementer" });
    }
    return decision;
  }

  /** DESIGN-BACKLOG.md §2.1 Fase 2, peça 3 — review adversarial (rodada 3,
   * achado 2, BAIXO-MÉDIO): o lote de um drop (a task arrastada + o
   * `implicit_order` materializado das vizinhas que precisaram virar
   * comparáveis, ver o comentário grande de `TaskRow.implicit_order`)
   * precisa ser ATÔMICO — sem isso, um crash no meio deixa o quadro com
   * ordens relativas parcialmente aplicadas (a arrastada já com `order`
   * novo, só ALGUMAS vizinhas com `implicit_order`, o resto ainda
   * `Infinity`). `db.transaction` (better-sqlite3, síncrono) garante
   * tudo-ou-nada. O chamador (main/index.ts's `persistColumnDrop`) faz UM
   * push só depois desta função retornar, não um por linha — resolve
   * também o "barulhento" do mesmo achado.
   *
   * Devolve a MESMA `StatusWriteDecision` que `upsertTask` devolve pra
   * arrastada (2026-09-13): até então o retorno era descartado, e um drag
   * pra "concluído" era um `done` que ninguém observava — os dependentes
   * da task arrastada ficavam `pending` pra sempre (a 312d4c0a foi o caso
   * medido). O funil (`task-write-funnel.ts`) lê `statusChanged`/`status`
   * daqui exatamente como lê de `upsertTask`. */
  const applyColumnDrop = db.transaction(
    (dragged: TaskRow, siblingImplicitOrders: { id: string; implicitOrder: number }[]): StatusWriteDecision => {
      const decision = upsertTaskInternal(dragged);
      for (const s of siblingImplicitOrders) {
        setImplicitOrderStmt.run({ id: s.id, implicit_order: s.implicitOrder, updated_at: dragged.updated_at });
      }
      return decision;
    },
  );

  // DESIGN-BACKLOG.md §2.1 "Log de transição" — `id` gerado aqui
  // (randomUUID), nunca pelo chamador. `ORDER BY at ASC, rowid ASC`: `at`
  // é `Date.now()` e duas transições da MESMA task podem cair no mesmo
  // milissegundo (ex.: onTaskDone grava duas linhas em sequência muito
  // rápida) — `rowid` (implícito, a tabela não é WITHOUT ROWID) desempata
  // pela ordem real de inserção, sem precisar de uma segunda coluna só
  // pra isso.
  const insertTransitionStmt = db.prepare(`
    INSERT INTO task_transitions (id, task_id, kind, from_value, to_value, actor, card_id, at)
    VALUES (@id, @task_id, @kind, @from_value, @to_value, @actor, @card_id, @at)
  `);
  const getTaskTransitionsStmt = db.prepare(
    "SELECT id, task_id, kind, from_value, to_value, actor, card_id, at FROM task_transitions WHERE task_id = ? ORDER BY at ASC, rowid ASC",
  );

  // DESIGN-BACKLOG.md §2.1 "Vínculo task ↔ vários cards com papel" —
  // `upsertTaskCardIfAbsent` é o que `upsertTask` chama a cada linha nova
  // de `card_id` (nunca sobrescreve um papel já decidido, por design:
  // "implementer" é só o palpite padrão pro card que a coluna singular já
  // apontava). `linkTaskCard` é o upsert de verdade (sobrescreve role),
  // pra atribuir um papel explícito como "reviewer". Quem chama
  // (2026-09-13): `spawn_agent({taskId, role})` e `link_task_card`, os
  // dois no message-bus.ts, via o callback `linkTaskCard` (index.ts, que
  // também empurra a Fila). Até então o primitivo existia sem chamador e
  // a coluna era 91/91 implementer.
  const upsertTaskCardIfAbsentStmt = db.prepare(`
    INSERT INTO task_cards (task_id, card_id, role)
    VALUES (@task_id, @card_id, @role)
    ON CONFLICT(task_id, card_id) DO NOTHING
  `);
  const linkTaskCardStmt = db.prepare(`
    INSERT INTO task_cards (task_id, card_id, role)
    VALUES (@task_id, @card_id, @role)
    ON CONFLICT(task_id, card_id) DO UPDATE SET role = excluded.role
  `);
  const listTaskCardsStmt = db.prepare("SELECT task_id, card_id, role FROM task_cards WHERE task_id = ?");
  // "Histórico de veredito por participação" — o outro lado da mesma
  // junção: `recordParticipationRound` (abaixo) recebe só um `cardId` (é
  // tudo que o choke point tem à mão — `report`/`resolveCardExit` falam
  // de UM card saindo/reportando, nunca de uma task específica) e
  // precisa achar EM QUAIS tasks/papéis esse card participa agora pra
  // saber onde apendar a rodada. Um card normal só aparece numa linha
  // (o caso comum, 1 card = 1 task ativa); o schema não impede mais de
  // uma, então o fan-out cobre isso sem assumir cardinalidade.
  const listTaskCardsForCardStmt = db.prepare("SELECT task_id, card_id, role FROM task_cards WHERE card_id = ?");

  // Ver o comentário grande de `TaskVerdictRow` acima pro modelo
  // completo. `ORDER BY at ASC, rowid ASC` — mesmo desempate de
  // `getTaskTransitionsStmt` (duas rodadas podem cair no mesmo `at`
  // quando o fan-out grava mais de uma linha na MESMA chamada).
  const insertTaskVerdictStmt = db.prepare(`
    INSERT INTO task_verdicts (id, task_id, card_id, role, verdict, at)
    VALUES (@id, @task_id, @card_id, @role, @verdict, @at)
  `);
  const getTaskVerdictsStmt = db.prepare(
    "SELECT id, task_id, card_id, role, verdict, at FROM task_verdicts WHERE task_id = ? ORDER BY at ASC, rowid ASC",
  );

  /** DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" — o
   * ÚNICO ponto que escreve em `task_verdicts`. Chamado de dois lugares,
   * os dois já são choke points existentes (nenhum terceiro caminho
   * escreve verdict hoje, ver o comentário grande de `TaskVerdictRow`):
   * (1) `message-bus.ts`'s `cmd === "report"`, logo depois de
   *     `upsertReport` — toda vez que QUALQUER card reporta (com ou sem
   *     `verdict`), essa é uma rodada de participação terminando.
   * (2) `resolveCardExit`'s ramo "Sinal 2" (saída sem NUNCA ter
   *     chamado `report`) — a mesma rodada termina, sem veredito
   *     nenhum (`verdict: null`), pela causa oposta.
   *
   * Fan-out: um `cardId` pode participar de mais de uma task ao mesmo
   * tempo (schema de `task_cards` permite); `db.transaction` garante
   * que, se o card estiver em N tasks, ou as N linhas entram todas ou
   * nenhuma — mesma garantia de atomicidade que `applyColumnDrop` já
   * tem, mesmo motivo (um crash no meio não pode deixar a rodada
   * registrada em ALGUMAS tasks e não noutras). Card sem NENHUMA linha
   * em `task_cards` (nunca esteve vinculado a task nenhuma): 0 linhas
   * lidas, 0 gravadas — não há rodada de participação nenhuma pra
   * fechar, silêncio correto, não bug. */
  const recordParticipationRound = db.transaction((cardId: string, verdict: string | null, at: number): TaskVerdictRow[] => {
    const links = listTaskCardsForCardStmt.all(cardId) as TaskCardRow[];
    const written: TaskVerdictRow[] = [];
    for (const link of links) {
      const row: TaskVerdictRow = { id: randomUUID(), task_id: link.task_id, card_id: cardId, role: link.role, verdict, at };
      insertTaskVerdictStmt.run(row);
      written.push(row);
    }
    return written;
  });

  // DESIGN-BACKLOG.md §2.1 Fase 2, peça 4 — anatomia da task no quadro
  // precisa, POR BOARD (nunca por task individual — o mesmo N+1 que a
  // Fase 1 já rejeitou pro `list_tasks` sem `boardId`, ver o comentário de
  // `listTasksByBoardStmt` acima): (1) o ATOR da última transição de
  // status, pro selo auto/agente/você; (2) os cards vinculados com papel,
  // pros chips. Cada uma é UMA consulta pro board inteiro, nunca um loop
  // chamando `getTask` por task — `getTask` continua existindo só pra
  // leitura pontual (MCP `get_task`), intocado.
  const lastActorsForBoardStmt = db.prepare(`
    SELECT t.id as task_id,
      (SELECT tt.actor FROM task_transitions tt WHERE tt.task_id = t.id AND tt.kind = 'status' ORDER BY tt.at DESC, tt.rowid DESC LIMIT 1) as last_actor
    FROM tasks t WHERE t.board_id = ?
  `);
  // LEFT JOIN cards (não JOIN) — o chip de card do quadro (peça 4) quer o
  // glyph metálico do provider e o label sem depender do card estar VIVO
  // no renderer agora: a verdade mora em `cards` mesmo pra um card já
  // fechado (só `deleteCard`, nunca disparado por fechar um card comum,
  // apaga a linha — ver `CardRow.archived_at`'s doc comment). `LEFT` pra
  // nunca sumir com o vínculo task↔card só porque o card raro que FOI
  // deletado de verdade não existe mais.
  const taskCardsForBoardStmt = db.prepare(`
    SELECT tc.task_id, tc.card_id, tc.role, c.kind as card_kind, c.provider as card_provider, c.label as card_label
    FROM task_cards tc
    JOIN tasks t ON t.id = tc.task_id
    LEFT JOIN cards c ON c.id = tc.card_id
    WHERE t.board_id = ?
  `);
  // Relatório mais recente do card PRINCIPAL de cada task (`tasks.card_id`)
  // — etapa implementar/review e barra de proposta de conclusão (decisões
  // 3 e 9). Com append-only, restringe ao MAX(seq) por card para o JOIN
  // não duplicar linha por task (o Map em index.ts também cairia no
  // último, mas a query não deve devolver N linhas por card).
  const reportsForBoardStmt = db.prepare(`
    SELECT r.card_id, r.seq, r.report_json, r.verdict, r.role, r.updated_at FROM reports r
    JOIN tasks t ON t.card_id = r.card_id
    WHERE t.board_id = ?
      AND r.seq = (SELECT MAX(r2.seq) FROM reports r2 WHERE r2.card_id = r.card_id)
  `);

  // RODADA 4 — histórico de veredito por board (pílulas + gráficos 1/2).
  // LEFT JOIN cards pro provider (mesmo motivo de taskCardsForBoardStmt:
  // card fechado/deletado não pode apagar a rodada). Ordenado por task +
  // at — o chamador agrupa em JS sem reordenar.
  const verdictsForBoardStmt = db.prepare(`
    SELECT tv.task_id, tv.card_id, tv.role, tv.verdict, tv.at, c.provider as card_provider
    FROM task_verdicts tv
    JOIN tasks t ON t.id = tv.task_id
    LEFT JOIN cards c ON c.id = tv.card_id
    WHERE t.board_id = ?
    ORDER BY tv.task_id, tv.at ASC, tv.rowid ASC
  `);

  // Ator da PRIMEIRA transição de status — distingue task criada por
  // humano (UI) de task criada por agente, sem coluna nova. Filtra
  // `declaration` pelo mesmo motivo de lastStatusActorStmt.
  const firstActorsForBoardStmt = db.prepare(`
    SELECT t.id as task_id,
      (SELECT tt.actor FROM task_transitions tt WHERE tt.task_id = t.id AND tt.kind = 'status' ORDER BY tt.at ASC, tt.rowid ASC LIMIT 1) as first_actor
    FROM tasks t WHERE t.board_id = ?
  `);

  // Sem afterSeq: o mais recente do card (contrato de sempre de
  // `read_report`). Com afterSeq: o PRÓXIMO (menor seq > afterSeq) —
  // caminha o histórico append-only sem pular rodadas.
  const getLatestReportStmt = db.prepare(
    "SELECT card_id, seq, report_json, verdict, role, updated_at FROM reports WHERE card_id = ? ORDER BY seq DESC LIMIT 1",
  );
  const getReportAfterStmt = db.prepare(
    "SELECT card_id, seq, report_json, verdict, role, updated_at FROM reports WHERE card_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1",
  );
  // Append-only — INSERT puro. O nome `upsertReport` permanece porque é o
  // choke point já wired em message-bus/index; a semântica de conflito
  // (slot) foi a causa do bug.
  const upsertReportStmt = db.prepare(`
    INSERT INTO reports (card_id, seq, report_json, verdict, role, updated_at)
    VALUES (@card_id, @seq, @report_json, @verdict, @role, @updated_at)
  `);
  // A `seq` monotônica (message-bus.ts) precisa sobreviver ao restart
  // junto com os relatórios — senão o `afterSeq` do `read_report` passa a
  // MENTIR (relatório antigo com seq alta, novo com seq baixa depois de um
  // reinício, consumidor pula o novo). `nextReportSeqSeed` devolve de onde
  // continuar contando; `0` numa tabela vazia (nunca houve relatório) faz
  // o primeiro `++reportSeqCounter` do bus começar em 1, igual ao
  // contador em memória de sempre. Mesmo padrão de `nextIdSeed` acima,
  // outra coluna.
  const nextReportSeqStmt = db.prepare("SELECT MAX(seq) as m FROM reports");
  // Ver o comentário grande de `ReportRow`/`MAX_STORED_REPORTS` — mantém
  // só as `cap` linhas de `seq` mais alta (qualquer card), descarta o
  // resto. Subquery aninhada: SQLite recusa DELETE da mesma tabela que o
  // SELECT com ORDER BY/LIMIT direto referencia.
  const pruneReportsStmt = db.prepare(
    "DELETE FROM reports WHERE seq NOT IN (SELECT seq FROM (SELECT seq FROM reports ORDER BY seq DESC LIMIT ?))",
  );

  const listFavoritesStmt = db.prepare("SELECT url, title, created_at FROM browser_favorites ORDER BY created_at DESC");
  const addFavoriteStmt = db.prepare(`
    INSERT INTO browser_favorites (url, title, created_at)
    VALUES (@url, @title, @created_at)
    ON CONFLICT(url) DO UPDATE SET title = excluded.title
  `);
  const removeFavoriteStmt = db.prepare("DELETE FROM browser_favorites WHERE url = ?");

  return {
    listCards: (boardId: string): CardRow[] => listStmt.all(boardId) as CardRow[],
    listAllCards: (): CardRow[] => listAllStmt.all() as CardRow[],
    // `messages_json` defaulted defensively — better-sqlite3's named-param
    // binding throws if a bound `@column` is simply absent as an object
    // key (not just `undefined`/`null`), and this IPC channel is a public
    // contract callers besides App.tsx's own `toRow` legitimately use
    // directly (every non-chat card kind, and every pre-Fase-C caller,
    // never had a reason to know this key exists at all) — a caller that
    // doesn't set it shouldn't crash the whole card save over an optional
    // field only "chat" kind cards ever populate.
    upsertCard: (card: CardRow) => upsertStmt.run({ ...card, messages_json: card.messages_json ?? null, archived_at: card.archived_at ?? null }),
    deleteCard: (id: string) => deleteStmt.run(id),
    listChatSessions: (): CardRow[] => listChatSessionsStmt.all() as CardRow[],
    archiveCard: (id: string, at: number) => archiveCardStmt.run(at, id),
    unarchiveCard: (id: string) => unarchiveCardStmt.run(id),
    listConnectors: (boardId: string): ConnectorRow[] => listConnectorsStmt.all(boardId) as ConnectorRow[],
    listAllConnectors: (): ConnectorRow[] => listAllConnectorsStmt.all() as ConnectorRow[],
    /** Most recent `send_to_card` auto-connect into `toCardId`, or null.
     * Same rule as `pickLatestDirectiveSender` — see stmt comment above. */
    findLatestDirectiveSender: (toCardId: string): string | null => {
      const row = findLatestDirectiveSenderStmt.get(toCardId) as { from_card_id: string } | undefined;
      return row?.from_card_id ?? null;
    },
    upsertConnector: (row: ConnectorRow) => upsertConnectorStmt.run({ ...row, kind: row.kind ?? null, label: row.label ?? null }),
    deleteConnector: (id: string) => deleteConnectorStmt.run(id),
    /** Returns whether a row actually existed to update. */
    setConnectorKind: (id: string, kind: string | null): boolean => setConnectorKindStmt.run(kind, Date.now(), id).changes > 0,
    /** Returns whether a row actually existed to update — same contract as setConnectorKind. */
    setConnectorLabel: (id: string, label: string | null): boolean => setConnectorLabelStmt.run(label, Date.now(), id).changes > 0,
    getConnectorBoardId: (id: string): string | undefined => (getConnectorBoardIdStmt.get(id) as { board_id: string } | undefined)?.board_id,
    deleteConnectorsForCard: (cardId: string) => deleteConnectorsForCardStmt.run(cardId, cardId),
    // `autonomous` is stored as SQLite's usual 0/1 INTEGER (no native
    // boolean type) — converted to/from a real `boolean` here so nothing
    // downstream (MCP JSON responses included) ever sees a raw 0/1.
    listBoards: (): BoardRow[] => (listBoardsStmt.all() as Array<Omit<BoardRow, "autonomous"> & { autonomous: number }>).map((b) => ({ ...b, autonomous: !!b.autonomous })),
    getBoard: (id: string): BoardRow | undefined => {
      const row = getBoardStmt.get(id) as (Omit<BoardRow, "autonomous"> & { autonomous: number }) | undefined;
      return row ? { ...row, autonomous: !!row.autonomous } : undefined;
    },
    upsertBoard: (board: BoardRow) => upsertBoardStmt.run({ ...board, autonomous: board.autonomous ? 1 : 0, concurrency_cap: board.concurrency_cap ?? null }),
    touchBoard: (id: string, at: number) => touchBoardStmt.run(at, id),
    setBoardAutonomous: (id: string, autonomous: boolean) => setBoardAutonomousStmt.run(autonomous ? 1 : 0, Date.now(), id),
    setBoardConcurrencyCap: (id: string, cap: number | null) => setBoardConcurrencyCapStmt.run(cap, Date.now(), id),
    getCard: (id: string): CardRow | undefined => getCardStmt.get(id) as CardRow | undefined,
    cardCounts: (): Record<string, BoardCounts> => {
      const rows = cardCountsStmt.all() as { board_id: string; agents: number; active: number }[];
      return Object.fromEntries(rows.map((r) => [r.board_id, { agents: r.agents, active: r.active }]));
    },
    /** RODADA 4 (DESIGN-BACKLOG.md §2.3, diagnóstico do board órfão) —
     * antes desta rodada, isto deletava conectores e cards do board e a
     * linha do board, sem tocar em `tasks` — escrito antes de
     * `tasks.board_id` sequer existir, nunca revisitado depois. Uma task
     * cujo board acabava de sumir ficava presa a um `board_id` que
     * nenhuma linha de `boards` mais tinha, PRA SEMPRE (não existe
     * `deleteTask`). `reassignTasksForDeletedBoardStmt` fecha essa
     * classe agora: `board_id = NULL` reusa o significado que a coluna
     * já tem pra "task sem board" (bookkeeping puro, nunca candidata a
     * auto-dispatch), nunca invés de apagar a task — apagar destruiria
     * `task_transitions` (registro de auditoria) junto, e contradiria
     * "tasks são imortais por design". Ordem: reatribui ANTES de apagar
     * a linha do board (a query de `reassignTasksForDeletedBoardStmt`
     * não depende da linha existir, mas a leitura fica mais natural
     * "salva o que precisa sobreviver, depois derruba o resto"). */
    deleteBoard: (id: string) => {
      deleteConnectorsForBoardStmt.run(id);
      deleteCardsForBoardStmt.run(id);
      reassignTasksForDeletedBoardStmt.run(id);
      deleteBoardStmt.run(id);
    },
    nextIdSeed: (): number => (maxIdStmt.get() as { m: number | null }).m ?? 0,
    listTasks: (): TaskRow[] => listTasksStmt.all() as TaskRow[],
    // Board-wide totals (every sprint). Footer uses this for "outros boards"
    // + labeled "total N" only — never as the primary sprint count. See
    // `taskCountsByBoardStmt` comment above.
    taskCountsByBoard: (): Record<string, number> => {
      const rows = taskCountsByBoardStmt.all() as { board_id: string; n: number }[];
      return Object.fromEntries(rows.map((r) => [r.board_id, r.n]));
    },
    // Ver o comentário grande de `transitionsForBoardStmt` acima.
    listStatusTransitionsForBoard: (boardId: string): { task_id: string; to_value: string; at: number }[] =>
      transitionsForBoardStmt.all(boardId) as { task_id: string; to_value: string; at: number }[],
    // DESIGN-BACKLOG.md §2.1 item 6 — ver TASK_COLUMNS/listTasksByBoardStmt
    // acima. Wired (2026-09-10) through index.ts's `listTasksByBoard`
    // callback into message-bus.ts's `list_tasks` cmd, which now uses this
    // instead of filtering `listTasks()` in JS when `boardId` is given.
    listTasksByBoard: (boardId: string): TaskRow[] => listTasksByBoardStmt.all(boardId) as TaskRow[],
    // DESIGN-BACKLOG.md §2.1 "no get_task, por exemplo" — `getTask` (e só
    // ele, nunca `listTasks`/`listTasksByBoard`, pra manter a listagem em
    // massa barata) anexa a trilha completa e os cards vinculados como
    // campos extra, transientes, no objeto retornado. Funciona sem tocar
    // em index.ts porque `getTask` já é repassado por referência de volta
    // pro chamador (mesma técnica de `upsertTask.actor` abaixo, na
    // direção oposta: aqui é o RETORNO que carona, lá é a ENTRADA).
    getTask: (id: string): TaskRow | undefined => {
      const row = getTaskStmt.get(id) as TaskRow | undefined;
      if (!row) return undefined;
      return {
        ...row,
        transitions: getTaskTransitionsStmt.all(id) as TaskTransitionRow[],
        cards: listTaskCardsStmt.all(id) as TaskCardRow[],
        verdicts: getTaskVerdictsStmt.all(id) as TaskVerdictRow[],
      };
    },
    // Ver o comentário grande de `getTaskStatusStmt` acima.
    // RODADA 3 (review adversarial da rodada 2, achado A, alto) — a versão
    // anterior (`getTaskStatus`, um id por chamada) era chamada dentro de
    // um laço por dependência de CADA task do board em `buildTaskBoard`
    // (main/index.ts), a cada `notifyTaskChanged` — o MESMO N+1 que a
    // Fase 1 já rejeitou pro `list_tasks` sem `boardId`
    // (`listLastActorsForBoard` é a prova de que "uma consulta por board"
    // é sempre possível aqui). Uma única consulta `IN (...)` resolve TODAS
    // as dependências referenciadas pelo board de uma vez — `buildTaskBoard`
    // agora chama isto UMA vez por push, não uma vez por dependência.
    // `ids.length === 0` sai antes do SQL: um board sem nenhuma task com
    // `deps_json` não deveria gerar `WHERE id IN ()` (SQLite aceita, mas é
    // trabalho e round-trip à toa pro caso mais comum). Não é um
    // `db.prepare` cacheado como todo outro statement deste arquivo — o
    // número de `?` varia por chamada (uma IN de tamanho fixo não serve
    // aqui), e isto roda no máximo uma vez por push, não em um hot path.
    getTaskStatusesByIds: (ids: string[]): Record<string, string> => {
      if (ids.length === 0) return {};
      const placeholders = ids.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`).all(...ids) as { id: string; status: string }[];
      return Object.fromEntries(rows.map((r) => [r.id, r.status]));
    },
    /** Same one-shot `IN` as `getTaskStatusesByIds` — `buildTaskBoard`
     * needs dep purposes to derive `investigação → implementação` without
     * an N+1. Values are normalized; unknown/absent purpose stays `null`. */
    getTaskPurposesByIds: (ids: string[]): Record<string, string | null> => {
      if (ids.length === 0) return {};
      const placeholders = ids.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, purpose FROM tasks WHERE id IN (${placeholders})`).all(...ids) as {
        id: string;
        purpose: string | null;
      }[];
      return Object.fromEntries(rows.map((r) => [r.id, normalizeTaskPurpose(r.purpose)]));
    },
    /** DESIGN-BACKLOG.md §2.1 "QUEM ESCREVE — o ponto mais importante
     * desta fase". A transição é gravada AQUI, comparando com a linha que
     * já existe, nunca numa função separada que um chamador precisa
     * lembrar de invocar — é exatamente o esquecimento que perdeu duas
     * tasks desta sessão que este choke point existe pra fechar.
     *
     * `actor` chega pela própria `task` (campo `actor?`, transiente, ver
     * o comentário grande de `TaskRow` acima), NUNCA adivinhado aqui
     * dentro por heurística (código de saída, card vivo, etc. — isso é
     * literalmente a "narrativa" que a decisão do dono do repo veta pro
     * MCP, e adivinhar no store seria a mesma armadilha um nível abaixo).
     * A ÚNICA razão de ser um campo do objeto, e não um segundo parâmetro
     * posicional: `index.ts` (travado por outro agente nesta sessão) só
     * repassa `task` por referência pra `store.upsertTask(task)` — um
     * segundo argumento JS ali seria descartado em silêncio. Um campo
     * dentro do MESMO objeto que já atravessa essa fronteira funciona sem
     * mexer em index.ts. Ausente = "agent" (toda chamada de
     * create_task/update_task hoje é MCP, isto é, um agente). */
    upsertTask: (task: TaskRow): StatusWriteDecision => upsertTaskInternal(task),
    /**
     * Park or clear a status ask without touching `status` / `diverged_*`.
     * `ask === null` is a human deny (or an explicit cancel). Latest ask
     * wins — one pending request per task.
     */
    setStatusAsk: (
      taskId: string,
      ask: { status: string; reason: string | null; requesterId: string | null; at: number } | null,
    ): { ok: true } | { ok: false; error: string } => {
      const existing = getTaskStmt.get(taskId) as TaskRow | undefined;
      if (!existing) return { ok: false, error: `no such task "${taskId}"` };
      const at = ask?.at ?? Date.now();
      const previousRequested = existing.requested_status ?? null;
      setStatusAskStmt.run({
        id: taskId,
        requested_status: ask?.status ?? null,
        requested_reason: ask?.reason ?? null,
        requested_by: ask?.requesterId ?? null,
        requested_at: ask?.at ?? null,
        updated_at: at,
      });
      if (ask) {
        insertTransitionStmt.run({
          id: randomUUID(),
          task_id: taskId,
          kind: "request",
          from_value: existing.status,
          to_value: ask.status,
          actor: "agent",
          card_id: ask.requesterId,
          at,
        });
      } else if (previousRequested) {
        insertTransitionStmt.run({
          id: randomUUID(),
          task_id: taskId,
          kind: "request_denied",
          from_value: existing.status,
          to_value: previousRequested,
          actor: "human",
          card_id: existing.requested_by ?? null,
          at,
        });
      }
      return { ok: true };
    },
    // Ver o comentário grande de `applyColumnDrop` acima (definida antes
    // do `return`, junto dos prepared statements) — exposta aqui como
    // método do store, mesma convenção de todo o resto deste objeto.
    applyColumnDrop: (dragged: TaskRow, siblingImplicitOrders: { id: string; implicitOrder: number }[]): StatusWriteDecision =>
      applyColumnDrop(dragged, siblingImplicitOrders),
    getTaskTransitions: (taskId: string): TaskTransitionRow[] => getTaskTransitionsStmt.all(taskId) as TaskTransitionRow[],
    getTaskCards: (taskId: string): TaskCardRow[] => listTaskCardsStmt.all(taskId) as TaskCardRow[],
    /** Same current-link view as `getTaskCards`, from the card side. The
     * message bus uses this only to distinguish a secondary task card with a
     * real participation link from an unrelated support card before asking
     * `recordParticipationRound` to close the round. */
    listTaskCardsForCard: (cardId: string): TaskCardRow[] => listTaskCardsForCardStmt.all(cardId) as TaskCardRow[],
    linkTaskCard: (taskId: string, cardId: string, role: string) => linkTaskCardStmt.run({ task_id: taskId, card_id: cardId, role }),
    // Ver o comentário grande de `recordParticipationRound` acima
    // (definida antes do `return`, junto dos prepared statements) —
    // exposta aqui como método do store, mesma convenção de
    // `applyColumnDrop` logo acima dela.
    recordParticipationRound: (cardId: string, verdict: string | null, at: number): TaskVerdictRow[] =>
      recordParticipationRound(cardId, verdict, at),
    getTaskVerdicts: (taskId: string): TaskVerdictRow[] => getTaskVerdictsStmt.all(taskId) as TaskVerdictRow[],
    // DESIGN-BACKLOG.md §2.1 Fase 2, peça 4 — ver o comentário grande dos
    // três `Stmt` acima. `last_actor` é `null` tanto pra uma task sem
    // NENHUMA transição gravada (predata `task_transitions`) quanto pra
    // qualquer valor que a subquery correlacionada não encontrou — os dois
    // casos são "sem selo ainda", nunca um palpite.
    listLastActorsForBoard: (boardId: string): { task_id: string; last_actor: TaskActor | null }[] =>
      lastActorsForBoardStmt.all(boardId) as { task_id: string; last_actor: TaskActor | null }[],
    listTaskCardsForBoard: (
      boardId: string,
    ): (TaskCardRow & { card_kind: string | null; card_provider: string | null; card_label: string | null })[] =>
      taskCardsForBoardStmt.all(boardId) as (TaskCardRow & {
        card_kind: string | null;
        card_provider: string | null;
        card_label: string | null;
      })[],
    listReportsForBoard: (boardId: string): ReportRow[] => reportsForBoardStmt.all(boardId) as ReportRow[],
    /** RODADA 4 — vereditos do board inteiro (uma consulta), com provider
     * do card pra o gráfico 1. Mesmo padrão de `listStatusTransitionsForBoard`. */
    listVerdictsForBoard: (
      boardId: string,
    ): { task_id: string; card_id: string; role: string; verdict: string | null; at: number; card_provider: string | null }[] =>
      verdictsForBoardStmt.all(boardId) as {
        task_id: string;
        card_id: string;
        role: string;
        verdict: string | null;
        at: number;
        card_provider: string | null;
      }[],
    /** Ator da 1ª transição `kind:'status'` — `human` ⇒ criada pela UI. */
    listFirstActorsForBoard: (boardId: string): { task_id: string; first_actor: TaskActor | null }[] =>
      firstActorsForBoardStmt.all(boardId) as { task_id: string; first_actor: TaskActor | null }[],
    getReport: (cardId: string, afterSeq?: number): ReportRow | undefined =>
      (afterSeq === undefined
        ? getLatestReportStmt.get(cardId)
        : getReportAfterStmt.get(cardId, afterSeq)) as ReportRow | undefined,
    upsertReport: (row: ReportRow) => {
      upsertReportStmt.run({ ...row, verdict: row.verdict ?? null, role: row.role ?? null });
      pruneReportsStmt.run(MAX_STORED_REPORTS);
    },
    nextReportSeqSeed: (): number => (nextReportSeqStmt.get() as { m: number | null }).m ?? 0,
    // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — open/close never by
    // calendar. Snapshot is frozen inside closeSprintInternal; listSprints
    // returns the frozen rows as stored (closed) plus the live open row.
    getActiveSprint: (boardId: string): SprintRow | undefined => getActiveSprintStmt.get(boardId) as SprintRow | undefined,
    getSprint: (sprintId: string): SprintRow | undefined => getSprintStmt.get(sprintId) as SprintRow | undefined,
    listSprints: (boardId: string): SprintRow[] => listSprintsStmt.all(boardId) as SprintRow[],
    /** Parse frozen board for a closed sprint. Null while open / missing. */
    getSprintSnapshot: (sprintId: string): SprintSnapshotTask[] | null => {
      const row = getSprintStmt.get(sprintId) as SprintRow | undefined;
      if (!row?.snapshot_json) return null;
      try {
        const parsed = JSON.parse(row.snapshot_json) as SprintSnapshotTask[];
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    /** Create an active sprint if the board has none. No-op (returns the
     * existing row) when one is already open. */
    openSprint: (boardId: string): { ok: true; sprint: SprintRow } | { ok: false; error: string } => {
      if (!getBoardExistsStmt.get(boardId)) return { ok: false, error: `no such board "${boardId}"` };
      return { ok: true, sprint: ensureActiveSprintInternal(boardId, Date.now()) };
    },
    /** Freeze the active sprint's snapshot, migrate unfinished todo/doing,
     * open the next. Refuses empty queue and already-closed (no active). */
    closeSprint: (boardId: string): { ok: true; closed: SprintRow; opened: SprintRow } | { ok: false; error: string } => {
      if (!getBoardExistsStmt.get(boardId)) return { ok: false, error: `no such board "${boardId}"` };
      try {
        const result = closeSprintInternal(boardId, Date.now());
        return { ok: true, ...result };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
    /** Optional rename surface (identity is still `number`). Empty/null clears to "Sprint N". */
    renameSprint: (sprintId: string, name: string | null): { ok: true; sprint: SprintRow } | { ok: false; error: string } => {
      const existing = getSprintStmt.get(sprintId) as SprintRow | undefined;
      if (!existing) return { ok: false, error: `no such sprint "${sprintId}"` };
      const trimmed = name === null ? null : name.trim() || null;
      renameSprintStmt.run(trimmed, sprintId);
      return { ok: true, sprint: { ...existing, name: trimmed } };
    },
    /** Delete the active sprint: move its tasks to the previous closed
     * sprint and reopen that previous (DESIGN-BACKLOG.md §2.0 item 2).
     * Closed sprints refuse — history stays frozen. */
    deleteSprint: (
      sprintId: string,
    ):
      | { ok: true; deleted: SprintRow; restored: SprintRow | null; movedTaskCount: number }
      | { ok: false; error: string } => {
      try {
        return { ok: true, ...deleteSprintInternal(sprintId, Date.now()) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
    listFavorites: (): FavoriteRow[] => listFavoritesStmt.all() as FavoriteRow[],
    addFavorite: (url: string, title: string) => addFavoriteStmt.run({ url, title, created_at: Date.now() }),
    removeFavorite: (url: string) => removeFavoriteStmt.run(url),
    close: () => db.close(),
  };
}

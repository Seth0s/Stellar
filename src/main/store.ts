import Database from "better-sqlite3";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
   * this app ever dispatches off it. */
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
  result_json: string | null;
  deps_json: string | null;
  /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 5 — started
   * as bare bookkeeping for an external orchestrator's own retry loop;
   * item 60 peça 4 added a REAL internal auto-retry on top, but only
   * inside an autonomous board (`board_id` set + `isBoardAutonomous`) —
   * outside that, still pure bookkeeping, unchanged. `retry_count` and
   * `attempted_providers_json` (JSON array, in order tried) exist either
   * way, so an external orchestrator that doesn't opt into autonomous
   * mode keeps working exactly as before. */
  retry_count: number;
  attempted_providers_json: string | null;
  /** DESIGN-BACKLOG.md item 60, peça 4 — set once at `create_task`,
   * never changed after. `null` means "use the app-wide default"
   * (`DEFAULT_MAX_RETRIES` in message-bus.ts), same convention as
   * `boards.concurrency_cap`. Auto-retry (peça 4) stops once
   * `retry_count` reaches this — the task stays `failed` for good,
   * no infinite retry loop. */
  max_retries: number | null;
  /** DESIGN-BACKLOG.md item 60, peça 4 follow-up — reassignment on
   * retry, the multi-provider thesis the audit actually argued for
   * (item 60's first pass only retried the SAME provider every time,
   * flagged live by a reviewing agent as not really delivering on that
   * thesis). Set once at `create_task`, in the order to try — never
   * guessed by the app itself, since "what's an acceptable substitute
   * provider" is domain-specific, not something to hardcode. `null`/
   * empty means "keep retrying the original provider", the old
   * behavior, unchanged when this is omitted. */
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
  /** Transiente, só de LEITURA — anexado só por `getTask` (nunca por
   * `listTasks`, de propósito: manter a listagem em massa barata).
   * DESIGN-BACKLOG.md §2.1 "MCP: exponha a trilha em LEITURA (no
   * get_task, por exemplo)". `upsertTask` ignora este campo mesmo que
   * esteja presente no objeto passado — nunca persistido. */
  transitions?: TaskTransitionRow[];
  /** Transiente, só de LEITURA — mesmo motivo/anexação que `transitions`
   * acima. */
  cards?: TaskCardRow[];
};

/** `actor` de `task_transitions` — quem causou a transição. "app" é o
 * próprio motor (onTaskDone/retryOrFail/card saindo sem reportar,
 * message-bus.ts), "agent" é uma chamada de create_task/update_task via
 * MCP, "human" é reservado pra Fase 2 (arrastar a mão no board). */
export type TaskActor = "app" | "agent" | "human";

/** DESIGN-BACKLOG.md §2.1 "Log de transição (`task_transitions`)" —
 * desenhada e aprovada em separado da tabela `tasks`. `kind` distingue
 * `status` (o que esta fase efetivamente grava, de dentro de
 * `upsertTask`) de `stage` (reservado pra quando o modelo ganhar um
 * conceito de etapa/review — ver DESIGN-BACKLOG decisão 3, "review é
 * etapa, não coluna" — nada aqui inventa essa coluna agora). Guardado
 * pra sempre, podado só junto com a task (nenhuma função de deleteTask
 * existe ainda neste código — nada a podar por enquanto). Nunca
 * inventar histórico sintético pra tasks que já existiam antes desta
 * tabela: a trilha delas começa vazia, de propósito (decisão explícita
 * do dono do repo — pareceria dado real e sujaria os gráficos futuros). */
export type TaskTransitionRow = {
  id: string;
  task_id: string;
  kind: "status" | "stage";
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
 * trocar de papel é um upsert, não uma segunda linha. */
export type TaskCardRow = { task_id: string; card_id: string; role: string };

/** DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" — achado ao
 * vivo (2026-09-09, sessão real): um card de review chamou `report`, saiu
 * com código 0, o bus respondeu `reported` — e o relatório sumiu. Causa:
 * `cardReports` (message-bus.ts) era um `Map` puro em memória, apagado em
 * TODO restart (update, crash, relogin, `quitAndInstall`), de TODOS os
 * cards, não só o que disparou o achado. `card_id` é a PRIMARY KEY (não um
 * id próprio da tabela) de propósito — preserva exatamente a semântica que
 * já existia no `Map`: um relatório novo do MESMO card SOBRESCREVE o
 * anterior, nunca acumula por card (um reviewer que reporta 4 rodadas do
 * mesmo diff tem sempre 1 linha, não 4).
 *
 * Ciclo de vida — decidido e o que foi DESCARTADO:
 * - Histórico por card (guardar as 4 rodadas em vez de só a última):
 *   DESCARTADO — nada no protocolo (`read_report`) pede histórico, só "o
 *   último" ou "o próximo mais novo que X" (`afterSeq`); guardaria linhas
 *   sem nenhum consumidor.
 * - Cascade delete ao fechar/deletar o card: DESCARTADO — fechar um card
 *   hoje já é independente da entrega do relatório (o `Map` em memória já
 *   sobrevivia ao card fechar NA MESMA sessão, só não a um restart do
 *   processo); o padrão real é "spawna, espera o relatório, fecha o card,
 *   segue trabalhando" — apagar o relatório junto destruiria exatamente o
 *   caso que esta tabela existe pra resolver.
 * - TTL por tempo (relatório "expira" depois de N dias): DESCARTADO —
 *   decidir que um relatório "não importa mais" é uma garantia forte que
 *   este código não tem informação pra fazer; um board pode ficar dias sem
 *   ser reaberto e o relatório de um card já fechado continua sendo
 *   exatamente o resultado que um orquestrador foi buscar.
 * - Limite de TAMANHO por relatório: DESCARTADO — os relatórios reais desta
 *   sessão têm alguns KB, SQLite lida bem com uma coluna TEXT de MBs, e
 *   truncar/rejeitar destruiria dado real — a mesma classe de bug ao
 *   contrário do que esta tabela existe pra consertar.
 * - Limite de CONTAGEM total (`MAX_STORED_REPORTS` abaixo): MANTIDO — a
 *   única fonte de crescimento sem fim aqui é `card_id` novo a cada spawn
 *   (contador global de ids), então um corte por contagem — descartando só
 *   os relatórios mais ANTIGOS quando o total passa do cap — é o jeito de
 *   nunca crescer pra sempre sem inventar uma regra de "relevância" que
 *   ninguém pediu. Roda a cada `upsertReport` (`pruneReports` abaixo).
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
 * em `upsertCard`. */
export type ReportRow = { card_id: string; seq: number; report_json: string; verdict?: string | null; updated_at: number };

// Ver o comentário grande de `ReportRow` acima — cap de contagem total,
// não por card (que já é 1:1 por construção). Generoso o bastante pra
// nunca disparar em uso normal (um relatório de alguns KB * 1000 ainda é
// só alguns MB, trivial pro SQLite) e existir só como rede de segurança
// contra crescimento sem fim ao longo de meses/anos de uso real.
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
  try {
    db.exec(`ALTER TABLE reports ADD COLUMN verdict TEXT`);
  } catch (e) {
    if (!String(e).includes("duplicate column name")) throw e;
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

  // Ver o comentário grande de `ReportRow` acima pro ciclo de vida
  // completo. `card_id` como PRIMARY KEY (não um id de linha próprio) é o
  // que dá o slot único por card — `upsertReport` abaixo faz
  // INSERT ... ON CONFLICT(card_id) DO UPDATE, nunca acumula linha por
  // relatório.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      card_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      verdict TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

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
    CREATE INDEX IF NOT EXISTS idx_reports_seq ON reports(seq);
    CREATE INDEX IF NOT EXISTS idx_tt_task ON task_transitions(task_id, at);
    CREATE INDEX IF NOT EXISTS idx_task_cards_task ON task_cards(task_id);
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

  const TASK_COLUMNS = `id, prompt, provider, status, card_id, board_id, result_json, deps_json, retry_count, attempted_providers_json, max_retries, fallback_providers_json, "order", suggested_order, created_at, updated_at`;
  const listTasksStmt = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at ASC`);
  // DESIGN-BACKLOG.md §2.1, decisão 7 / item 6 — variante filtrada,
  // usando o mesmo `idx_tasks_board_id` que já existia sem nunca ser
  // consultado por coluna. `listTasksStmt` acima fica intocado: quem
  // chama sem board continua vendo exatamente o que via antes.
  const listTasksByBoardStmt = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? ORDER BY created_at ASC`);
  const getTaskStmt = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`);
  const upsertTaskStmt = db.prepare(`
    INSERT INTO tasks (id, prompt, provider, status, card_id, board_id, result_json, deps_json, retry_count, attempted_providers_json, max_retries, fallback_providers_json, "order", suggested_order, created_at, updated_at)
    VALUES (@id, @prompt, @provider, @status, @card_id, @board_id, @result_json, @deps_json, @retry_count, @attempted_providers_json, @max_retries, @fallback_providers_json, @order, @suggested_order, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      prompt = excluded.prompt, provider = excluded.provider, status = excluded.status,
      card_id = excluded.card_id, board_id = excluded.board_id, result_json = excluded.result_json, deps_json = excluded.deps_json,
      retry_count = excluded.retry_count, attempted_providers_json = excluded.attempted_providers_json,
      max_retries = excluded.max_retries, fallback_providers_json = excluded.fallback_providers_json,
      "order" = excluded."order", suggested_order = excluded.suggested_order, updated_at = excluded.updated_at
  `);

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
  // pra atribuir um papel explícito como "reviewer" — sem tool de MCP
  // ainda nesta fase (ver relatório final), mas o primitivo do store já
  // existe e está coberto por teste.
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

  const getReportStmt = db.prepare("SELECT card_id, seq, report_json, verdict, updated_at FROM reports WHERE card_id = ?");
  const upsertReportStmt = db.prepare(`
    INSERT INTO reports (card_id, seq, report_json, verdict, updated_at)
    VALUES (@card_id, @seq, @report_json, @verdict, @updated_at)
    ON CONFLICT(card_id) DO UPDATE SET
      seq = excluded.seq, report_json = excluded.report_json, verdict = excluded.verdict, updated_at = excluded.updated_at
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
  // Ver o comentário grande de `ReportRow`/`MAX_STORED_REPORTS` no topo do
  // arquivo — roda a cada `upsertReport`, mantém só os `cap` relatórios de
  // `seq` mais alta (os mais recentes, de qualquer card), descarta o
  // resto.
  const pruneReportsStmt = db.prepare(
    "DELETE FROM reports WHERE card_id NOT IN (SELECT card_id FROM reports ORDER BY seq DESC LIMIT ?)",
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
    deleteBoard: (id: string) => {
      deleteConnectorsForBoardStmt.run(id);
      deleteCardsForBoardStmt.run(id);
      deleteBoardStmt.run(id);
    },
    nextIdSeed: (): number => (maxIdStmt.get() as { m: number | null }).m ?? 0,
    listTasks: (): TaskRow[] => listTasksStmt.all() as TaskRow[],
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
      };
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
    upsertTask: (task: TaskRow) => {
      const { actor, transitions: _transitions, cards: _cards, ...persistable } = task;
      const existing = getTaskStmt.get(task.id) as TaskRow | undefined;
      upsertTaskStmt.run(persistable);
      if (!existing || existing.status !== task.status) {
        insertTransitionStmt.run({
          id: randomUUID(),
          task_id: task.id,
          kind: "status",
          from_value: existing ? existing.status : null,
          to_value: task.status,
          actor: actor ?? "agent",
          card_id: task.card_id,
          at: Date.now(),
        });
      }
      // DESIGN-BACKLOG.md §2.1 item 4 — mantém `task_cards` alinhada com
      // `card_id` pra toda task tocada por `upsertTask` daqui em diante
      // (não só o backfill de migração acima, que só cobre o que já
      // existia ANTES desta coluna). `IfAbsent`: nunca sobrescreve um
      // papel já decidido pra este par (task, card) — só preenche o
      // palpite óbvio quando ainda não há nenhum.
      if (task.card_id) {
        upsertTaskCardIfAbsentStmt.run({ task_id: task.id, card_id: task.card_id, role: "implementer" });
      }
    },
    getTaskTransitions: (taskId: string): TaskTransitionRow[] => getTaskTransitionsStmt.all(taskId) as TaskTransitionRow[],
    getTaskCards: (taskId: string): TaskCardRow[] => listTaskCardsStmt.all(taskId) as TaskCardRow[],
    linkTaskCard: (taskId: string, cardId: string, role: string) => linkTaskCardStmt.run({ task_id: taskId, card_id: cardId, role }),
    getReport: (cardId: string): ReportRow | undefined => getReportStmt.get(cardId) as ReportRow | undefined,
    upsertReport: (row: ReportRow) => {
      upsertReportStmt.run({ ...row, verdict: row.verdict ?? null });
      pruneReportsStmt.run(MAX_STORED_REPORTS);
    },
    nextReportSeqSeed: (): number => (nextReportSeqStmt.get() as { m: number | null }).m ?? 0,
    listFavorites: (): FavoriteRow[] => listFavoritesStmt.all() as FavoriteRow[],
    addFavorite: (url: string, title: string) => addFavoriteStmt.run({ url, title, created_at: Date.now() }),
    removeFavorite: (url: string) => removeFavoriteStmt.run(url),
    close: () => db.close(),
  };
}

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod";
import { STICKY_COLORS, type BusRequest, type BusResponse } from "./message-bus";

/**
 * DESIGN-BACKLOG.md item 21, ponto 9 — the primary agent-facing interface,
 * replacing (for providers that speak MCP — claude, codex; see
 * providers.ts) the ad-hoc `ACBRIDGE_HINT` system-prompt string that was
 * stale and only ever reached one of three vendors. Every tool here is a
 * thin wrapper around `message-bus.ts`'s shared `handleRequest` — the
 * SAME dispatcher `acbridge` talks to over its unix socket, so a consent
 * flow or capability written once serves both frontends. See
 * providers.ts's `buildArgs` for how each spawned provider gets pointed
 * at this server (an ephemeral `--mcp-config`/`-c mcp_servers...` spawn
 * flag, never a written project config file).
 *
 * Stateless HTTP mode (`sessionIdGenerator: undefined`, per the SDK's own
 * documented pattern for exactly this shape of server): every POST /mcp
 * gets a fresh `McpServer`+transport pair, handles that one request, and
 * closes. No session to track, no server-initiated notifications needed —
 * every tool here is a plain call-and-respond, same as an acbridge command.
 * Plain `http.createServer`, no Express — `transport.handleRequest`
 * accepts Node's own `IncomingMessage`/`ServerResponse` directly, matching
 * this project's existing style (remote-server.ts).
 */
export function createMcpServer(opts: { port: number; handleRequest: (req: BusRequest) => Promise<BusResponse> }) {
  /**
   * Achado ao vivo (2026-09-01): "o modo automático não funciona de fato".
   * A causa não estava no modo autônomo — estava aqui. Este servidor é UM
   * só, num endereço só, compartilhado por todos os cards; a identidade do
   * chamador vinha exclusivamente de um parâmetro `callerCardId` que o
   * PRÓPRIO modelo tinha que lembrar de preencher, e que estava declarado
   * `.optional()` em `spawn_agent`/`spawn_card`/`open_url`. Quando o modelo
   * omitia (o caso comum — parâmetro opcional cuja utilidade não é óbvia
   * pra quem está chamando), `message-bus.ts` fazia
   * `getCardBoardId("")` → `undefined` → `autonomous = false`, e o board
   * inteiro caía de volta no modal de consentimento mesmo com o modo
   * autônomo ligado. O mesmo buraco silenciava o rótulo de remetente do
   * `send_to_card` (item 61) e zerava a profundidade de spawn (audit S4).
   *
   * `pty-registry.ts` já sabe o id do card no momento do spawn e já injeta
   * `AGENT_CANVAS_CARD_ID` no ambiente — passa a carimbar o mesmo id na URL
   * do MCP que registra pra aquele processo (`/mcp?card=<id>`), então a
   * identidade chega por transporte, não por boa vontade do modelo.
   * `callerCardId` continua aceito e tem precedência (um agente que
   * legitimamente fala em nome de outro card não perde nada), e uma URL sem
   * `?card=` — o smoke test que disca a porta direto, um cliente MCP
   * externo — se comporta exatamente como antes.
   */
  /** Pedido ao vivo (2026-09-02): "toda nova sessão eu preciso dizer o
   * agente está na infraestrutura do stellar... acho que além de dizer no
   * system prompt (que só alguns providers têm — ver ACBRIDGE_HINT em
   * providers.ts, `--append-system-prompt` só existe pro `claude`),
   * devemos usar outra técnica". Esta é: `ServerOptions.instructions`,
   * campo do protocolo MCP devolvido na resposta de `initialize` — todo
   * cliente MCP que o suporta mostra isso ao modelo automaticamente ao
   * CONECTAR no servidor, sem depender de flag de provider nenhuma
   * (funciona igual pra claude/codex/cursor/antigravity, não só quem tem
   * `--append-system-prompt`). Complementa, não substitui, o
   * `ACBRIDGE_HINT`: aquele cobre o fallback `acbridge` (não-MCP) e o
   * caso raro de um cliente MCP que ignora `instructions`; este cobre
   * todo o resto, na fonte certa (protocolo), não um hack de prompt.
   */
  const SERVER_INSTRUCTIONS =
    "You're inside Stellar, a multi-agent spatial canvas — a shared board of cards " +
    "(terminals, browsers, sticky notes, file explorers, and possibly other agents) " +
    "that a human, and maybe other agents, are looking at right now. Call list_cards " +
    "first to see what's already on the board; every tool below targets a card id or " +
    "label from there. Reading a card is free and needs no approval; spawning a new " +
    "card or opening a URL asks the human first (unless the board is in autonomous " +
    "mode). Any tool that modifies an EXISTING card you don't own (write_sticky, " +
    "send_to_card, set_sticky_color/set_sticky_mode, browser_click/type/scroll/eval, " +
    "spawn_agent/spawn_card, open_url) automatically draws a connector between your " +
    "own card and that one — your influence on the board stays visible without you " +
    "drawing it yourself. If another card spawned you to do a task, call report with " +
    "a structured result when you finish it, even if you keep running afterward.";

  /** Repetido em toda tool que precisa de identidade pra auto-conector
   * (2026-09-02) sem também precisar de consentimento — as que já tinham
   * esse campo por outro motivo (send_to_card, spawn_agent, spawn_card,
   * open_url) mantêm a própria descrição, mais específica ao que cada
   * uma faz com o id. */
  const CALLER_CARD_ID_FIELD = z
    .string()
    .optional()
    .describe(
      "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process, and uses that to draw the auto-connector to the card you're acting on.",
    );

  function buildServer(urlCardId?: string): McpServer {
    /** `callerCardId` explícito ganha do carimbo da URL; string vazia conta
     * como ausente (um modelo que preenche `""` não está se identificando). */
    const caller = (explicit?: string) => (explicit && explicit.trim() ? explicit : urlCardId);
    const server = new McpServer({ name: "stellar", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });

    server.registerTool(
      "list_cards",
      {
        description:
          "List every open card on the board — terminals AND non-terminal cards (browser, sticky, files, changes, media, chat, remote-window). Each entry has id, kind, label (the name a human gave the card in its header, null if unnamed), provider (terminal/chat only), cwd (a real path only for terminal/chat/files/changes), and url (browser cards). Anywhere a tool takes a `target`, you can pass either the id or the card's label.",
        inputSchema: {},
      },
      async () => {
        const res = await opts.handleRequest({ cmd: "list" });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "send_to_card",
      {
        description: "Type a message into another open terminal card, followed by Enter — same as typing it yourself into that card.",
        inputSchema: {
          target: z.string().describe("The target card's id or label (see list_cards)"),
          text: z.string().describe("The text to type"),
          callerCardId: z
            .string()
            .optional()
            .describe(
              "Your own card id (AGENT_CANVAS_CARD_ID env var) — when given, the delivered text is prefixed with a human-friendly sender label so the reader knows who it's from (DESIGN-BACKLOG.md item 61). Ignored for a bash target (would break the command).",
            ),
        },
      },
      async ({ target, text, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "send", target, text, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "read_card",
      {
        description:
          "Read a terminal card's live scrollback as plain text — what's actually on screen (and above it), not a screenshot. Use this to check on a card you spawned or sent a message to.",
        inputSchema: {
          target: z.string().describe("The target card's id or label (see list_cards)"),
          lines: z.number().optional().describe("Only the last N lines of scrollback — omit for the full buffer"),
        },
      },
      async ({ target, lines }) => {
        const res = await opts.handleRequest({ cmd: "read_card", target, lines });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    // Achado ao vivo (2026-09-01): "o send_to_card só escreve em card de
    // terminal — sticky é editável só por você (SEM LEITURA TAMBEM)", que
    // é por que um quadro de trabalho vivo acabava num arquivo .md em vez
    // do board. Tools próprias, não uma extensão de send_to_card/read_card:
    // não existe Enter pra dar nem scrollback pra paginar numa nota, e
    // sobrecarregar aqueles nomes só produziria erro de uso.
    server.registerTool(
      "read_sticky",
      {
        description:
          "Read a sticky note's text. Sticky notes are the board's own scratch surface — a live checklist or status board a human and an agent can both see. Use list_cards to find them (kind: \"sticky\").",
        inputSchema: { target: z.string().describe("The sticky card's id or label (see list_cards)") },
      },
      async ({ target }) => {
        const res = await opts.handleRequest({ cmd: "read_sticky", target });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "write_sticky",
      {
        description:
          "Write a sticky note's text — no human approval needed, this is board content, not a disk/process side effect. Refused while a human has that note focused for editing, so it can never overwrite what someone is typing; retry after. Returns the note's resulting content. A connector automatically links your own card to this note (no duplicate on repeated writes to the same note).",
        inputSchema: {
          target: z.string().describe("The sticky card's id or label (see list_cards)"),
          content: z.string().describe("The text to write"),
          mode: z
            .enum(["replace", "append"])
            .optional()
            .describe("replace (default) swaps the whole note; append adds to the end — prefer append for a running log so a human's own lines survive"),
          callerCardId: z
            .string()
            .optional()
            .describe(
              "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process, and uses that to draw the auto-connector to this note.",
            ),
        },
      },
      async ({ target, content, mode, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "write_sticky", target, content, mode, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "set_sticky_color",
      {
        description:
          "Set a sticky note's color, which doubles as its category on the board (yellow = note, green = done, blue = in progress, pink = bug) — see list_cards. No human approval needed, purely visual board state. A connector automatically links your own card to this note.",
        inputSchema: {
          target: z.string().describe("The sticky card's id or label (see list_cards)"),
          color: z.enum(STICKY_COLORS).describe("yellow = note, green = done, blue = in progress, pink = bug"),
          callerCardId: z
            .string()
            .optional()
            .describe(
              "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process, and uses that to draw the auto-connector to this note.",
            ),
        },
      },
      async ({ target, color, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "set_sticky_color", target, color, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "set_sticky_mode",
      {
        description:
          "Switch a sticky note between its rendered Markdown preview and raw edit view. Switching to \"edit\" is always allowed; switching to \"preview\" is refused while a human has the note focused right now (same guard as write_sticky) so it never yanks the view out from under someone mid-edit.",
        inputSchema: {
          target: z.string().describe("The sticky card's id or label (see list_cards)"),
          mode: z.enum(["edit", "preview"]),
          callerCardId: z
            .string()
            .optional()
            .describe(
              "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process, and uses that to draw the auto-connector to this note.",
            ),
        },
      },
      async ({ target, mode, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "set_sticky_mode", target, mode, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "card_status",
      {
        description:
          "Check a terminal card's status: 'running' (actively producing output), 'idle' (alive but no output for a while — sitting at a prompt, likely waiting on you), 'exited', or 'waiting' (blocked on a consent decision, e.g. an open_url/spawn_agent/spawn_card call it made that a human hasn't approved or denied yet). A cheap alternative to polling snapshot/read_card in a loop. 'idle' is a heuristic (no-output-for-Nsec, same imprecision as any turn-detection) — a long 'thinking' pause can occasionally still read as idle.",
        inputSchema: {
          target: z.string().describe("The target card's id or label (see list_cards)"),
        },
      },
      async ({ target }) => {
        const res = await opts.handleRequest({ cmd: "card_status", target });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "close_card",
      {
        description:
          "Ask the human to close ANY open card (yours, one you spawned, or any other) — same consent gate as spawn_agent/spawn_card/open_url. Requires human approval unless the requester's board is in autonomous mode. Closing a live terminal kills its process; no undo.",
        inputSchema: {
          target: z.string().describe("The target card's id or label (see list_cards)"),
          reason: z.string().optional().describe("Why you want this closed — shown to the human in the approval dialog"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var) — used to check whether YOUR board is in autonomous mode."),
        },
      },
      async ({ target, reason, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "close_card", target, reason, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "report",
      {
        description:
          "Report a structured result back to whoever spawned you, decoupled from process exit — call this when you finish a delegated task, even if you keep running afterward. The caller reads it with read_report, no ANSI/scrollback parsing needed. Requires your own card id.",
        inputSchema: {
          callerCardId: z
            .string()
            .optional()
            .describe(
              "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it: the server already knows which card you are from the MCP URL it registered for your process. Pass it only to report on behalf of a different card.",
            ),
          report: z.unknown().describe("Any JSON value — e.g. {ok: true, result: '...'} or {ok: false, error: '...'}"),
        },
      },
      async ({ callerCardId, report }) => {
        const res = await opts.handleRequest({ cmd: "report", requesterId: caller(callerCardId), report });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "read_report",
      {
        description: "Read the structured result a card sent via `report`. With wait:true, blocks until one arrives instead of failing immediately when there isn't one yet.",
        inputSchema: {
          target: z.string().describe("The reporting card's id (see list_cards)"),
          wait: z.boolean().optional().describe("Block until a report arrives instead of returning ok:false immediately"),
          timeoutMs: z.number().optional().describe("Override the default wait window (10 minutes) when wait is true"),
        },
      },
      async ({ target, wait, timeoutMs }) => {
        const res = await opts.handleRequest({ cmd: "get_report", target, wait, timeoutMs });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "create_task",
      {
        description:
          "Record a task's identity, separate from any card's — it survives that card closing and the app restarting, so an interrupted orchestration can resume instead of starting over. No consent needed, this is bookkeeping only, it doesn't spawn or touch anything on the board — UNLESS boardId (or cardId's board) is autonomous AND this task has deps: then a later update_task marking a dep 'done' can auto-dispatch this one (DESIGN-BACKLOG.md item 60 peça 3).",
        inputSchema: {
          prompt: z.string().optional().describe("What the task is — free text"),
          provider: z.string().optional().describe("Which provider is meant to run it"),
          cardId: z.string().optional().describe("The card currently working on it, if one already exists — status starts 'running' when given, 'pending' otherwise"),
          boardId: z.string().optional().describe("Which board this task belongs to — required for auto-dispatch (peça 3) if the task has no cardId yet; inferred from cardId's board when omitted"),
          deps: z.array(z.string()).optional().describe("Ids of other tasks this one depends on — auto-dispatched once all are 'done', but only if this task's board is autonomous"),
          maxRetries: z.number().optional().describe("Auto-retry budget (DESIGN-BACKLOG.md item 60 peça 4) — only applies inside an autonomous board; default 2 when omitted"),
          fallbackProviders: z
            .array(z.string())
            .optional()
            .describe(
              "Providers to reassign to, in order, on auto-retry — tries the next untried one each failure, falling back to retrying the original provider once exhausted or if omitted. Only applies inside an autonomous board.",
            ),
        },
      },
      async ({ prompt, provider, cardId, boardId, deps, maxRetries, fallbackProviders }) => {
        const res = await opts.handleRequest({ cmd: "create_task", prompt, provider, cardId, boardId, deps, maxRetries, fallbackProviders });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "update_task",
      {
        description:
          "Update a task's status/card/result — e.g. after checking card_status or reading a report. Only the fields you pass change; the rest stay as they were. incrementRetry/attemptedProvider are bookkeeping for your own retry/reassignment loop (DESIGN-BACKLOG.md item 58 roteiro peça 5) — this app doesn't retry or reassign anything itself.",
        inputSchema: {
          taskId: z.string().describe("The task's id (from create_task or list_tasks)"),
          status: z.string().optional().describe("New status — e.g. 'running', 'done', 'failed'"),
          cardId: z.string().nullable().optional().describe("New card working on it, or null to detach once its own card closed — omit to leave unchanged"),
          result: z.unknown().optional().describe("Any JSON value — the task's outcome"),
          incrementRetry: z.boolean().optional().describe("Bump the task's retry counter by 1 — e.g. after deciding to retry a task whose agent exited without reporting"),
          attemptedProvider: z.string().optional().describe("Append a provider to the task's attempted-providers list — e.g. when reassigning to a different provider after a failure"),
        },
      },
      async ({ taskId, status, cardId, result, incrementRetry, attemptedProvider }) => {
        const res = await opts.handleRequest({ cmd: "update_task", taskId, status, cardId, result, incrementRetry, attemptedProvider });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "list_tasks",
      {
        description: "List every recorded task — id, prompt, provider, status, current card (if any), result, deps, retryCount, attemptedProviders. Survives card closes and app restarts.",
        inputSchema: {},
      },
      async () => {
        const res = await opts.handleRequest({ cmd: "list_tasks" });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "get_task",
      {
        description: "Read one task's current record by id.",
        inputSchema: {
          taskId: z.string().describe("The task's id (from create_task or list_tasks)"),
        },
      },
      async ({ taskId }) => {
        const res = await opts.handleRequest({ cmd: "get_task", taskId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "list_connectors",
      {
        description:
          "List every connector (arrow) on the board — id, fromCardId, toCardId, kind. `kind` is null for a purely decorative connector (hand-drawn via the UI); 'spawned' is set automatically whenever spawn_agent creates a new card — a real record of who spawned whom, not a guess; 'depends'/'context' is meaning an orchestrating agent attached on purpose with set_connector_kind, for THAT ORCHESTRATOR'S OWN reading. Nothing in this app ever dispatches off this graph, including the internal task-auto-dispatch engine (DESIGN-BACKLOG.md item 60 peça 3) — that reads create_task's own `deps` (task ids), a separate mechanism, since a task can exist with no card at all. Connectors link cards, not tasks; the two are deliberately never merged.",
        inputSchema: {},
      },
      async () => {
        const res = await opts.handleRequest({ cmd: "list_connectors" });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "set_connector_kind",
      {
        description:
          "Tag an existing connector's semantic meaning, for YOUR OWN reading as an external orchestrator — advisory only, nothing in this app acts on it: 'depends' (you've decided the target shouldn't start before the source reports done), 'context' (you've decided the source's result should feed the target's prompt), 'spawned' (a real spawn_agent lineage — usually set automatically, you'd only touch this to annotate one by hand), or null to clear it back to purely decorative. To actually make the app auto-dispatch a dependent task, use create_task's `deps` (task ids) instead — that's the real mechanism (DESIGN-BACKLOG.md item 60 peça 3), separate from this one on purpose.",
        inputSchema: {
          connectorId: z.string().describe("The connector's id (see list_connectors)"),
          kind: z.enum(["context", "depends", "spawned"]).nullable().describe("The semantic to attach, or null to clear it"),
        },
      },
      async ({ connectorId, kind }) => {
        const res = await opts.handleRequest({ cmd: "set_connector_kind", connectorId, kind });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "concurrency_status",
      {
        description:
          "Check how many non-bash agent cards are currently running against a cap — purely advisory, this app doesn't queue or refuse a spawn on its own account. Use this yourself before calling spawn_agent if you're fanning out several tasks and want to stay under a budget.",
        inputSchema: {
          cap: z.number().optional().describe("Your own concurrency budget — defaults to 3 if omitted"),
        },
      },
      async ({ cap }) => {
        const res = await opts.handleRequest({ cmd: "concurrency_status", cap });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "board_mode",
      {
        description:
          "Check whether a card's board has opt-in autonomous mode on — when it does, your own spawn_agent calls from a card on that board auto-approve instead of showing a consent dialog. Read-only: there's no tool to change this, only a human can via the app's own UI.",
        inputSchema: {
          target: z.string().describe("A card id on the board you want to check (see list_cards) — typically your own"),
        },
      },
      async ({ target }) => {
        const res = await opts.handleRequest({ cmd: "board_mode", target });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "open_url",
      {
        description: "Ask the human to open a URL in an embedded browser card. Requires human approval — this call blocks until they decide (or ~2 minutes pass). Returns the new card's id as `cardId` on approval: pass that straight to get_page_text/browser_click/browser_query/snapshot to act on the page you just opened. list_cards also shows every open browser card (kind: \"browser\", with its url).",
        inputSchema: {
          url: z.string().describe("The URL to open"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process; this only overrides that."),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
        },
      },
      async ({ url, callerCardId, reason }) => {
        const res = await opts.handleRequest({ cmd: "open", url, requesterId: caller(callerCardId), reason });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "spawn_agent",
      {
        description:
          "Ask the human to spawn ANOTHER agent/terminal card (a second provider working alongside you). Requires human approval, and is refused outright past a small recursion depth (an agent spawning an agent spawning an agent...) — the server tracks this itself from `callerCardId`'s own real depth, so there's nothing to declare or get wrong here (pre-release audit S4 — depth used to be a caller-supplied number, so a spawned agent could just re-claim depth 0 on its next call).",
        inputSchema: {
          provider: z.enum(["bash", "claude", "codex", "cursor", "antigravity", "opencode"]).describe("Which provider to spawn"),
          cwd: z.string().optional().describe("Working directory — defaults to the current board's root"),
          resumeId: z.string().optional().describe("Resume an existing session instead of starting fresh"),
          model: z.string().optional().describe("Model to launch the provider with (its own --model value, e.g. 'opus', 'gpt-5-codex') — omit to use that provider's default"),
          effort: z
            .enum(["low", "high"])
            .optional()
            .describe(
              "Antigravity ONLY — some of its models (e.g. 'gemini-3.1-pro') require this alongside `model` or the CLI silently falls back to a different model with just a warning, never actually running the one you asked for. Ignored by every other provider.",
            ),
          label: z.string().optional().describe("Name the new card (DESIGN-BACKLOG.md item 62) — same free-text field a human sets by renaming a card's tag. Omit to get the default ordinal-per-provider label instead."),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process, and uses that to look up YOUR real spawn depth and whether your board is in autonomous mode. Pass it only to override that."),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
          wait: z
            .boolean()
            .optional()
            .describe("Hold this call open until the spawned card's process exits, instead of returning as soon as it starts (default 10 minutes, see waitTimeoutMs)"),
          waitTimeoutMs: z.number().optional().describe("Override the default wait window (10 minutes) when wait is true"),
        },
      },
      async ({ provider, cwd, resumeId, model, effort, label, callerCardId, reason, wait, waitTimeoutMs }) => {
        const res = await opts.handleRequest({
          cmd: "spawn_agent",
          provider,
          cwd,
          resumeId,
          requesterId: caller(callerCardId),
          reason,
          model,
          effort,
          label,
          wait,
          waitTimeoutMs,
        });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "spawn_card",
      {
        description: "Create a non-terminal tool card (files explorer, git changes, sticky note, embedded browser, or remote window) on the board. `kind: \"sticky\"` is created immediately, no approval needed (same risk class as write_sticky — reversible, no disk/process side effect). Every other kind still requires human approval unless the board is in autonomous mode.",
        inputSchema: {
          kind: z.enum(["files", "changes", "sticky", "browser", "remote-window"]).describe("Which card kind to create"),
          cwd: z.string().optional().describe("Root path — used by files/changes kinds, defaults to the board's root"),
          url: z.string().optional().describe("URL — used by the browser kind"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process."),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
        },
      },
      async ({ kind, cwd, url, callerCardId, reason }) => {
        const res = await opts.handleRequest({ cmd: "spawn_card", kind, cwd, url, requesterId: caller(callerCardId), reason });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "snapshot",
      {
        description: "See a screenshot of a specific card, an explicit board rect, or the whole window — returned as an embedded image, not a file path (MCP clients don't share this app's filesystem). Targeting a BROWSER card captures that page's own rendered surface at full resolution — exactly the card and nothing else, regardless of where it sits on the board, the board's zoom, or whether it is even on screen. Every other card kind is captured from the app window, so it must be visible on the board.",
        inputSchema: {
          target: z.string().optional().describe("A card id to capture — omit along with rect for the whole window"),
          rect: z
            .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
            .optional()
            .describe("An explicit board-space rect to capture instead of a card"),
        },
      },
      async ({ target, rect }) => {
        const res = await opts.handleRequest({ cmd: "snapshot", target, rect });
        if (!res.ok) return { content: [{ type: "text", text: JSON.stringify(res) }], isError: true };
        try {
          const data = readFileSync(res.path as string).toString("base64");
          return { content: [{ type: "image", data, mimeType: "image/png" }] };
        } catch (err) {
          return { content: [{ type: "text", text: `failed to read snapshot file: ${String(err)}` }], isError: true };
        }
      },
    );

    server.registerTool(
      "get_page_text",
      {
        description: "Read a browser card's rendered page text (document.body.innerText, truncated if very long) — cheaper than snapshot when you just need to know what the page says, not see it.",
        inputSchema: { target: z.string().describe("The browser card's id or label (see list_cards)") },
      },
      async ({ target }) => {
        const res = await opts.handleRequest({ cmd: "get_page_text", target });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    // DESIGN-BACKLOG.md §2.1 "MCP do Navegador — Orquestração Completa"
    // — the 5 tools below act inside a browser card that already exists
    // (created via `open_url`/`spawn_card`, both human-gated) — no new
    // consent gate here, same "only reads/acts on what a human already
    // approved" reasoning as `get_page_text` right above. `browser_eval`
    // is the one that genuinely needs its own warning, spelled out in
    // its own `description` below rather than assumed obvious.
    server.registerTool(
      "browser_click",
      {
        description:
          "Click inside an already-open browser card. Prefer `selector` (a CSS selector — robust to scroll/zoom/resize, resolved against the live page) over raw `x`/`y` (the page's own logical pixel coordinates, only reliable right after a `browser_query` on that exact spot).",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          selector: z.string().optional().describe("CSS selector of the element to click — takes precedence over x/y if both given. Plain CSS only (the page's own document.querySelector); Playwright-style :has-text(...)/text=/>> are not supported — use browser_eval to match on text content"),
          x: z.number().optional().describe("X coordinate in the page's own logical pixels, only used if selector is omitted"),
          y: z.number().optional().describe("Y coordinate in the page's own logical pixels, only used if selector is omitted"),
          ref: z
            .string()
            .optional()
            .describe("Element id from browser_snapshot (e.g. \"e7\") — takes precedence over selector. The reliable way to target something you found by its visible name rather than by guessing a selector; refs are reissued by every browser_snapshot and stop being valid after a navigation or re-render."),
          callerCardId: CALLER_CARD_ID_FIELD,
        },
      },
      async ({ target, selector, ref, x, y, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "browser_click", target, selector, ref, x, y, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "browser_type",
      {
        description:
          "Type text into an already-open browser card, IME-safe (inserted as a whole string, not synthesized key by key). Give `selector` to focus that field first — omit only if you already know the right element is focused.",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          text: z.string().describe("The text to type"),
          selector: z.string().optional().describe("CSS selector of the input/textarea/editable element to focus before typing"),
          ref: z
            .string()
            .optional()
            .describe("Element id from browser_snapshot (e.g. \"e7\") — takes precedence over selector. The reliable way to target something you found by its visible name rather than by guessing a selector; refs are reissued by every browser_snapshot and stop being valid after a navigation or re-render."),
          callerCardId: CALLER_CARD_ID_FIELD,
        },
      },
      async ({ target, text, selector, ref, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "browser_type", target, text, selector, ref, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "browser_scroll",
      {
        description: "Scroll an already-open browser card. Give `selector` to scroll a specific nested scrollable container instead of the whole page.",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          dx: z.number().optional().describe("Horizontal scroll delta in pixels (default 0)"),
          dy: z.number().optional().describe("Vertical scroll delta in pixels (default 0)"),
          selector: z.string().optional().describe("CSS selector of the container to scroll — omit to scroll the whole page"),
          ref: z
            .string()
            .optional()
            .describe("Element id from browser_snapshot (e.g. \"e7\") — takes precedence over selector. The reliable way to target something you found by its visible name rather than by guessing a selector; refs are reissued by every browser_snapshot and stop being valid after a navigation or re-render."),
          callerCardId: CALLER_CARD_ID_FIELD,
        },
      },
      async ({ target, dx, dy, selector, ref, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "browser_scroll", target, dx, dy, selector, ref, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "browser_query",
      {
        description:
          "Inspect one element on an already-open browser card's page — existence, visible text, form value, link href, checked/disabled state, and real on-screen rect — without a screenshot.",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          selector: z.string().optional().describe("CSS selector of the element to inspect. Plain CSS only (the page's own document.querySelector) — Playwright-style :has-text(...)/text=/>> are not supported"),
          ref: z
            .string()
            .optional()
            .describe("Element id from browser_snapshot (e.g. \"e7\") — takes precedence over selector. The reliable way to target something you found by its visible name rather than by guessing a selector; refs are reissued by every browser_snapshot and stop being valid after a navigation or re-render."),
        },
      },
      async ({ target, selector, ref }) => {
        const res = await opts.handleRequest({ cmd: "browser_query", target, selector, ref });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    // Achados ao vivo (2026-09-01, relato de um agente que dirigiu o
    // navegador daqui): sem estas quatro, mirar um elemento exigia já
    // saber o seletor, esperar era dormir e torcer, e uma falha silenciosa
    // (um botão que não faz nada porque a API deu 500) não tinha nenhum
    // caminho de diagnóstico pelo lado do Stellar.
    server.registerTool(
      "browser_snapshot",
      {
        description:
          "List every visible, interactive element on a browser card's page — each with a stable `ref`, its role, and the name a human reads on screen. This is how you target something you can SEE but have no selector for: snapshot first, then pass the ref to browser_click/browser_type/browser_query. Much cheaper and more reliable than a screenshot plus guessing coordinates. Refs are reissued on every call and stop being valid after a navigation or re-render — snapshot again rather than reusing an old one.",
        inputSchema: { target: z.string().describe("The browser card's id or label (see list_cards)") },
      },
      async ({ target }) => {
        const res = await opts.handleRequest({ cmd: "browser_snapshot", target });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "browser_console",
      {
        description:
          "Read a browser card's captured console output (recent messages first dropped, ring buffer). The first place to look when a page silently misbehaves — an uncaught error or a failed fetch usually shows up here before anything is visible on screen.",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          level: z.enum(["error", "warning", "info", "debug"]).optional().describe("Only messages at this level — start with \"error\""),
          limit: z.number().optional().describe("Only the last N messages"),
        },
      },
      async ({ target, level, limit }) => {
        const res = await opts.handleRequest({ cmd: "browser_console", target, level, limit });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "browser_network",
      {
        description:
          "Read the HTTP requests a browser card's page has made (method, url, status, or a transport error). This is what answers \"the save button did nothing — did the request even go out, and what did it return?\". Use failedOnly:true to jump straight to the 4xx/5xx and transport failures.",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          failedOnly: z.boolean().optional().describe("Only requests that failed: 4xx, 5xx, or a transport error (DNS, CORS, aborted)"),
          status: z.number().optional().describe("Only requests with exactly this HTTP status"),
          urlContains: z.string().optional().describe("Only requests whose URL contains this substring"),
          limit: z.number().optional().describe("Only the last N requests"),
        },
      },
      async ({ target, failedOnly, status, urlContains, limit }) => {
        const res = await opts.handleRequest({ cmd: "browser_network", target, failedOnly, status, urlContains, limit });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "browser_wait_for",
      {
        description:
          "Block until a browser card's page shows (or stops showing) something — a CSS selector or a piece of visible text. Use this after an action instead of guessing how long to sleep; it returns as soon as the condition holds, and fails with a clear timeout if it never does.",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          selector: z.string().optional().describe("Wait for this CSS selector to match an element (plain CSS only)"),
          text: z.string().optional().describe("Wait for this text to appear in the page's visible text"),
          gone: z.boolean().optional().describe("Invert: wait for the selector/text to DISAPPEAR (a spinner going away, a dialog closing)"),
          timeoutMs: z.number().optional().describe("How long to wait before giving up (default 10000)"),
        },
      },
      async ({ target, selector, text, gone, timeoutMs }) => {
        const res = await opts.handleRequest({ cmd: "browser_wait_for", target, selector, text, gone, timeoutMs });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "browser_eval",
      {
        description:
          "Run arbitrary JavaScript in an already-open browser card's real page context and return the (JSON-stringified) result. Unlike the other browser_* tools, this has DevTools-console-level power — the script can read cookies, session storage, and anything else the logged-in page's own JS could read. Only use it against pages/data you'd be comfortable a human collaborator reading.",
        inputSchema: {
          target: z.string().describe("The browser card's id or label (see list_cards)"),
          js: z.string().describe("JavaScript to evaluate in the page's context — the expression's value becomes the result"),
          callerCardId: CALLER_CARD_ID_FIELD,
        },
      },
      async ({ target, js, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "browser_eval", target, js, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    return server;
  }

  function methodNotAllowed(res: ServerResponse) {
    res.writeHead(405, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
    );
  }

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // `?card=<id>` — ver o doc de `buildServer`. Base descartável só pra
    // poder usar o parser de URL num caminho relativo; nada aqui olha o
    // host (o servidor só escuta em 127.0.0.1).
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (parsed.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const server = buildServer(parsed.searchParams.get("card") ?? undefined);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err) => {
        console.error("mcp-server: request failed:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }),
          );
        }
      });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  });

  // Same reasoning as message-bus.ts's socket bind guard — a port already
  // in use (a leftover instance, a verify-harness collision) must never
  // crash the whole main process over a capability that's a nice-to-have,
  // not core functionality.
  httpServer.on("error", (err) => {
    console.error("mcp-server: failed to bind, MCP tools will be unavailable:", err);
  });

  // `opts.port` is 0 by default (index.ts) — the OS assigns a free ephemeral
  // port, sidestepping EADDRINUSE entirely for the common case of two live
  // instances (e.g. a packaged app + `npm run dev`) both wanting an MCP
  // server. The real port is only known once `listening` fires, so `url`
  // starts as a placeholder (matches this port, in case `opts.port` was
  // explicitly pinned — the verify harness does this, see cdp-client.mjs)
  // and is updated in place once bound. Every consumer reads `.url` lazily
  // (pty-registry.ts's `registryOpts.mcpUrl` getter, see index.ts) rather
  // than copying the string at construction time, so this update is seen.
  const state = { url: `http://127.0.0.1:${opts.port}/mcp` };
  httpServer.on("listening", () => {
    const addr = httpServer.address();
    if (addr && typeof addr === "object") {
      state.url = `http://127.0.0.1:${addr.port}/mcp`;
    }
  });
  httpServer.listen(opts.port);

  function close() {
    httpServer.close();
  }

  return {
    get url() {
      return state.url;
    },
    close,
  };
}

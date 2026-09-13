import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod";
import { STICKY_COLORS, type BusRequest, type BusResponse } from "./message-bus";
import { resolveCallerCardId } from "./caller-identity";
import { reachFromHunks } from "./reach-from-hunks";
import { reachAcrossLiterals } from "./reach-across-literals";
import { TASK_CARD_ROLES, TASK_PURPOSES } from "../task-purpose";

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
   * `callerCardId` continua aceito no schema por compatibilidade, mas ver
   * `caller-identity.ts`: só o carimbo da URL estabelece identidade. Uma
   * URL sem `?card=` — smoke test que disca a porta direto ou cliente MCP
   * externo — fica anônima; o corpo não pode escolher um card autônomo e
   * pular consentimento.
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
      "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server knows your identity from the MCP URL registered for your process. A callerCardId supplied in the request body is never trusted to establish identity when that URL stamp is absent, so a raw external client remains anonymous and cannot inherit an autonomous board's consent.",
    );

  function buildServer(urlCardId?: string): McpServer {
    // Ver `caller-identity.ts` (achado crítico de escalada de privilégio,
    // card 337, 2026-09-11) pro modelo completo e o porquê da
    // precedência: só o carimbo da URL estabelece identidade — fora do
    // alcance do modelo que chama a tool. Sem carimbo, uma conexão externa
    // permanece anônima; o explícito não pode escolher um board autônomo.
    const caller = (explicit?: string) => resolveCallerCardId({ urlCardId, explicitCallerCardId: explicit });
    const server = new McpServer({ name: "stellar", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });

    server.registerTool(
      "list_cards",
      {
        description:
          "List every open card on the board — terminals AND non-terminal cards (browser, sticky, files, changes, media, chat, remote-window, task). Each entry has id, kind, label (the name a human gave the card in its header, null if unnamed), provider (terminal/chat only), cwd (a real path only for terminal/chat/files/changes), and url (browser cards). Anywhere a tool takes a `target`, you can pass either the id or the card's label.",
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
        description:
          "Enqueue a message to type into another open terminal card, followed by Enter — same as typing it yourself into that card. Returns immediately with {ok:true, delivery:\"queued\", id, reason?} so this call never sits in the human-input or TUI-boot gates (those wait on the existing per-card FIFO). delivery is \"queued\" here; poll get_delivery with the id to learn when that FIFO item has finished typing. reason is \"human-input\" when the target human is mid-line, \"card-busy\" when the TUI is still booting or another delivery is already in that card's FIFO.",
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
      "get_delivery",
      {
        description:
          "Read the status of one send_to_card (or other programmatic PTY) delivery by the id that call returned. {delivery:\"queued\"} means the FIFO item has not finished typing yet (reason names the hold if one is still visible). {delivery:\"delivered\"} means that FIFO item settled — the same moment the old awaited send_to_card used to return. Does not wait.",
        inputSchema: {
          id: z.string().describe("The delivery id from send_to_card's return"),
        },
      },
      async ({ id }) => {
        const res = await opts.handleRequest({ cmd: "get_delivery", id });
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
          "Write a sticky note's text — no human approval needed, this is board content, not a disk/process side effect. Refused while a human has that note focused for editing, so it can never overwrite what someone is typing; retry after. Returns the note's resulting content. A connector automatically links your own card to this note (no duplicate on repeated writes to the same note). " +
          "Pass `content` for a short inline note. Pass `path` instead when the text is already on disk (you just read or wrote that file) — the main process reads it, so a large block of names/ids/PII does not have to travel in the tool call. `path` is relative to your card's project root, or an absolute path still inside that root. Use one of `content` or `path`, not both. `mode` works the same for either form. " +
          "This only shrinks the tool-call surface; it does not hide the text from the card itself, and a client-side permission classifier can still flag the write.",
        inputSchema: {
          target: z.string().describe("The sticky card's id or label (see list_cards)"),
          content: z
            .string()
            .optional()
            .describe("Short note text to write inline. Prefer this for a few lines. Omit when using `path`."),
          path: z
            .string()
            .optional()
            .describe(
              "File to read as the note text, relative to your card's project root (or absolute still inside that root). Use this when the payload is already a file you read or wrote — keeps the tool call small. Same confine + 512KB cap as the app's other file reads. Omit when using `content`.",
            ),
          mode: z
            .enum(["replace", "append"])
            .optional()
            .describe("replace (default) swaps the whole note; append adds to the end — prefer append for a running log so a human's own lines survive. Works with both `content` and `path`."),
          callerCardId: z
            .string()
            .optional()
            .describe(
              "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process, and uses that to draw the auto-connector to this note.",
            ),
        },
      },
      async ({ target, content, path, mode, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "write_sticky", target, content, path, mode, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "update_card_content",
      {
        description:
          "Write a sticky note's text even on a board that isn't currently loaded (write_sticky only reaches the board that's actually open). For a sticky on the loaded board this behaves exactly like write_sticky (same human-focus guard, same auto-connector). For any other board this only works if THAT board is in autonomous mode — no live UI there to ever refuse a conflicting human edit, so it's the same contract spawn_card/open_url use for a board explicitly told this is fine. " +
          "Same content-or-path choice as write_sticky: pass `content` for a short inline note; pass `path` when the text is already a file you read or wrote, so the large block does not travel in the tool call. Use one, not both. `mode` works for either form. This only shrinks the tool-call surface — the text still lands on the card.",
        inputSchema: {
          target: z.string().describe("The sticky card's id (list_cards only shows the loaded board's cards, so a cross-board target must be a real id you already have, not a label)"),
          content: z
            .string()
            .optional()
            .describe("Short note text to write inline. Omit when using `path`."),
          path: z
            .string()
            .optional()
            .describe(
              "File to read as the note text, relative to your card's project root (or absolute still inside that root). Use when the payload is already on disk. Same confine + 512KB cap as write_sticky. Omit when using `content`.",
            ),
          mode: z
            .enum(["replace", "append"])
            .optional()
            .describe("replace (default) swaps the whole note; append adds to the end. Works with both `content` and `path`."),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it."),
        },
      },
      async ({ target, content, path, mode, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "update_card_content", target, content, path, mode, requesterId: caller(callerCardId) });
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
      "delete_card",
      {
        description:
          "Permanently delete a card, even one on a board that isn't currently loaded (close_card only reaches the board that's actually open). For a card on the loaded board this behaves exactly like close_card (same consent gate, same live-terminal handling). For any other board — no live UI there to ever ask a human — this only works if THAT board is in autonomous mode; otherwise it's refused with a clear error telling you to load the board or turn autonomous mode on.",
        inputSchema: {
          target: z.string().describe("The target card's id (list_cards only shows the loaded board's cards, so a cross-board target must be a real id you already have, not a label)"),
          reason: z.string().optional().describe("Why you want this deleted — shown to the human in the approval dialog when the board is loaded"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var) — used to check whether YOUR board is in autonomous mode when the target is on the loaded board."),
        },
      },
      async ({ target, reason, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "delete_card", target, reason, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "report",
      {
        description:
          "Report a structured result back to whoever spawned you, decoupled from process exit — call this when you finish a delegated task, even if you keep running afterward. The caller reads it with read_report, no ANSI/scrollback parsing needed. Requires your own card id. " +
          "Acceptance: success is {ok: true, ...}; a report without ok is also accepted (not treated as failure). " +
          "Declared failure is {ok: false, ...}. If that failure is still retryable (you omitted retryable, or sent retryable: true) AND a running task is linked to this card with retry budget left, THIS CALL IS REFUSED — the tool returns {ok: false, retriesRemaining, ...}, the task stays running, retry_count goes up by 1, and you (the same session, same context) correct and call report again. No new card is spawned. " +
          "Honest terminal failure — use when retry cannot help (no credits, investigation concluded negatively, a metric the CLI does not expose): {ok: false, retryable: false, ...}. That is accepted on the first call, the task becomes failed, and no retry is spent. Without retryable: false, the only other accepted exits are success or exhausting max_retries. Do not declare ok: true to escape a real failure. " +
          "The app does not judge whether your contents are correct. A refused call names the acceptance rule and remaining attempts; a structural refusal (missing report, ok/retryable not a boolean) names the field.",
        inputSchema: {
          callerCardId: z
            .string()
            .optional()
            .describe(
              "Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it: a registered MCP process is identified by its URL stamp; this body field is not trusted when that stamp is absent, so an external client cannot report as a different card just by naming one here.",
            ),
          report: z
            .unknown()
            .describe(
              "Any JSON value. Success: {ok: true, ...}. Retryable failure: {ok: false, ...} — refused in-line while max_retries remain so you can correct in this same session. Terminal failure (accepted immediately, no retry spent): {ok: false, retryable: false, ...}. A payload without ok is accepted and is not a failure. ok and retryable, when present, must be booleans.",
            ),
          verdict: z
            .enum(["aprovado", "reprovado"])
            .optional()
            .describe(
              "Formal verdict for a review report — a real, typed field (not just a convention inside `report`'s free JSON). Omit for a plain non-review report. Stored together with YOUR role on the task (task_cards: implementer/reviewer, or unknown when your card is not linked). Only an 'aprovado' from a card linked as reviewer proposes completion on the Fila; an implementer's 'aprovado' is recorded as self-assessment and, while a reviewer is linked to the task, does not propose anything.",
            ),
        },
      },
      async ({ callerCardId, report, verdict }) => {
        const res = await opts.handleRequest({ cmd: "report", requesterId: caller(callerCardId), report, verdict });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "read_report",
      {
        description:
          "Read the structured result a card sent via `report`. With wait:true, blocks until one arrives instead of failing immediately when there isn't one yet. Every report carries a `seq` assigned by the server (never the reporting card) — pass the last `seq` you saw back as `afterSeq` to get the NEXT report (smallest seq strictly greater than that), including after the fact when the card already filed several rounds. Without `afterSeq`, returns the most recent report for that card. Also returns `verdict` ('aprovado'/'reprovado'/null) when the reporter set one, and `role` — the reporter's task_cards role at report time ('implementer'/'reviewer'/null when unknown), so you can tell a review verdict from an implementer judging its own work.",
        inputSchema: {
          target: z.string().describe("The reporting card's id (see list_cards)"),
          wait: z.boolean().optional().describe("Block until a report arrives instead of returning ok:false immediately"),
          timeoutMs: z.number().optional().describe("Override the default wait window (10 minutes) when wait is true"),
          afterSeq: z
            .number()
            .optional()
            .describe("Only accept a report with seq strictly greater than this (the `seq` from a previous read_report call) — otherwise you get the same already-seen report back"),
        },
      },
      async ({ target, wait, timeoutMs, afterSeq }) => {
        const res = await opts.handleRequest({ cmd: "get_report", target, wait, timeoutMs, afterSeq });
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
          cwd: z
            .string()
            .optional()
            .describe(
              "Working directory for auto-dispatch of this task. Omit to keep the board-root fallback (same as before). Pass the repo path when the task must NOT open at the board root — otherwise a dependent spawn can land on 'trust this folder' and exit 129.",
            ),
          deps: z.array(z.string()).optional().describe("Ids of other tasks this one depends on — auto-dispatched once all are 'done', but only if this task's board is autonomous"),
          maxRetries: z
            .number()
            .optional()
            .describe(
              "In-line retry budget for the same agent: how many times a declared failure ({ok: false} without retryable: false) is refused so that agent can correct and report again in the same session. Default 2 when omitted. Does not spawn a new card.",
            ),
          fallbackProviders: z
            .array(z.string())
            .optional()
            .describe(
              "Bookkeeping list of substitute providers. The app never reassigns or spawns a fallback itself — a human or orchestrator reassigns by hand via update_task.attemptedProvider. Kept so that loop does not have to track the list elsewhere.",
            ),
          suggestedOrder: z
            .number()
            .optional()
            .describe(
              "YOUR priority guess for this task (you know what unblocks what) — shown alongside, never instead of, a human's own drag-set order. There's no agent-facing way to set that human order; it's set only by dragging on the board.",
            ),
          purpose: z
            .enum(TASK_PURPOSES)
            .optional()
            .describe(
              "What kind of work this task IS, declared once here and shown as a chip on the board's task queue (Fila). 'investigate' = find out / diagnose, the deliverable is knowledge, not a change; 'implement' = build something new; 'measure' = collect numbers or evidence about the current state; 'fix' = correct a defect in something that already exists. WRITE-ONCE: update_task has no purpose field and cannot relabel it — a wrong value means a new task, not an edit, so decide it now. Omit when you genuinely cannot say: absence is a normal state (the chip stays empty) and is better than a guess; nothing infers it from the prompt text. Any value outside the four is REFUSED and the task is not created. This is about the TASK, not about a card — which card implements or reviews it is `role` on spawn_agent / link_task_card, a separate thing.",
            ),
        },
      },
      async ({ prompt, provider, cardId, boardId, cwd, deps, maxRetries, fallbackProviders, suggestedOrder, purpose }) => {
        const res = await opts.handleRequest({ cmd: "create_task", prompt, provider, cardId, boardId, cwd, deps, maxRetries, fallbackProviders, suggestedOrder, purpose });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "update_task",
      {
        description:
          "Update a task's status/card/result/prompt — e.g. after checking card_status or reading a report. Only the fields you pass change; the rest stay as they were. `purpose` is deliberately NOT here: it is write-once at create_task and cannot be relabeled (a wrong purpose means a new task). Writing status when a human last moved the task is ACCEPTED WITH A WARNING and never refused — the human status stays, divergence is signaled. To ASK the human to accept your status (they decide on the Fila card), use request_task_status instead; this tool is the direct write. prompt defaults to APPEND: the original statement (why the task exists) stays, and your text is added below a visible [stellar:added …] marker so anyone who later reads this task can see what arrived after create. promptMode \"replace\" overwrites the whole briefing — omit it unless you mean to. Writing prompt does NOT type or re-send anything to a card already running; the stored prompt is what a later spawn receives. incrementRetry/attemptedProvider are bookkeeping for YOUR OWN retry/reassignment loop (DESIGN-BACKLOG.md item 58 roteiro peça 5) — you increment and record providers when YOU reassign. This app never reassigns to another provider. It does retry in-line on the same agent: a report of {ok: false} without retryable: false is refused while max_retries remain, so that agent can correct and report again in the same session.",
        inputSchema: {
          taskId: z.string().describe("The task's id (from create_task or list_tasks)"),
          status: z.string().optional().describe("New status — e.g. 'running', 'done', 'failed'"),
          cardId: z.string().nullable().optional().describe("New card working on it, or null to detach once its own card closed — omit to leave unchanged"),
          cwd: z
            .string()
            .nullable()
            .optional()
            .describe(
              "Set or clear this task's working directory for auto-dispatch. null clears back to the board-root fallback; omit leaves unchanged.",
            ),
          result: z.unknown().optional().describe("Any JSON value — the task's outcome"),
          incrementRetry: z.boolean().optional().describe("Bump the task's retry counter by 1 — e.g. after deciding to retry a task whose agent exited without reporting"),
          attemptedProvider: z.string().optional().describe("Append a provider to the task's attempted-providers list — e.g. when reassigning to a different provider after a failure"),
          suggestedOrder: z.number().optional().describe("YOUR priority guess for this task — see create_task. Never overwrites a human's own drag-set order, which has no agent-facing setter."),
          prompt: z
            .string()
            .optional()
            .describe(
              "Text to add to (default) or replace the task briefing. Omit to leave the stored prompt unchanged. Append keeps the original statement and marks this addition so a later 'read your task' can tell them apart.",
            ),
          promptMode: z
            .enum(["append", "replace"])
            .optional()
            .describe("How to write prompt. Default append. replace is explicit overwrite of the whole briefing."),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server knows your identity from the MCP URL registered for your process."),
        },
      },
      async ({ taskId, status, cardId, cwd, result, incrementRetry, attemptedProvider, suggestedOrder, prompt, promptMode, callerCardId }) => {
        const res = await opts.handleRequest({
          cmd: "update_task",
          taskId,
          status,
          cardId,
          cwd,
          result,
          incrementRetry,
          attemptedProvider,
          suggestedOrder,
          prompt,
          promptMode,
          requesterId: caller(callerCardId),
        });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "request_task_status",
      {
        description:
          "Ask the human to change a task's status. Returns immediately — this does NOT block like spawn_agent/open_url/close_card. The ask (with your reason) appears on the Fila task-detail modal; the human Allow/Deny there. Does not write status itself. Unlike spawn_agent, autonomous mode does NOT auto-approve: a human-locked status stays locked until a human clicks. Direct update_task still works as before (accepted with a warning, never refused). If the task is already at the requested status, returns pending:false / already:true.",
        inputSchema: {
          taskId: z.string().describe("The task's id (from create_task or list_tasks)"),
          status: z.string().describe("Status you want the human to accept — e.g. 'done', 'failed', 'running'"),
          reason: z
            .string()
            .optional()
            .describe("Why the change should happen — shown on the Fila modal, same as spawn_agent/open_url's reason"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server knows your identity from the MCP URL registered for your process."),
        },
      },
      async ({ taskId, status, reason, callerCardId }) => {
        const res = await opts.handleRequest({
          cmd: "request_task_status",
          taskId,
          status,
          reason,
          requesterId: caller(callerCardId),
        });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "list_tasks",
      {
        description:
          "List every recorded task — id, prompt, provider, status, current card (if any), cwd, purpose (investigate/implement/measure/fix, or null when never declared), result, deps, retryCount, attemptedProviders, order/suggestedOrder. Survives card closes and app restarts.",
        inputSchema: {
          boardId: z.string().optional().describe("Only tasks belonging to this board — omit to list every task across every board, same as before this param existed"),
        },
      },
      async ({ boardId }) => {
        const res = await opts.handleRequest({ cmd: "list_tasks", boardId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "get_task",
      {
        description:
          "Read one task's current record by id — also includes its full status-transition trail (`transitions`), every card linked to it with a role (`cards`, e.g. one implementing + one reviewing), and its append-only verdict history (`verdicts`: one entry per participation round, `{cardId, role, verdict, at}`, `verdict: null` meaning that round ended without one) — unlike list_tasks which stays lean. Read-only: no tool writes to this history directly, it's derived from `report` calls and unreported exits.",
        inputSchema: {
          taskId: z.string().describe("The task's id (from create_task or list_tasks)"),
        },
      },
      async ({ taskId }) => {
        const res = await opts.handleRequest({ cmd: "get_task", taskId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    // `task_cards.role` writer for a card that ALREADY exists. The other
    // writer is spawn_agent's `role` (card born for the task). Before
    // 2026-09-13 neither existed and 91/91 rows were the silent
    // implementer default — see store.ts's TaskCardRow comment.
    server.registerTool(
      "link_task_card",
      {
        description:
          "Record what an EXISTING open card does on a task — its role. Use this when you reuse a card that is already alive (e.g. a running agent you now want to review a task) instead of spawning a new one; to spawn a new card already linked, pass `taskId` + `role` to spawn_agent instead. role 'reviewer' = this card judges the work: it only adds the role row; the task's principal card (cardId) is left as it is, so the reviewer's own report {ok:false} is a verdict, not the task failing, and its rounds show up in get_task's `verdicts` with role reviewer (the Fila's ' ↔ review' chip derives from this). role 'implementer' (the default when omitted) = this card does the work: it ALSO becomes the task's principal cardId (same link spawn_agent/auto-dispatch write), status untouched. A card that is currently the task's principal cardId cannot be linked as reviewer — detach it first (update_task cardId: null). Re-linking the same card changes its role (one role per card per task). No consent needed: structural bookkeeping, nothing is spawned or typed. Unknown task, unknown card, or a role outside implementer/reviewer is REFUSED — nothing is written.",
        inputSchema: {
          taskId: z.string().describe("The task's id (from create_task or list_tasks)"),
          cardId: z.string().describe("The existing card's id (see list_cards). Must be open on the current board."),
          role: z
            .enum(TASK_CARD_ROLES)
            .optional()
            .describe(
              "'implementer' (default when omitted) = this card does the task's work and becomes its principal cardId. 'reviewer' = this card judges the work; principal cardId is untouched. Any other value is refused.",
            ),
          callerCardId: CALLER_CARD_ID_FIELD,
        },
      },
      async ({ taskId, cardId, role, callerCardId }) => {
        const res = await opts.handleRequest({ cmd: "link_task_card", taskId, cardId, role, requesterId: caller(callerCardId) });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — fechamento EXPLICITO
    // (nunca por data). Thin wrappers over message-bus cmds; consent not
    // required (structural board bookkeeping, same class as update_task).
    server.registerTool(
      "list_sprints",
      {
        description:
          "List sprints for a board — active first by number descending. Closed rows carry frozen counts (todo/doing/done/failed + migrated in/out) and timestamps; those numbers never change after close. Active sprint has zeros in count_* until closed.",
        inputSchema: {
          boardId: z.string().describe("Board whose sprints to list"),
        },
      },
      async ({ boardId }) => {
        const res = await opts.handleRequest({ cmd: "list_sprints", boardId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );
    server.registerTool(
      "open_sprint",
      {
        description:
          "Ensure the board has an active sprint. Idempotent when one is already open (returns that row). Creates Sprint N+1 only when none is open. Never closes.",
        inputSchema: {
          boardId: z.string().describe("Board to open a sprint on"),
        },
      },
      async ({ boardId }) => {
        const res = await opts.handleRequest({ cmd: "open_sprint", boardId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );
    server.registerTool(
      "close_sprint",
      {
        description:
          "Close the board's active sprint: freeze snapshot counts + board membership, migrate unfinished todo/doing AND interrupted (failureKind=interrompida) into a newly opened sprint, leave done and judged failures (julgada) on the closed sprint. countFailed only counts julgada. REFUSES an empty sprint or when there is no active sprint. Never auto-closes by calendar.",
        inputSchema: {
          boardId: z.string().describe("Board whose active sprint to close"),
        },
      },
      async ({ boardId }) => {
        const res = await opts.handleRequest({ cmd: "close_sprint", boardId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );
    server.registerTool(
      "rename_sprint",
      {
        description:
          "Set or clear the display name of a sprint (active or closed). Identity stays the auto number — empty/null clears the name so the UI falls back to 'Sprint N'. Does not close, open, or move tasks.",
        inputSchema: {
          sprintId: z.string().describe("Sprint id to rename"),
          name: z
            .string()
            .nullable()
            .optional()
            .describe("New display name; omit or null/empty to clear back to Sprint N"),
        },
      },
      async ({ sprintId, name }) => {
        const res = await opts.handleRequest({
          cmd: "rename_sprint",
          sprintId,
          name: name === undefined ? null : name,
        });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );
    server.registerTool(
      "delete_sprint",
      {
        description:
          "Delete the ACTIVE sprint only (undo accidental open/close). Moves its tasks to the previous closed sprint and REOPENS that previous (discards its frozen snapshot — board is live again). Closed sprints refuse — history stays. Sole sprint with tasks refuses; sole empty sprint just deletes the row.",
        inputSchema: {
          sprintId: z.string().describe("Active sprint id to delete"),
        },
      },
      async ({ sprintId }) => {
        const res = await opts.handleRequest({ cmd: "delete_sprint", sprintId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "list_connectors",
      {
        description:
          "List every connector (arrow) on the board — id, fromCardId, toCardId, kind. `kind` is null for a purely decorative connector (hand-drawn via the UI); 'spawned' is set automatically whenever spawn_agent creates a new card — a real record of who spawned whom, not a guess. Writing or clearing `spawned` is guarded (only the origin card, and only when identified). The app does NOT push a typed notice or OS popup when a card reports, goes idle, or exits — poll card_status then read_report (no wait). 'depends'/'context' stay purely advisory — an orchestrating agent attaches them on purpose with set_connector_kind, for THAT ORCHESTRATOR'S OWN reading; nothing in this app acts on either. Task auto-dispatch (DESIGN-BACKLOG.md item 60 peça 3) never reads this graph at all, `spawned` included — it reads create_task's own `deps` (task ids), a separate mechanism, since a task can exist with no card at all. Connectors link cards, not tasks; the two are deliberately never merged.",
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
          "Tag an existing connector's semantic meaning. 'depends' (you've decided the target shouldn't start before the source reports done) and 'context' (you've decided the source's result should feed the target's prompt) are advisory only, for YOUR OWN reading as an external orchestrator — nothing in this app acts on either. 'spawned' is different: a real spawn_agent lineage (usually set automatically, you'd only touch this to annotate one by hand). Writing or clearing it is guarded (identified caller AND origin endpoint) so a third card cannot steal or erase someone else's lineage on the graph. It does NOT route a typed/OS push — reports live in the table; poll card_status then read_report (no wait). null clears any kind back to purely decorative. To actually make the app auto-dispatch a dependent task, use create_task's `deps` (task ids) instead — that's the real mechanism (DESIGN-BACKLOG.md item 60 peça 3), separate from this one on purpose.",
        inputSchema: {
          connectorId: z.string().describe("The connector's id (see list_connectors)"),
          kind: z.enum(["context", "depends", "spawned"]).nullable().describe("The semantic to attach, or null to clear it"),
          callerCardId: CALLER_CARD_ID_FIELD,
        },
      },
      async ({ connectorId, kind, callerCardId }) => {
        const res = await opts.handleRequest({
          cmd: "set_connector_kind",
          connectorId,
          kind,
          requesterId: caller(callerCardId),
        });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "set_connector_label",
      {
        description:
          "Set (or clear) an existing connector's short label — the styled pill drawn along the arrow, meant to say what the current task between the two cards actually is. Truncated the same way as any auto-generated label. Note: a `send`/`browser_*` action between the same two cards already refreshes an existing connector's label on its own the next time one happens; use this tool for an explicit update instead — e.g. announcing what a dependent card is doing right now — independent of that automatic path.",
        inputSchema: {
          connectorId: z.string().describe("The connector's id (see list_connectors)"),
          label: z.string().nullable().describe("The label text, or null to clear it"),
        },
      },
      async ({ connectorId, label }) => {
        const res = await opts.handleRequest({ cmd: "set_connector_label", connectorId, label });
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
        description:
          "Ask the human to open a URL in an embedded browser card. Requires human approval — this call blocks until they decide (or ~2 minutes pass). Returns the card's id as `cardId` on approval: pass that straight to get_page_text/browser_click/browser_query/snapshot to act on the page. By default this REUSES your existing browser card (same owner) and navigates it — so repeated open_url calls don't clutter the board. Pass `reuse: false` (or call spawn_card with kind:\"browser\") when you need a SECOND browser open at the same time. list_cards also shows every open browser card (kind: \"browser\", with its url).",
        inputSchema: {
          url: z.string().describe("The URL to open"),
          reuse: z
            .boolean()
            .optional()
            .describe(
              "Default true: navigate your existing browser card if you already have one. Set false to open an additional browser card instead (same outcome as spawn_card kind:\"browser\").",
            ),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — a registered MCP process is identified by its URL stamp; this body field is not trusted to establish identity when the stamp is absent."),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
        },
      },
      async ({ url, reuse, callerCardId, reason }) => {
        // DESIGN-BACKLOG.md §2.0 item 5 — reuse:false must open a new card,
        // but the open/ask IPC path has no reuse flag (message-bus owned
        // elsewhere this sprint). Route through spawn_card's browser kind,
        // which App.tsx always creates fresh. reuse:true/omitted keep the
        // legacy open cmd (renderer defaults to reuse for a non-null owner).
        const requesterId = caller(callerCardId);
        const res =
          reuse === false
            ? await opts.handleRequest({ cmd: "spawn_card", kind: "browser", url, requesterId, reason })
            : await opts.handleRequest({ cmd: "open", url, requesterId, reason });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "spawn_agent",
      {
        description:
          "Ask the human to spawn ANOTHER agent/terminal card (a second provider working alongside you). Requires human approval, and is refused outright past a small recursion depth (an agent spawning an agent spawning an agent...) — the server tracks this itself from `callerCardId`'s own real depth, so there's nothing to declare or get wrong here (pre-release audit S4 — depth used to be a caller-supplied number, so a spawned agent could just re-claim depth 0 on its next call). `taskId` is optional: when you pass one, the new card's brief is that task's stored prompt (the same source auto-dispatch uses) and the card is linked to the task as its implementer. Without `taskId`, free `brief` still works exactly as before — including omitting both, which just opens a card. Do not pass `taskId` and `brief` together — EXCEPT with `role: \"reviewer\"`, where `brief` is the review order and the task prompt is what is under review (see `role`).",
        inputSchema: {
          provider: z.enum(["bash", "claude", "codex", "cursor", "antigravity", "opencode"]).describe("Which provider to spawn"),
          cwd: z.string().optional().describe("Working directory — defaults to the current board's root"),
          resumeId: z.string().optional().describe("Resume an existing session instead of starting fresh"),
          model: z.string().optional().describe("Model to launch the provider with (its own --model value, e.g. 'opus', 'gpt-5-codex') — omit to use that provider's default"),
          // DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" —
          // union of every provider's real range, re-measured 2026-09-12
          // against the live CLIs (not the comments): `claude --help`
          // (v2.1.269) is `--effort low|medium|high|xhigh|max`; `agy
          // --help` (v1.2.2) is `low|medium|high` (was documented as
          // only `low|high`). The two ranges differ — NOT unified by
          // picking the narrower one, which would silently make
          // `xhigh`/`max` unreachable for claude, the same class of bug
          // this whole fix is for. The provider-specific half of the
          // validation (a spawn with an out-of-range value for THAT
          // provider) happens centrally in message-bus.ts's
          // `spawn_agent` handler, the one place that has BOTH `provider`
          // and `effort` together — zod's per-field schema here can't see
          // across fields without a cross-field refinement that would
          // duplicate that same provider table.
          effort: z
            .enum(["low", "medium", "high", "xhigh", "max"])
            .optional()
            .describe(
              "Reasoning effort. `claude` accepts all five (low/medium/high/xhigh/max, its own --effort range). Antigravity accepts low/medium/high (its own --effort range) — some of its models (e.g. 'gemini-3.1-pro') require one of those alongside `model` or the CLI silently falls back to a different model with just a warning, never actually running the one you asked for. A value outside a provider's own range is REFUSED (no spawn), not silently remapped. Ignored by every other provider.",
            ),
          label: z.string().optional().describe("Name the new card (DESIGN-BACKLOG.md item 62) — same free-text field a human sets by renaming a card's tag. Omit to get the default ordinal-per-provider label instead."),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the registered MCP URL stamp is the only trusted identity and determines real spawn depth/autonomy; this field is not trusted when that stamp is absent."),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
          wait: z
            .boolean()
            .optional()
            .describe("Hold this call open until the spawned card's process exits, instead of returning as soon as it starts (default 10 minutes, see waitTimeoutMs)"),
          waitTimeoutMs: z.number().optional().describe("Override the default wait window (10 minutes) when wait is true"),
          brief: z
            .string()
            .optional()
            .describe(
              "Initial prompt/briefing for the spawned agent (what it should do). Still the first-class path when you are not tying this card to a task — omit `taskId` and this text is delivered as today. Omit both to just open a card. Do not pass together with `taskId`.",
            ),
          taskId: z
            .string()
            .optional()
            .describe(
              "Optional. When set, the spawned agent's brief is the stored prompt of that task — the same source auto-dispatch already uses — and the new card is linked as that task's card. Spawn without a task remains first-class: omit this field and `brief` still works exactly as before (including omitting both). A missing id is refused. Do not pass together with `brief` (unless `role` is 'reviewer'); an addendum that belongs on the work goes on the task via update_task (prompt append) first.",
            ),
          role: z
            .enum(TASK_CARD_ROLES)
            .optional()
            .describe(
              "What the NEW card does on `taskId` — only meaningful with `taskId`; passing it without one is refused. Omit (or 'implementer') = the card does the task's work: it becomes the task's principal cardId, its brief is the task's stored prompt, and its report {ok:false} counts against the task's retry budget — exactly today's behavior, so nothing changes if you never pass this. 'reviewer' = the card judges someone else's work on this task: it is recorded with role reviewer (get_task `cards`/`verdicts`, the Fila's ' ↔ review' chip), the principal cardId is left on the implementer, and its brief is your free `brief` (the review order — what to check, where the diff is, how to report a verdict); the task prompt is NOT delivered, because a reviewer handed the work statement would start implementing. A reviewer spawned without `brief` opens linked but mute — send the order with send_to_card. To make an already-open card a reviewer instead, use link_task_card. Any value outside implementer/reviewer is REFUSED (no spawn).",
            ),
        },
      },
      async ({ provider, cwd, resumeId, model, effort, label, callerCardId, reason, wait, waitTimeoutMs, brief, taskId, role }) => {
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
          brief,
          taskId,
          role,
        });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "spawn_card",
      {
        description:
          "Create a non-terminal tool card (files explorer, git changes, sticky note, embedded browser, remote window, or the board's task queue) on the board. `kind: \"task\"` is a singleton per board: when that board already has a live queue card, this call succeeds by returning its cardId instead of creating another. `kind: \"sticky\"` is created immediately, no approval needed (same risk class as write_sticky — reversible, no disk/process side effect). Every other kind still requires human approval unless the board is in autonomous mode. `kind: \"browser\"` always opens a NEW browser card (never reuses one you already own) — use this when you need a second window alongside one opened via open_url; pass `reuse: true` only if you intentionally want open_url's navigate-existing behavior instead. By default the card lands wherever centeredSlot picks (viewport center, nudged to avoid overlap); pass `anchorCardId`+`side` to place it right next to a specific existing card instead (e.g. next to a files card you already have open).",
        inputSchema: {
          kind: z.enum(["files", "changes", "sticky", "browser", "remote-window", "task"]).describe("Which card kind to create; task reuses the board's existing live queue card; browser always creates a new card unless reuse:true"),
          cwd: z.string().optional().describe("Root path — used by files/changes kinds, defaults to the board's root"),
          url: z.string().optional().describe("URL — used by the browser kind"),
          reuse: z
            .boolean()
            .optional()
            .describe(
              "Only meaningful for kind:\"browser\". Default false: always create a new browser card. Set true to navigate your existing browser instead (same as open_url's default).",
            ),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var). Normally omit it — the server already knows which card you are from the MCP URL registered for your process."),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
          anchorCardId: z.string().optional().describe("Place the new card right next to this existing card (see list_cards) instead of the default centered placement"),
          side: z.enum(["left", "right", "top", "bottom"]).optional().describe("Which side of anchorCardId to place the new card on. Defaults to \"right\" when anchorCardId is given. Ignored without anchorCardId."),
        },
      },
      async ({ kind, cwd, url, reuse, callerCardId, reason, anchorCardId, side }) => {
        const requesterId = caller(callerCardId);
        // DESIGN-BACKLOG.md §2.0 item 5 — spawn_card browser defaults to a
        // fresh card; reuse:true opts into open_url's navigate-existing path.
        if (kind === "browser" && reuse === true) {
          if (!url) {
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "url is required when reuse:true" }) }] };
          }
          const res = await opts.handleRequest({ cmd: "open", url, requesterId, reason });
          return { content: [{ type: "text", text: JSON.stringify(res) }] };
        }
        const res = await opts.handleRequest({ cmd: "spawn_card", kind, cwd, url, requesterId, reason, anchorCardId, side });
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

    // DESIGN-BACKLOG.md §3.0 fatia 1 — intra-repo reach from hunks.
    // Runs in this process (no bus cmd, no persist, no UI). Do not route
    // through handleRequest: this does not touch board/task state, and
    // another change is in flight on update_task in this same file.
    server.registerTool(
      "reach_from_hunks",
      {
        description:
          "Given diff hunks (added AND removed lines), search the same repository for other textual occurrences of the identifiers and string literals those hunks touched. The seed is the hunk text, never the file — \"who consumes store.ts\" is almost the whole repo and is the wrong question. Removed hunks count the same as added ones: that is how \"someone deleted the call and the other side stayed open\" lights up. Runs on the dirty working tree (no HEAD cache). Read-only; nothing is persisted. " +
          "Returns three blocks: (1) evidence — file:line hits, not a complete set of affected sites; (2) scanned — root, files walked, seeds extracted; (3) incompleteness — mandatory and query-specific: what this scan could not resolve and why. A list here does NOT mean \"these are the affected\" — aliases, re-exports, computed names, and concatenated/interpolated strings are not followed. Always read incompleteness before acting. " +
          "Empty evidence is status `sem_referencia`, never success. Do not read that as \"nothing is affected\"; it means this scan found no textual reference it could resolve.",
        inputSchema: {
          cwd: z.string().describe("Absolute path of the repository root to search (the dirty working tree, not HEAD)"),
          hunks: z
            .array(
              z.object({
                file: z.string().describe("Path of the changed file, relative to cwd — metadata only; it is never turned into a seed"),
                added: z.array(z.string()).optional().describe("Added lines from the hunk (with or without a leading +)"),
                removed: z.array(z.string()).optional().describe("Removed lines from the hunk (with or without a leading -). Count equally with added lines."),
              }),
            )
            .describe("Hunks from the diff. Seed extraction uses these lines only, not the rest of each file."),
        },
      },
      async ({ cwd, hunks }) => {
        const res = await reachFromHunks({ cwd, hunks });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    // DESIGN-BACKLOG.md §3.0 fatia 2 — cross-repo join of normalized literals.
    // Same process-local pattern as reach_from_hunks: no bus cmd, no persist, no UI.
    server.registerTool(
      "reach_across_literals",
      {
        description:
          "Given diff hunks (added AND removed lines), extract the STRING LITERALS those hunks touched and look for the same literals — after normalization — in the other repositories listed by ai/workspace.yaml (found by walking up from cwd). No symbol crosses a repository boundary; what crosses is a literal written on both sides (the Laravel route written again in the client). " +
          "Normalization collapses `{plan}`, `${planId}`, `{$id}`, `:plan` to a common `{_}` so `/plans/{plan}/coverage/reconcile` joins `/plans/${planId}/coverage/reconcile`. Results are ORDERED BY SPECIFICITY: a long path shared across two trees is a strong signal; a short field name like `status` matching two payloads is noise, not a denylist drop. Mechanical, never curated per repository. " +
          "A declared contract (docs/contracts, canonical_sources) is a confidence reinforcement on an already-found join (`contractReinforced`) and NEVER a prerequisite — the tool has to work on a repository with no documentation. " +
          "Returns three blocks: (1) joins — file:line hits, most specific first, not a complete set of consumers; (2) scanned — catalog, projects walked, seeds; (3) incompleteness — mandatory. Known gaps that are always declared: a URL built by concatenation disappears (false negative); a generic field name matches unrelated payloads (false positive). Empty joins is status `sem_referencia`, never success.",
        inputSchema: {
          cwd: z.string().describe("Absolute path of the repository the hunks came from. Used to find ai/workspace.yaml by walking up, and to skip the producer file. Dirty tree, not HEAD."),
          hunks: z
            .array(
              z.object({
                file: z.string().describe("Path of the changed file, relative to cwd — metadata only; used to skip that file as a hit, never turned into a seed"),
                added: z.array(z.string()).optional().describe("Added lines from the hunk (with or without a leading +)"),
                removed: z.array(z.string()).optional().describe("Removed lines from the hunk (with or without a leading -). Count equally with added lines."),
              }),
            )
            .describe("Hunks from the diff. Only literals from these lines are seeded; identifiers are ignored."),
          catalogPath: z
            .string()
            .optional()
            .describe("Absolute path to ai/workspace.yaml. Omit to discover it by walking up from cwd."),
        },
      },
      async ({ cwd, hunks, catalogPath }) => {
        const res = await reachAcrossLiterals({ cwd, hunks, catalogPath });
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

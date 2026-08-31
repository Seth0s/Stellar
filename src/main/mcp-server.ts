import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod";
import type { BusRequest, BusResponse } from "./message-bus";

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
  function buildServer(): McpServer {
    const server = new McpServer({ name: "stellar", version: "1.0.0" });

    server.registerTool(
      "list_cards",
      {
        description: "List every open terminal card on the current board (id, provider, cwd). Use a card's id as the `target` for send_to_card, snapshot, or spawn_agent's requesterId.",
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
          target: z.string().describe("The target card's id (see list_cards)"),
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
        const res = await opts.handleRequest({ cmd: "send", target, text, requesterId: callerCardId });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "read_card",
      {
        description:
          "Read a terminal card's live scrollback as plain text — what's actually on screen (and above it), not a screenshot. Use this to check on a card you spawned or sent a message to.",
        inputSchema: {
          target: z.string().describe("The target card's id (see list_cards)"),
          lines: z.number().optional().describe("Only the last N lines of scrollback — omit for the full buffer"),
        },
      },
      async ({ target, lines }) => {
        const res = await opts.handleRequest({ cmd: "read_card", target, lines });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "card_status",
      {
        description:
          "Check whether a terminal card's process is running, exited, or blocked waiting on a consent decision (e.g. an open_url/spawn_agent/spawn_card call it made that a human hasn't approved or denied yet) — a cheap alternative to polling snapshot/read_card in a loop.",
        inputSchema: {
          target: z.string().describe("The target card's id (see list_cards)"),
        },
      },
      async ({ target }) => {
        const res = await opts.handleRequest({ cmd: "card_status", target });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "report",
      {
        description:
          "Report a structured result back to whoever spawned you, decoupled from process exit — call this when you finish a delegated task, even if you keep running afterward. The caller reads it with read_report, no ANSI/scrollback parsing needed. Requires your own card id.",
        inputSchema: {
          callerCardId: z.string().describe("Your own card id (AGENT_CANVAS_CARD_ID env var) — required, this IS the report's identity"),
          report: z.unknown().describe("Any JSON value — e.g. {ok: true, result: '...'} or {ok: false, error: '...'}"),
        },
      },
      async ({ callerCardId, report }) => {
        const res = await opts.handleRequest({ cmd: "report", requesterId: callerCardId, report });
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
        description: "Ask the human to open a URL in an embedded browser card. Requires human approval — this call blocks until they decide (or ~2 minutes pass).",
        inputSchema: {
          url: z.string().describe("The URL to open"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var), so the human sees who's asking"),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
        },
      },
      async ({ url, callerCardId, reason }) => {
        const res = await opts.handleRequest({ cmd: "open", url, requesterId: callerCardId, reason });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "spawn_agent",
      {
        description:
          "Ask the human to spawn ANOTHER agent/terminal card (a second provider working alongside you). Requires human approval, and is refused outright past a small recursion depth (an agent spawning an agent spawning an agent...) — the server tracks this itself from `callerCardId`'s own real depth, so there's nothing to declare or get wrong here (pre-release audit S4 — depth used to be a caller-supplied number, so a spawned agent could just re-claim depth 0 on its next call).",
        inputSchema: {
          provider: z.enum(["bash", "claude", "codex", "cursor", "antigravity"]).describe("Which provider to spawn"),
          cwd: z.string().optional().describe("Working directory — defaults to the current board's root"),
          resumeId: z.string().optional().describe("Resume an existing session instead of starting fresh"),
          model: z.string().optional().describe("Model to launch the provider with (its own --model value, e.g. 'opus', 'gpt-5-codex') — omit to use that provider's default"),
          label: z.string().optional().describe("Name the new card (DESIGN-BACKLOG.md item 62) — same free-text field a human sets by renaming a card's tag. Omit to get the default ordinal-per-provider label instead."),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var) — also how the server looks up YOUR real spawn depth server-side, to compute the new card's depth. Omit only if you're not sure, in which case this call is treated as a fresh chain (depth 0)."),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
          wait: z
            .boolean()
            .optional()
            .describe("Hold this call open until the spawned card's process exits, instead of returning as soon as it starts (default 10 minutes, see waitTimeoutMs)"),
          waitTimeoutMs: z.number().optional().describe("Override the default wait window (10 minutes) when wait is true"),
        },
      },
      async ({ provider, cwd, resumeId, model, label, callerCardId, reason, wait, waitTimeoutMs }) => {
        const res = await opts.handleRequest({
          cmd: "spawn_agent",
          provider,
          cwd,
          resumeId,
          requesterId: callerCardId,
          reason,
          model,
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
        description: "Ask the human to create a non-terminal tool card (files explorer, git changes, sticky note, embedded browser, or remote window) on the board. Requires human approval.",
        inputSchema: {
          kind: z.enum(["files", "changes", "sticky", "browser", "remote-window"]).describe("Which card kind to create"),
          cwd: z.string().optional().describe("Root path — used by files/changes kinds, defaults to the board's root"),
          url: z.string().optional().describe("URL — used by the browser kind"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var)"),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
        },
      },
      async ({ kind, cwd, url, callerCardId, reason }) => {
        const res = await opts.handleRequest({ cmd: "spawn_card", kind, cwd, url, requesterId: callerCardId, reason });
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      },
    );

    server.registerTool(
      "snapshot",
      {
        description: "See a screenshot of a specific card, an explicit board rect, or the whole window — returned as an embedded image, not a file path (MCP clients don't share this app's filesystem).",
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
        inputSchema: { target: z.string().describe("The browser card's id (see list_cards; note: only terminal cards show there — you likely already have the id from spawn_card's response)") },
      },
      async ({ target }) => {
        const res = await opts.handleRequest({ cmd: "get_page_text", target });
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
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const server = buildServer();
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

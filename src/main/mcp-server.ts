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
        },
      },
      async ({ target, text }) => {
        const res = await opts.handleRequest({ cmd: "send", target, text });
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
          "Ask the human to spawn ANOTHER agent/terminal card (a second provider working alongside you). Requires human approval, and is refused outright past a small recursion depth (an agent spawning an agent spawning an agent...) — pass `depth` from your own AGENT_CANVAS_SPAWN_DEPTH environment variable so that guard actually works; omitting it always looks like depth 0 to the server.",
        inputSchema: {
          provider: z.enum(["bash", "claude", "codex", "cursor", "gemini"]).describe("Which provider to spawn"),
          cwd: z.string().optional().describe("Working directory — defaults to the current board's root"),
          resumeId: z.string().optional().describe("Resume an existing session instead of starting fresh"),
          model: z.string().optional().describe("Model to launch the provider with (its own --model value, e.g. 'opus', 'gpt-5-codex') — omit to use that provider's default"),
          callerCardId: z.string().optional().describe("Your own card id (AGENT_CANVAS_CARD_ID env var)"),
          depth: z
            .number()
            .optional()
            .describe("Your own AGENT_CANVAS_SPAWN_DEPTH env var, as a number — omit only if you're not sure, in which case this is treated as a fresh chain (0)"),
          reason: z.string().optional().describe("Why you want this — shown to the human in the approval dialog"),
          wait: z
            .boolean()
            .optional()
            .describe("Hold this call open until the spawned card's process exits, instead of returning as soon as it starts (default 10 minutes, see waitTimeoutMs)"),
          waitTimeoutMs: z.number().optional().describe("Override the default wait window (10 minutes) when wait is true"),
        },
      },
      async ({ provider, cwd, resumeId, model, callerCardId, depth, reason, wait, waitTimeoutMs }) => {
        const res = await opts.handleRequest({
          cmd: "spawn_agent",
          provider,
          cwd,
          resumeId,
          requesterId: callerCardId,
          reason,
          depth: depth ?? 0,
          model,
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

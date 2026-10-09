import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import {
  RelaySession,
  createRelayServer,
  extractJsonLine,
  httpRelayForwarder,
  relayEnabled,
  relaySocketPath,
} from "../../src/main/mcp-relay";

describe("relayEnabled — o bridge é PADRÃO (task 52c895da)", () => {
  it("ausente LIGA; só `0` desliga; qualquer outro valor liga", () => {
    expect(relayEnabled({})).toBe(true);
    expect(relayEnabled({ AGENT_CANVAS_MCP_RELAY: "0" })).toBe(false);
    expect(relayEnabled({ AGENT_CANVAS_MCP_RELAY: "1" })).toBe(true);
    expect(relayEnabled({ AGENT_CANVAS_MCP_RELAY: "qualquer" })).toBe(true);
  });
});

describe("relaySocketPath — derivado da porta do MCP, sem variável nova", () => {
  it("URL local válida => caminho com a porta", () => {
    expect(relaySocketPath("/tmp", "http://127.0.0.1:8799/mcp")).toBe(join("/tmp", "stellar-mcp-relay-8799.sock"));
  });

  it("query string na URL não muda o socket (identidade não vem de ?card=)", () => {
    const a = relaySocketPath("/tmp", "http://127.0.0.1:5000/mcp");
    const b = relaySocketPath("/tmp", "http://127.0.0.1:5000/mcp?card=1");
    expect(a).toBe(b);
  });

  it("localhost conta como local", () => {
    expect(relaySocketPath("/t", "http://localhost:1234/mcp")).toBe(join("/t", "stellar-mcp-relay-1234.sock"));
  });

  it("sem porta, host remoto, https ou URL inválida => null (nada a rotear)", () => {
    expect(relaySocketPath("/tmp", "http://127.0.0.1/mcp")).toBeNull();
    expect(relaySocketPath("/tmp", "http://example.com:9/mcp")).toBeNull();
    expect(relaySocketPath("/tmp", "https://127.0.0.1:9/mcp")).toBeNull();
    expect(relaySocketPath("/tmp", "not a url")).toBeNull();
  });
});

describe("RelaySession — framing NDJSON without client-declared identity", () => {
  it("every complete line is a message; identity is not taken from the stream", () => {
    const s = new RelaySession();
    const first = s.push('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    expect(first).toEqual({ messages: [{ line: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }] });
  });

  it("linha cortada em chunks fica no buffer", () => {
    const s = new RelaySession();
    const a = s.push('{"jsonrpc":"2.0","id":1,"met');
    expect(a.messages).toEqual([]);
    const b = s.push('hod":"ping"}\n');
    expect(b.messages).toEqual([{ line: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }]);
  });

  it("linhas em branco são ignoradas; duas mensagens no mesmo chunk saem na ordem", () => {
    const s = new RelaySession();
    const r = s.push('\n{"a":1}\n{"b":2}\n');
    expect(r.messages).toEqual([{ line: '{"a":1}' }, { line: '{"b":2}' }]);
  });

  it("sem newline e acima do teto => erro em vez de crescer sem limite", () => {
    const s = new RelaySession(32);
    expect(s.push("x".repeat(64))).toEqual({ messages: [], error: "relay line exceeds max length" });
  });
});

describe("extractJsonLine — a resposta HTTP volta a UMA linha stdio", () => {
  it("JSON puro vira linha compacta", () => {
    expect(extractJsonLine('{"jsonrpc":"2.0","id":1,"result":{}}')).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
  });

  it("frame SSE: acha a linha `data:` mesmo com keepalive antes (não assume a primeira)", () => {
    const sse = ': keepalive\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n';
    expect(extractJsonLine(sse)).toBe('{"jsonrpc":"2.0","id":2,"result":{}}');
  });

  it("corpo vazio ou ilegível => null (notificação / nada a devolver)", () => {
    expect(extractJsonLine("")).toBeNull();
    expect(extractJsonLine("   \n")).toBeNull();
    expect(extractJsonLine("nao e json")).toBeNull();
  });
});

describe("httpRelayForwarder — Bearer + caller header, never ?card=", () => {
  let server: Server | null = null;
  let url = "";

  async function start(
    handler: (body: string, headers: Record<string, string | string[] | undefined>, query: URLSearchParams) => string | null,
    contentType = "application/json",
  ) {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
        const out = handler(body, req.headers as Record<string, string | string[] | undefined>, parsed.searchParams);
        if (out === null) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { "content-type": contentType });
        res.end(out);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server!.address();
    url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}/mcp` : "";
  }

  afterEach(() => {
    server?.close();
    server = null;
  });

  it("forwards with Authorization Bearer and x-stellar-caller-card", async () => {
    let seenAuth: string | null = null;
    let seenCaller: string | null = null;
    let seenCardQuery: string | null = null;
    let seenBody = "";
    await start((body, headers, query) => {
      seenAuth = typeof headers.authorization === "string" ? headers.authorization : null;
      seenCaller = typeof headers["x-stellar-caller-card"] === "string" ? headers["x-stellar-caller-card"] : null;
      seenCardQuery = query.get("card");
      seenBody = body;
      return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    });
    const line = await httpRelayForwarder(
      () => url,
      () => "internal-token",
    )({ cardId: "card-7", boardId: "board-a" }, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(seenAuth).toBe("Bearer internal-token");
    expect(seenCaller).toBe("card-7");
    expect(seenCardQuery).toBeNull();
    expect(JSON.parse(seenBody).method).toBe("tools/list");
    expect(line).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
  });

  it("resposta SSE volta como UMA linha; corpo vazio => null", async () => {
    await start((_body) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })}\n\n`, "text/event-stream");
    const sse = await httpRelayForwarder(
      () => url,
      () => "t",
    )({ cardId: "c", boardId: null }, '{"id":2}');
    expect(sse).toBe('{"jsonrpc":"2.0","id":2,"result":{}}');

    server?.close();
    await start(() => null);
    expect(
      await httpRelayForwarder(
        () => url,
        () => "t",
      )(null, '{"method":"notifications/initialized"}'),
    ).toBeNull();
  });
});

describe("createRelayServer — round-trip real pelo Unix socket", () => {
  let dir: string | null = null;
  let relay: { close: () => void } | null = null;

  afterEach(() => {
    relay?.close();
    relay = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("NDJSON lines reach the forwarder; peer identity is resolved per message", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-relay-"));
    const socketPath = join(dir, "relay.sock");
    const seen: Array<[string | null, string]> = [];
    relay = createRelayServer({
      socketPath,
      getMcpUrl: () => "http://127.0.0.1:1/mcp",
      getInternalToken: () => "tok",
      resolvePeerIdentity: () => ({ cardId: "c42", boardId: "b1" }),
      getPeerPid: () => 4242,
      forward: async (identity, line) => {
        seen.push([identity?.cardId ?? null, line]);
        return JSON.stringify({ echo: line });
      },
    });

    const socket = connect({ path: socketPath });
    const received: string[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) received.push(l);
    });

    socket.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    socket.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');

    const deadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    socket.destroy();

    expect(seen).toEqual([
      ["c42", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
      ["c42", '{"jsonrpc":"2.0","id":2,"method":"ping"}'],
    ]);
    expect(received).toEqual([
      '{"echo":"{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/list\\"}"}',
      '{"echo":"{\\"jsonrpc\\":\\"2.0\\",\\"id\\":2,\\"method\\":\\"ping\\"}"}',
    ]);
  });

  it("missing peer credentials still forwards as anonymous (never accept stream-declared identity)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-relay-"));
    const socketPath = join(dir, "relay.sock");
    const seen: Array<string | null> = [];
    relay = createRelayServer({
      socketPath,
      getMcpUrl: () => "http://127.0.0.1:1/mcp",
      getInternalToken: () => "tok",
      getPeerPid: () => null,
      forward: async (identity, line) => {
        seen.push(identity?.cardId ?? null);
        return JSON.stringify({ ok: true, line });
      },
    });

    const socket = connect({ path: socketPath });
    const received: string[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) received.push(l);
    });
    socket.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    const deadline = Date.now() + 3000;
    while (received.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    socket.destroy();
    expect(seen).toEqual([null]);
    expect(received).toHaveLength(1);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";

/**
 * Regression for the 2026-09-15 bug: the MCP `report` tool declares its
 * payload `z.unknown()`, so a model can deliver it as a JSON **string**.
 * That string reached `decideReportAcceptance` as a non-object and, when
 * the task declared a reportSchema starting with `ok`, was refused with
 * "report.ok must be a boolean" — a message that lied about the cause.
 *
 * This talks to the real `createMcpServer` over HTTP with the SDK client
 * and pins the boundary behaviour: a JSON-encoded object is decoded
 * before it reaches the bus (so acceptance AND persistence see the
 * object), while anything that is not a JSON object passes through.
 */
describe("mcp-server: report argument envelope", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  const seen: BusRequest[] = [];

  beforeAll(async () => {
    server = createMcpServer({
      port: 0,
      handleRequest: async (req: BusRequest): Promise<BusResponse> => {
        seen.push(req);
        return { ok: true, echoed: req };
      },
    });
    // `listen(0)` binds asynchronously; the url getter updates on "listening".
    await new Promise<void>((resolve) => {
      const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
      tick();
    });
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  it("decodes a JSON-string object so the bus receives the object", async () => {
    seen.length = 0;
    await client.callTool({ name: "report", arguments: { report: '{"ok":true}' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].cmd).toBe("report");
    expect(seen[0].report).toEqual({ ok: true });
    expect(typeof seen[0].report).toBe("object");
  });

  it("passes an object argument through unchanged", async () => {
    seen.length = 0;
    await client.callTool({ name: "report", arguments: { report: { ok: true, files: ["a"] } } });
    expect(seen[0].report).toEqual({ ok: true, files: ["a"] });
  });

  it("leaves a non-JSON string untouched (a legal free-form report)", async () => {
    seen.length = 0;
    await client.callTool({ name: "report", arguments: { report: "done, see notes" } });
    expect(seen[0].report).toBe("done, see notes");
  });
});
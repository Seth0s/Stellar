import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";
import { REPORT_ESTADO_AGENT_HINT } from "../../src/main/report-estado-decision";
import { ACBRIDGE_HINT } from "../../src/main/providers";
import { AGENT_SCROLLBACK_DISCOVERY_TIP } from "../../src/main/bash-discovery-decision";
import seedJson from "../../src/main/data/board-context.seed.json";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent-facing report contract must name `estado` everywhere the agent looks:
 * MCP tool description, payload field describe, ACBRIDGE_HINT, scrollback tip,
 * board-context seed rules, and acbridge CLI usage. Without this, every report
 * stays parcial (estado omitted). close_card never concludes either way.
 */
describe("report tool description cites estado", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;

  beforeAll(async () => {
    server = createMcpServer({
      port: 0,
      requireIdentity: false,
      handleRequest: async (_req: BusRequest): Promise<BusResponse> => ({ ok: true }),
    });
    await new Promise<void>((resolve) => {
      const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
      tick();
    });
    client = new Client({ name: "unit-report-estado-desc", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  it("MCP report tool description names estado parcial|final and decisaoTomada ASAP", async () => {
    const { tools } = await client.listTools();
    const report = tools.find((t) => t.name === "report");
    expect(report).toBeDefined();
    const desc = report!.description ?? "";
    expect(desc).toContain("estado");
    expect(desc).toMatch(/parcial/);
    expect(desc).toMatch(/final/);
    expect(desc).toContain("decisaoTomada");
    expect(desc).toContain(REPORT_ESTADO_AGENT_HINT.slice(0, 40));

    const props = (report!.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;
    const payloadDesc = props.report?.description ?? "";
    expect(payloadDesc).toContain("estado");
    expect(payloadDesc).toMatch(/parcial/);
    expect(payloadDesc).toMatch(/final/);
  });

  it("MCP close_card description says it NEVER concludes a task", async () => {
    const { tools } = await client.listTools();
    const close = tools.find((t) => t.name === "close_card");
    expect(close).toBeDefined();
    const desc = close!.description ?? "";
    expect(desc).toMatch(/NEVER concludes/i);
    expect(desc).toContain("releasedTasks");
    expect(desc).not.toMatch(/concluded as done/);
  });

  it("ACBRIDGE_HINT, scrollback tip, seed rule, and acbridge CLI name estado", () => {
    expect(ACBRIDGE_HINT).toContain("estado");
    expect(ACBRIDGE_HINT).toMatch(/parcial/);
    expect(ACBRIDGE_HINT).toMatch(/final/);
    expect(ACBRIDGE_HINT).toContain("decisaoTomada");

    expect(AGENT_SCROLLBACK_DISCOVERY_TIP).toContain("estado");
    expect(AGENT_SCROLLBACK_DISCOVERY_TIP).toMatch(/parcial/);
    expect(AGENT_SCROLLBACK_DISCOVERY_TIP).toMatch(/final/);

    const rules = (seedJson.rules ?? []) as Array<{ text?: string }>;
    const estadoRule = rules.find((r) => (r.text ?? "").includes('estado "parcial"'));
    expect(estadoRule?.text).toMatch(/final/);
    expect(estadoRule?.text).toContain("decisaoTomada");

    const acbridge = readFileSync(join(process.cwd(), "resources/bin/acbridge"), "utf8");
    expect(acbridge).toContain('estado: "parcial" | "final"');
    expect(acbridge).toContain("decisaoTomada");
    expect(acbridge).toContain("REPORT_PAYLOAD_NOTE");
  });
});

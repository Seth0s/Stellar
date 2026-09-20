import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";

/**
 * The MCP surface is what makes a field EXIST for an agent that never
 * read this repo (lesson of `retryable: false` and `verdict`). This file
 * talks to the real `createMcpServer` over HTTP with the SDK client and
 * fixes, at the schema layer:
 *  - create_task exposes `purpose` as the closed enum, with a description
 *    that says what each value means and what omitting does;
 *  - update_task has NO `purpose` (write-once), and a `purpose` key sent
 *    anyway never reaches the bus;
 *  - spawn_agent exposes `role`; link_task_card exists with `role`;
 *  - an out-of-enum value is refused by zod before the bus sees it.
 */
describe("mcp-server: purpose / role on the tool surface", () => {
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

  type Schema = { properties?: Record<string, { enum?: string[]; description?: string }> };
  async function schemaOf(name: string): Promise<Schema> {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    expect(tool, `tool ${name} must be registered`).toBeDefined();
    return tool!.inputSchema as Schema;
  }

  it("create_task.purpose: enum fechado, descrição diz o que cada valor é, quando omitir e que é write-once", async () => {
    const schema = await schemaOf("create_task");
    const purpose = schema.properties?.purpose;
    expect(purpose).toBeDefined();
    // A lista vem da FONTE ÚNICA (`src/task-purpose.ts`); o tsc também
    // impede `PURPOSE_I18N` de ficar sem a chave nova.
    expect(purpose!.enum).toEqual(["investigate", "implement", "measure", "fix", "integrate"]);
    const d = purpose!.description ?? "";
    for (const word of ["investigate", "implement", "measure", "fix", "integrate", "WRITE-ONCE", "Omit", "REFUSED", "role"]) {
      expect(d, `description must mention ${word}`).toContain(word);
    }
  });

  it("update_task NÃO expõe purpose, e um purpose enviado mesmo assim não chega ao bus", async () => {
    const schema = await schemaOf("update_task");
    expect(schema.properties?.purpose).toBeUndefined();
    seen.length = 0;
    const res = await client.callTool({ name: "update_task", arguments: { taskId: "t1", status: "done", purpose: "fix" } });
    expect(res.isError ?? false).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].cmd).toBe("update_task");
    expect("purpose" in seen[0]).toBe(false);
  });

  it("create_task com purpose fora do enum: recusado pelo schema, o bus nunca é chamado", async () => {
    seen.length = 0;
    const res = await client.callTool({ name: "create_task", arguments: { prompt: "x", purpose: "banana" } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("create_task com purpose válido chega ao bus como está; omitido chega undefined", async () => {
    seen.length = 0;
    await client.callTool({ name: "create_task", arguments: { prompt: "x", purpose: "measure" } });
    await client.callTool({ name: "create_task", arguments: { prompt: "y" } });
    expect(seen.map((r) => (r as { purpose?: string }).purpose)).toEqual(["measure", undefined]);
  });

  it("create_task.review: enum wanted, omitido=undefined; update_task aceita wanted|null", async () => {
    const createSchema = await schemaOf("create_task");
    expect(createSchema.properties?.review?.enum).toEqual(["wanted"]);
    const updateSchema = await schemaOf("update_task");
    // nullable → JSON Schema anyOf, not a top-level enum
    const reviewProp = updateSchema.properties?.review as { anyOf?: Array<{ enum?: string[] }> } | undefined;
    expect(reviewProp).toBeDefined();
    const wantedBranch = reviewProp!.anyOf?.find((b) => b.enum?.includes("wanted"));
    expect(wantedBranch?.enum).toEqual(["wanted"]);
    seen.length = 0;
    await client.callTool({ name: "create_task", arguments: { prompt: "x", review: "wanted" } });
    expect((seen[0] as { review?: string }).review).toBe("wanted");
    const bad = await client.callTool({ name: "create_task", arguments: { prompt: "x", review: "none" } });
    expect(bad.isError).toBe(true);
    seen.length = 0;
    await client.callTool({ name: "update_task", arguments: { taskId: "t1", review: "wanted" } });
    expect(seen[0]).toMatchObject({ cmd: "update_task", review: "wanted" });
    await client.callTool({ name: "update_task", arguments: { taskId: "t1", review: null } });
    expect((seen[1] as { review: unknown }).review).toBeNull();
  });

  it("spawn_agent.role: enum implementer|reviewer, descrição diz o default, o que reviewer muda e o que é recusado", async () => {
    const schema = await schemaOf("spawn_agent");
    const role = schema.properties?.role;
    expect(role).toBeDefined();
    expect(role!.enum).toEqual(["implementer", "reviewer"]);
    const d = role!.description ?? "";
    for (const word of ["taskId", "implementer", "reviewer", "Omit", "brief", "REFUSED", "link_task_card"]) {
      expect(d, `description must mention ${word}`).toContain(word);
    }
    seen.length = 0;
    // `reason` passou a ser OBRIGATÓRIO em spawn de agente (registro de
    // spawn, ce2e05f8): é o único campo que o app não consegue derivar.
    // Sem ele a chamada é recusada antes de chegar ao bus.
    await client.callTool({
      name: "spawn_agent",
      arguments: { provider: "claude", taskId: "t1", role: "reviewer", brief: "review it", reason: "revisar a entrega" },
    });
    expect(seen[0]).toMatchObject({ cmd: "spawn_agent", taskId: "t1", role: "reviewer", brief: "review it" });
    const bad = await client.callTool({
      name: "spawn_agent",
      arguments: { provider: "claude", taskId: "t1", role: "observer", reason: "x" },
    });
    expect(bad.isError).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("link_task_card existe, com taskId/cardId obrigatórios e role opcional no mesmo enum", async () => {
    const schema = await schemaOf("link_task_card");
    expect(schema.properties?.role?.enum).toEqual(["implementer", "reviewer"]);
    expect((schema as { required?: string[] }).required).toEqual(expect.arrayContaining(["taskId", "cardId"]));
    seen.length = 0;
    await client.callTool({ name: "link_task_card", arguments: { taskId: "t1", cardId: "c9", role: "reviewer" } });
    expect(seen[0]).toMatchObject({ cmd: "link_task_card", taskId: "t1", cardId: "c9", role: "reviewer" });
    await client.callTool({ name: "link_task_card", arguments: { taskId: "t1", cardId: "c9" } });
    expect((seen[1] as { role?: string }).role).toBeUndefined();
  });
});

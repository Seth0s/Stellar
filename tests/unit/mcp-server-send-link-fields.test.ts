import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";

/**
 * Task 23bed0fb — FECHAR O PRÓPRIO CONSERTO: expor `linkTaskId`/`linkRole` na
 * tool `send_to_card`.
 *
 * A mecânica já estava fechada e provada no BARRAMENTO (fb8fa82): `cmd:"send"`
 * aceita o par e cria o vínculo pela porta de autoria existente. Mas a tool não
 * expunha os campos — então nem a tool MCP nem o CLI do acbridge conseguiam
 * exercer o caminho, e o cenário que prendeu SEIS tasks continuava ponta-a-ponta.
 *
 * Aqui, PELO CAMINHO DA TOOL: com o par, ele CHEGA ao barramento (é ele que
 * cria o vínculo, provado do outro lado); sem o par, NADA é enviado — o papel
 * nunca é inferido.
 */

describe("mcp-server: `send_to_card` expõe o par de vínculo (task 23bed0fb)", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  const seen: BusRequest[] = [];
  const MCP_INTERNAL = "unit-send-link-internal-token";
  const CALLER = "orch-card";

  beforeAll(async () => {
    server = createMcpServer({
      port: 0,
      internalToken: MCP_INTERNAL,
      requireIdentity: false,
      resolveRelayIdentity: (cardId) => ({ cardId, boardId: "default" }),
      handleRequest: async (req: BusRequest): Promise<BusResponse> => {
        seen.push(req);
        return { ok: true, delivery: "queued", id: "d1" };
      },
    });
    await new Promise<void>((resolve) => {
      const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
      tick();
    });
    client = new Client({ name: "send-link", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
          headers: {
            authorization: `Bearer ${MCP_INTERNAL}`,
            "x-stellar-caller-card": CALLER,
          },
        },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  const schemaOf = async (name: string) => {
    const res = (await client.listTools()) as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] };
    return res.tools.find((t) => t.name === name)!;
  };

  it("o schema EXPÕE `linkTaskId` e `linkRole`", async () => {
    const tool = await schemaOf("send_to_card");
    const props = Object.keys(tool.inputSchema.properties ?? {});
    expect(props).toContain("linkTaskId");
    expect(props).toContain("linkRole");
  });

  it("a descrição diz que SEM `linkRole` nada é vinculado (nunca se infere papel) e que o vínculo é o que AUTORIZA o veredito", async () => {
    const tool = await schemaOf("send_to_card");
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    expect(props.linkRole!.description).toMatch(/never inferred/i);
    expect(props.linkRole!.description).toMatch(/REFUSED/);
    expect(props.linkTaskId!.description).toMatch(/AUTHORIZ/i);
    expect(props.linkTaskId!.description).toMatch(/NOT a shortcut to bypass the gate/i);
  });

  it("COM o par: ele CHEGA ao barramento — é o barramento que cria o vínculo (fb8fa82)", async () => {
    seen.length = 0;
    await client.callTool({
      name: "send_to_card",
      arguments: { target: "rev-card", text: "revise a task", callerCardId: "orch-card", linkTaskId: "t1", linkRole: "reviewer" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cmd: "send", target: "rev-card", linkTaskId: "t1", linkRole: "reviewer" });
  });

  it("SEM o par: NADA é enviado além da entrega — nenhum papel é inferido", async () => {
    seen.length = 0;
    await client.callTool({ name: "send_to_card", arguments: { target: "rev-card", text: "só um recado" } });
    const req = seen[0] as { cmd: string; linkTaskId?: string; linkRole?: string };
    expect(req.cmd).toBe("send");
    expect("linkTaskId" in req).toBe(false);
    expect("linkRole" in req).toBe(false);
  });

  it("`linkRole` fora do enum é recusado pelo SCHEMA — o barramento nunca o vê", async () => {
    seen.length = 0;
    const res = (await client.callTool({
      name: "send_to_card",
      arguments: { target: "rev-card", text: "x", linkTaskId: "t1", linkRole: "chefe" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("um sem o outro CHEGA ao barramento — a recusa é dele, não da tool (a validação não foi afrouxada nem duplicada)", async () => {
    seen.length = 0;
    await client.callTool({ name: "send_to_card", arguments: { target: "rev-card", text: "x", linkTaskId: "t1" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ linkTaskId: "t1" });
    expect((seen[0] as { linkRole?: string }).linkRole).toBeUndefined();
  });
});

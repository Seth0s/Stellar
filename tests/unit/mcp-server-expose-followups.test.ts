import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";

/**
 * Task 4c122327 — EXPOR NO SCHEMA O QUE JÁ ESTAVA ENTREGUE NO BARRAMENTO.
 *
 * Dois follow-ups que os próprios implementadores pediram e não puderam fazer
 * por território: o PARÂMETRO `seq` do `read_report` (task d7fa2d58) e o
 * `spawnProfile` do `create_task` (task d14086f8) existiam só no protocolo cru.
 * Um agente que usa TOOLS não os via.
 *
 * Aqui se prova PELO CAMINHO DA TOOL (servidor real + cliente do SDK), que é a
 * única prova que interessa: o schema é o que faz o campo existir.
 */

describe("mcp-server: follow-ups expostos (task 4c122327)", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  const seen: BusRequest[] = [];

  beforeAll(async () => {
    server = createMcpServer({
      port: 0,
      requireIdentity: false,
      handleRequest: async (req: BusRequest): Promise<BusResponse> => {
        seen.push(req);
        if (req.cmd === "get_report" && req.seq !== undefined) {
          // O enriquecimento já chega do barramento; aqui só o ecoamos para a
          // tool poder ser conferida de ponta a ponta.
          return { ok: true, seq: req.seq, cardId: "97924064", taskIds: ["t-antes", "t-depois"], ambiguous: true };
        }
        return { ok: true, echoed: req };
      },
    });
    await new Promise<void>((resolve) => {
      const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
      tick();
    });
    client = new Client({ name: "expose-followups", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  const schemaOf = async (name: string) => {
    const res = (await client.listTools()) as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] };
    return res.tools.find((t) => t.name === name)!;
  };

  it("(1) `read_report` EXPÕE `seq` no schema — e o parâmetro chega ao barramento", async () => {
    const tool = await schemaOf("read_report");
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("seq");

    seen.length = 0;
    const res = (await client.callTool({ name: "read_report", arguments: { seq: 700 } })) as { content: { text: string }[] };
    // O parâmetro NÃO era alcançável por tool antes desta task; agora chega.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cmd: "get_report", seq: 700 });

    // E a resposta que a TOOL devolve carrega o `ambiguous` do barramento.
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; seq: number; cardId: string; taskIds: string[]; ambiguous: boolean };
    expect(body).toMatchObject({ ok: true, seq: 700, cardId: "97924064", ambiguous: true });
    expect(body.taskIds).toEqual(["t-antes", "t-depois"]);
  });

  it("`target` continua aceito (a leitura por slot não foi removida)", async () => {
    seen.length = 0;
    await client.callTool({ name: "read_report", arguments: { target: "97924064" } });
    expect(seen[0]).toMatchObject({ cmd: "get_report", target: "97924064" });
  });

  it("(2) `create_task` EXPÕE `spawnProfile` no schema — e o campo chega ao barramento", async () => {
    const tool = await schemaOf("create_task");
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("spawnProfile");

    seen.length = 0;
    await client.callTool({ name: "create_task", arguments: { prompt: "t", spawnProfile: "escala-recorrente" } });
    expect(seen.filter((r) => r.cmd === "create_task")).toHaveLength(1);
    expect((seen.find((r) => r.cmd === "create_task") as { spawnProfile?: string }).spawnProfile).toBe("escala-recorrente");
  });

  it("a descrição diz SUGESTÃO, não autorização, e que SEM declaração não há sugestão", async () => {
    const tool = await schemaOf("create_task");
    const d = ((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>).spawnProfile!.description!;
    expect(d).toMatch(/SUGGESTION/);
    expect(d).toMatch(/NEVER an authorization/);
    expect(d).toMatch(/NO DEFAULT/);
  });

  it("(3) LIMITE DECLARADO: `update_task` NÃO expõe spawnProfile — o barramento não o aceita lá", async () => {
    // O território desta task é mcp-server/acbridge/tests; `update_task` no
    // message-bus não conhece `spawnProfile`. Expor no schema um campo que o
    // barramento descarta seria o descarte silencioso que esta casa combate —
    // então NÃO se expõe, e isto fica travado aqui até o barramento aceitar.
    const tool = await schemaOf("update_task");
    expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("spawnProfile");
  });
});

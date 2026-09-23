import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";
import { buildToolInputSchema, declaredRequiredFields, describeReceived, fieldRefusal } from "../../src/main/tool-contract";
import * as z from "zod";

/**
 * ANTI-DRIFT — o schema PUBLICADO não pode divergir do contrato declarado
 * (task 197d09bd). Mesma técnica do `providers-dynamic-json-contract.test.ts`
 * da 64aed52b: percorre o que o cliente MCP recebe de verdade e confronta com
 * a declaração, em vez de confiar que os dois foram escritos iguais.
 *
 * Por que isto importa aqui: no SDK deste repo o schema publicado e o
 * validado são o MESMO objeto (`mcp.js:75-78` + `:172-174`), e o parse roda
 * ANTES do handler. Então a declaração gera o schema — e se alguém editar a
 * declaração e o schema publicado não mudar, este arquivo acusa.
 *
 * Os testes que falam com o servidor REAL pelo cliente do SDK são também a
 * prova do requisito "não interromper o turno": `callTool` NÃO lança numa
 * recusa — ela volta como resultado, que o modelo lê e corrige no mesmo turno.
 */

const REPORT_SCHEMA_TASK = {
  id: "T1",
  reportSchema: ["achados", "evidenciaMedida"],
  cards: [],
  review: null,
};

describe("tool-contract: declaração, recusa e o schema publicado", () => {
  describe("o módulo puro", () => {
    it("gera o shape da declaração: obrigatório não-opcional, opcional opcional, objeto estrito", () => {
      const shape = buildToolInputSchema({
        tool: "t",
        fields: [
          { name: "a", required: true, schema: z.string(), accepted: "uma string" },
          { name: "b", schema: z.string(), accepted: "uma string" },
        ],
      });
      const json = z.toJSONSchema(shape) as { required?: string[]; additionalProperties?: boolean };
      expect(json.required).toEqual(["a"]);
      expect(json.additionalProperties).toBe(false);
    });

    it("declaredRequiredFields é o lado declarado do invariante", () => {
      expect(
        declaredRequiredFields({
          tool: "t",
          fields: [
            { name: "a", required: true, schema: z.string(), accepted: "x" },
            { name: "b", schema: z.string(), accepted: "x" },
            { name: "c", required: true, schema: z.string(), accepted: "x" },
          ],
        }),
      ).toEqual(["a", "c"]);
    });

    it("a frase de recusa nomeia o CAMPO, o ACEITO e o RECEBIDO", () => {
      const msg = fieldRefusal({ tool: "t", field: "boardId", accepted: "o id de um board", got: "118" });
      expect(msg).toContain("`boardId`");
      expect(msg).toContain("o id de um board");
      expect(msg).toContain('"118"');
      expect(msg).toContain("nothing was written");
    });

    it("describeReceived distingue ausente de null, e não despeja um array gigante", () => {
      expect(describeReceived(undefined)).toBe("ausente");
      expect(describeReceived(null)).toBe("null");
      expect(describeReceived(["a", "b"])).toBe('["a","b"]');
      expect(describeReceived(new Array(50).fill("x"))).toBe("uma lista de 50 itens");
    });
  });

  describe("o schema publicado do servidor real", () => {
    let server: ReturnType<typeof createMcpServer>;
    let client: Client;
    const seen: BusRequest[] = [];

    beforeAll(async () => {
      server = createMcpServer({
        port: 0,
        handleRequest: async (req: BusRequest): Promise<BusResponse> => {
          seen.push(req);
          if (req.cmd === "get_task") return { ok: true, task: REPORT_SCHEMA_TASK };
          return { ok: true, received: req };
        },
      });
      await new Promise<void>((resolve) => {
        const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
        tick();
      });
      client = new Client({ name: "anti-drift", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    });

    afterAll(async () => {
      await client.close();
      server.close();
    });

    it("as tools migradas publicam `required` IGUAL ao declarado, e são estritas", async () => {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const expected: Record<string, { required: string[]; tool: string }> = {
        card_status: { tool: "card_status", required: ["target"] },
        report: { tool: "report", required: ["report"] },
      };
      for (const [name, spec] of Object.entries(expected)) {
        const schema = byName.get(name)?.inputSchema as
          | { required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> }
          | undefined;
        expect(schema, `${name} não está publicado`).toBeDefined();
        // O invariante: publicado == declarado. Se a declaração mudar e o
        // schema não, isto quebra aqui.
        expect(schema!.required ?? [], `${name}: required publicado`).toEqual(spec.required);
        expect(Object.keys(schema!.properties ?? {}).sort(), `${name}: campos publicados`).toEqual(
          name === "report" ? ["callerCardId", "report", "verdict"] : ["target"],
        );
        expect(schema!.additionalProperties, `${name}: estrito`).toBe(false);
      }
    });

    it("chave DESCONHECIDA é recusada em vez de descartada em silêncio, e o handler não roda", async () => {
      seen.length = 0;
      const res = (await client.callTool({ name: "card_status", arguments: { target: "c1", extra: 1 } as never })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      // O requisito do dono: volta como RESULTADO (não lança), acionável.
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('Unrecognized key: "extra"');
      // Nunca chegou ao bus: sem efeito colateral nenhum.
      expect(seen).toHaveLength(0);
    });

    it("campo obrigatório ausente é refused nomeando o campo — e a chamada não lança", async () => {
      seen.length = 0;
      const res = (await client.callTool({ name: "card_status", arguments: {} as never })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("target");
      expect(seen).toHaveLength(0);
    });

    it("a chamada VÁLIDA chega ao bus e volta sem isError", async () => {
      seen.length = 0;
      const res = (await client.callTool({ name: "card_status", arguments: { target: "c1" } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(res.isError).toBeFalsy();
      expect(seen).toHaveLength(1);
      expect(seen[0].cmd).toBe("card_status");
      expect(seen[0].target).toBe("c1");
    });
  });

  describe("report: a exigência DINÂMICA (o caso que o zod não alcança)", () => {
    let server: ReturnType<typeof createMcpServer>;
    let client: Client;
    const seen: BusRequest[] = [];

    beforeAll(async () => {
      server = createMcpServer({
        port: 0,
        handleRequest: async (req: BusRequest): Promise<BusResponse> => {
          seen.push(req);
          if (req.cmd === "get_task") return { ok: true, task: REPORT_SCHEMA_TASK };
          return { ok: true, accepted: true };
        },
      });
      await new Promise<void>((resolve) => {
        const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
        tick();
      });
      client = new Client({ name: "anti-drift-dynamic", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    });

    afterAll(async () => {
      await client.close();
      server.close();
    });

    const call = async (report: unknown) =>
      (await client.callTool({ name: "report", arguments: { report } })) as {
        isError?: boolean;
        content: { text: string }[];
      };

    it("chave declarada VAZIA é recusada — e o bus não vê o report", async () => {
      seen.length = 0;
      // O furo medido e documentado é a chave presente e VAZIA: presença ela
      // satisfaz, e o bus sozinho não a pega. (`"N/A"` e `[]` são os outros
      // tokens que a lista curta e deliberada de `judgment-write-decision`
      // recusa — a predição é injetada, não copiada.)
      const res = await call({ taskId: "T1", achados: "", evidenciaMedida: "12 verdes" });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      // A mensagem é a do contrato: nomeia as chaves, o aceito e o recebido.
      expect(body.error).toContain("`achados`");
      expect(body.error).toContain("real content");
      expect(body.error).toContain("T1");
      // Nenhum `report` chegou ao bus — só a leitura da task.
      expect(seen.filter((r) => r.cmd === "report")).toHaveLength(0);
    });

    it("token de placeholder (\"N/A\") e lista vazia também são refuseds", async () => {
      seen.length = 0;
      const res = await call({ taskId: "T1", achados: "N/A", evidenciaMedida: [] });
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: false });
      expect(seen.filter((r) => r.cmd === "report")).toHaveLength(0);
    });

    it("com conteúdo REAL nas duas chaves, passa e chega ao bus", async () => {
      seen.length = 0;
      const res = await call({ taskId: "T1", achados: "suíte 1915 verde", evidenciaMedida: "npx vitest run" });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true });
      expect(seen.filter((r) => r.cmd === "report")).toHaveLength(1);
    });

    it("falha DECLARADA (ok:false) pula as chaves — a regra existente é preservada", async () => {
      seen.length = 0;
      const res = await call({ taskId: "T1", ok: false, retryable: false });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true });
      expect(seen.filter((r) => r.cmd === "report")).toHaveLength(1);
    });

    it("sem taskId declarado a exigência dinâmica não opina — quem resolve a task é o bus", async () => {
      seen.length = 0;
      const res = await call({ achados: "placeholder" });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true });
      expect(seen.filter((r) => r.cmd === "report")).toHaveLength(1);
      // Nenhuma leitura de task: sem declaração não há o que conferir.
      expect(seen.filter((r) => r.cmd === "get_task")).toHaveLength(0);
    });

    it("report não-objeto continua passando pelo envelope — o bus é quem recusa isso", async () => {
      seen.length = 0;
      const res = await call("done, see notes");
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true });
      expect(seen.filter((r) => r.cmd === "report")).toHaveLength(1);
    });
  });
});

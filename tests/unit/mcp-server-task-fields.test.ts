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
 *    anyway is REFUSED by name at the top-level shape (before 2026-09-20 it
 *    was accepted and silently dropped — see mcp-server-strict-shape.test.ts);
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

  it("update_task NÃO expõe purpose: um purpose enviado é RECUSADO pelo nome, e o bus nunca o vê", async () => {
    const schema = await schemaOf("update_task");
    expect(schema.properties?.purpose).toBeUndefined();
    seen.length = 0;
    const res = await client.callTool({ name: "update_task", arguments: { taskId: "t1", status: "done", purpose: "fix" } });
    // ATÉ 2026-09-20 este teste afirmava o oposto — `isError` falso e a chave
    // chegando ao bus (e sendo descartada lá). Era o comportamento errado
    // fixado como esperado: o mesmo descarte silencioso que deixou 8 tasks com
    // `prompt` NULL (task 0ccd479a). Agora o shape é estrito e a recusa nomeia
    // a chave extra, sem tocar o bus.
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Unrecognized key: "purpose"');
    expect(seen).toHaveLength(0);
  });

  it("create_task com purpose fora do enum: refused pelo schema, o bus nunca é chamado", async () => {
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

  it("spawn_agent.role: enum implementer|reviewer, descrição diz o default, o que reviewer muda e o que é refused", async () => {
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

/**
 * CAMPO DE CHAMADA ESCRITO DENTRO DO PAYLOAD (task a477f3d4) — o caso real
 * foi `report` com `verdict` por dentro (reports seq 515: `ok:true`, verdict
 * gravado NULL, revisor convicto de que assinou). A regra é a mesma classe do
 * shape estrito que fechou `list_tasks({boardid})`: lá chave DESCONHECIDA,
 * aqui chave CONHECIDA no lugar errado — que o zod não tem como ver, porque
 * `report` é `z.unknown()`.
 *
 * Fala com o servidor REAL pelo cliente do SDK para fixar as três coisas que
 * importam: a recusa volta como RESULTADO (não lança, o modelo corrige no
 * mesmo turno), ela nomeia o que veio e para onde vai, e o PAYLOAD normal
 * segue intacto — a única garantia que impede um aperto no caminho mais
 * quente do board de travar a sessão de alguém.
 */
describe("mcp-server: campo de chamada dentro do payload", () => {
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
    await new Promise<void>((resolve) => {
      const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
      tick();
    });
    client = new Client({ name: "misplaced-field", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  const callReport = async (arguments_: Record<string, unknown>) =>
    (await client.callTool({ name: "report", arguments: arguments_ })) as {
      isError?: boolean;
      content: { text: string }[];
    };

  it("`verdict` dentro do payload é RECUSADO — e o bus nunca vê o report", async () => {
    seen.length = 0;
    const res = await callReport({ report: { ok: true, achados: "5 pontos", verdict: "APROVADO" } });
    // Resultado, não exceção: o turno continua.
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("`verdict`");
    expect(body.error).toContain("`report`");
    expect(body.error).toContain("APROVADO");
    expect(body.error).toContain("nothing was written");
    // Nenhum report chegou ao bus: nothing was written (nem veredito, nem linha).
    expect(seen.filter((r) => r.cmd === "report")).toHaveLength(0);
  });

  it("envelope entregue como string de JSON malformada continua invisível — limite declarado", async () => {
    // A string abaixo decodifica; a do seq 515 real não decodifica ("Extra
    // data"), e por isso a chave embutida ficou fora de alcance — essa metade
    // é a task 10cf58d0 (envelope gravado como string). Aqui ela passa como
    // payload não-objeto, que é o comportamento de hoje.
    seen.length = 0;
    const res = await callReport({ report: '{"ok": true, "verdict": "aprovado"}' });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
    // Este decodifica: cai na recusa, como o objeto equivalente.
    expect(body.ok).toBe(false);
    expect(body.error).toContain("`verdict`");
    expect(seen.filter((r) => r.cmd === "report")).toHaveLength(0);
  });

  it("`callerCardId` dentro do payload também é refused, nomeando os dois campos", async () => {
    seen.length = 0;
    const res = await callReport({ report: { ok: true, verdict: "aprovado", callerCardId: "c9" } });
    const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("`verdict`");
    expect(body.error).toContain("`callerCardId`");
    expect(seen.filter((r) => r.cmd === "report")).toHaveLength(0);
  });

  it("CONTROLE — o caminho feliz: verdict no campo da chamada e payload livre chegam ao bus", async () => {
    seen.length = 0;
    const res = await callReport({ report: { ok: true, achados: "tudo verde", evidenciaMedida: "npx vitest run" }, verdict: "aprovado" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true });
    const reports = seen.filter((r) => r.cmd === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      report: { ok: true, achados: "tudo verde", evidenciaMedida: "npx vitest run" },
      verdict: "aprovado",
    });
  });

  it("CONTROLE — com o campo da chamada TAMBÉM presente, nada se perde: passa", async () => {
    seen.length = 0;
    const res = await callReport({ report: { ok: true, verdict: "reprovado" }, verdict: "aprovado" });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true });
    expect(seen.filter((r) => r.cmd === "report")).toHaveLength(1);
  });

  it("CONTROLE — update_task NÃO é apertada por esta regra (medido: 33/139 result_json usam `gates`/`review` como conteúdo)", async () => {
    // `update_task` tem campo livre (`result`) e campo de chamada `status`,
    // `gates`, `review`… Aplicar-lhe a mesma varredura recusaria um quarto
    // dos payloads REAIS do banco, que usam esses nomes como conteúdo
    // legítimo. A decisão de não migrá-la sob esta regra fica travada aqui.
    seen.length = 0;
    const res = (await client.callTool({
      name: "update_task",
      arguments: { taskId: "t1", result: { status: "done", gates: { tsc: "clean" } } },
    })) as { isError?: boolean };
    expect(res.isError ?? false).toBe(false);
    const updates = seen.filter((r) => r.cmd === "update_task");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ result: { status: "done", gates: { tsc: "clean" } } });
  });
});


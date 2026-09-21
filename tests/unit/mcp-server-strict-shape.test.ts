import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";

/**
 * CHAVE DESCONHECIDA NO TOPO — a terceira variação da mesma doença
 * (task 0ccd479a). As três, medidas neste board:
 *
 *   - `list_tasks({ boardid: "118" })` com `d` minúsculo respondia `ok:true` e
 *     devolvia TODOS os boards (fechado por shape estrito — pinado aqui);
 *   - `report` com `verdict` DENTRO do payload respondeu `ok:true` e gravou
 *     `reports.verdict = NULL` (task a477f3d4, o guard de campo deslocado);
 *   - `create_task({ content: "<enunciado>" })` respondeu `ok:true`, gravou a
 *     task e DESCARTOU o texto: `get_task` devolve `prompt: null`.
 *
 * ESTE arquivo trava a invariante que fecha a terceira de uma vez para as 51
 * tools, em vez de remendar duas: TODO shape publicado por este servidor é
 * estrito. Medição antes do conserto: 2 estritas de 51 (só as duas migradas
 * para o contrato); depois: 51 de 51. A causa não era o call site — era o SDK
 * construindo `z.object(shape)` sem `.strict()` para shape cru
 * (`server/zod-compat.js`, `objectFromShape`), com o zod descartando a chave
 * em silêncio.
 *
 * ESTRAGO medido no banco real (313 tasks): 8 com `prompt` NULL, 7 delas com
 * card linkado, 3 ainda pendentes.
 */
describe("mcp-server: chave desconhecida no topo", () => {
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
    client = new Client({ name: "strict-shape", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };

  const textOf = (res: { content: { text: string }[] }) => res.content[0]!.text;
  const bodyOf = (res: { content: { text: string }[] }) => JSON.parse(textOf(res)) as { ok: boolean; error?: string };

  it("INVARIANTE: TODA tool publicada é estrita — nenhuma pode voltar a engolir chave em silêncio", async () => {
    const { tools } = await client.listTools();
    const loose = tools
      .filter((tool) => (tool.inputSchema as { additionalProperties?: boolean } | undefined)?.additionalProperties !== false)
      .map((tool) => tool.name);
    // Se um tool novo nascer com shape cru e o choke point não pegar, a lista
    // deixa de ser vazia e este teste acusa pelo NOME do tool.
    expect(loose).toEqual([]);
    // Guarda contra o teste passar por vacuidade (servidor sem tools).
    expect(tools.length).toBeGreaterThan(40);
  });

  it("o caso medido: create_task com `content` no lugar de `prompt` é RECUSADO — e o bus nunca é chamado", async () => {
    seen.length = 0;
    const res = await call("create_task", { content: "enunciado da task", provider: "claude" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    // A chave RECEBIDA e o conjunto ACEITO, na mesma chamada.
    expect(text).toContain('Unrecognized key: "content"');
    expect(text).toContain("`prompt`");
    expect(text).toContain("nada foi gravado");
    // Nenhuma task nasceu: o dano medido (task sem enunciado) é impossível.
    expect(seen.filter((r) => r.cmd === "create_task")).toHaveLength(0);
  });

  it("update_task recusou o mesmo `content` e também o descartava — agora recusa igual", async () => {
    seen.length = 0;
    const res = await call("update_task", { taskId: "t1", content: "enunciado" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Unrecognized key: "content"');
    expect(seen.filter((r) => r.cmd === "update_task")).toHaveLength(0);
  });

  it("o irmão já fechado continua fechado: `boardid` no lugar de `boardId`", async () => {
    seen.length = 0;
    const res = await call("list_tasks", { boardid: "118" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Unrecognized key: "boardid"');
    expect(textOf(res)).toContain("`boardId`");
    expect(seen).toHaveLength(0);
  });

  it("tool SEM campo nenhum também recusa o que não existe (uniformidade, não remendo)", async () => {
    seen.length = 0;
    const res = await call("list_cards", { qualquer_coisa: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Unrecognized key: "qualquer_coisa"');
    expect(textOf(res)).toContain("não aceita campo nenhum");
    expect(seen).toHaveLength(0);
  });

  it("chamada VÁLIDA não ganha atrito: passa e chega ao bus como sempre", async () => {
    seen.length = 0;
    const res = await call("create_task", { prompt: "enunciado", provider: "claude", purpose: "fix" });
    expect(res.isError ?? false).toBe(false);
    expect(bodyOf(res)).toMatchObject({ ok: true });
    expect(seen.filter((r) => r.cmd === "create_task")).toHaveLength(1);
    expect(seen[0]).toMatchObject({ prompt: "enunciado", provider: "claude", purpose: "fix" });
  });

  describe("a fronteira: o estrato NÃO atravessa o conteúdo de campo livre", () => {
    it("update_task.result com chaves arbitrárias DENTRO dele continua aceito", async () => {
      // Apertar aqui recusaria 33 dos 139 `result_json` reais, que usam
      // `gates`/`review` como CONTEÚDO legítimo — medido na task a477f3d4.
      seen.length = 0;
      const result = { status: "done", gates: { tsc: "clean" }, review: "aprovado pelo revisor", campo_livre: 1 };
      const res = await call("update_task", { taskId: "t1", result });
      expect(res.isError ?? false).toBe(false);
      const updates = seen.filter((r) => r.cmd === "update_task");
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ taskId: "t1", result });
    });

    it("report.report continua livre — e o guard da a477f3d4 segue valendo, separado deste", async () => {
      seen.length = 0;
      const payload = { ok: true, achados: "x", content: "chave que seria desconhecida no TOPO de create_task", gates: [1] };
      const res = await call("report", { report: payload, verdict: "aprovado" });
      expect(res.isError ?? false).toBe(false);
      expect(bodyOf(res)).toMatchObject({ ok: true });
      const reports = seen.filter((r) => r.cmd === "report");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ report: payload });

      // E o outro guard (campo de CHAMADA dentro do payload) não foi
      // substituído por este: continua recusando com a mensagem dele.
      seen.length = 0;
      const misplaced = await call("report", { report: { ok: true, verdict: "aprovado" } });
      expect(bodyOf(misplaced).ok).toBe(false);
      expect(bodyOf(misplaced).error).toContain("DENTRO do payload");
      expect(seen.filter((r) => r.cmd === "report")).toHaveLength(0);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

/**
 * IDENTIDADE DE REPORT — o vínculo de REVISOR (task 6bea994a).
 *
 * O DEFEITO, medido: `resolveReportVerdictContext` (mcp-server.ts) chamava
 * `decideReportTaskLink` com `linkTaskIds: []` HARDCODED, e `principals` só
 * continha tasks em que o card é `tasks.card_id`. Um revisor nunca é
 * principal — o vínculo dele vive em `task_cards` (`link_task_card` com
 * `role:"reviewer"`, ou `spawn_agent` com `role`), que é EXATAMENTE a fonte
 * que a decisão pura pede em `linkTaskIds` e o BUS já alimenta
 * (`message-bus.ts`, `callbacks.listTaskCardsForCard`). Resultado medido no
 * servidor real: revisor com vínculo vivo declarando o `taskId` no corpo —
 * que é a convenção do board, e o que a própria recusa de ambiguidade manda
 * fazer — recebia `declared-not-linked` com a frase "Este card não tem
 * vínculo ativo nenhum", que é FALSA, e o report nunca chegava ao bus.
 *
 * ESTE ARQUIVO É O TESTE QUE FALHA ANTES DO CONSERTO (pedido explícito do
 * enunciado): o primeiro caso abaixo — revisor assinando — era recusado pelo
 * código anterior. Os controles (implementer não assina; ninguém assina fora
 * do vínculo) passavam antes e continuam passando: o conserto não pode
 * reabrir o buraco de autorização fechado pela task 4fee76d5.
 *
 * A task do stub declara `review: "wanted"` DE PROPÓSITO: com ela, só um card
 * reconhecido como REVIEWER passa pelo gate. É o que prova que o papel foi
 * resolvido pelo vínculo, e não que a chamada simplesmente escapou.
 */

const REVIEWER = "card-revisor";
const PRINCIPAL = "card-implementador";
const OUTSIDER = "card-solto";
const TASK = "T-ALVO";
const TASK_B = "T-OUTRA";

type TaskShape = { id: string; cardId: string | null; status: string; review: string | null; reportSchema: string[] };
type LinkShape = { taskId: string; role: string };

describe("6bea994a — identidade de report pelo vínculo de revisor", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let tasks: TaskShape[];
  let links: LinkShape[];
  let reports: BusRequest[];

  beforeAll(async () => {
    server = createMcpServer({
      port: 0,
      handleRequest: async (req: BusRequest): Promise<BusResponse> => {
        if (req.cmd === "list_tasks") return { ok: true, tasks };
        if (req.cmd === "list_task_cards") return { ok: true, links };
        if (req.cmd === "get_task") {
          const task = tasks.find((t) => t.id === req.taskId);
          return task
            ? {
                ok: true,
                task: {
                  ...task,
                  cards: [{ cardId: REVIEWER, role: "reviewer" }, { cardId: PRINCIPAL, role: "implementer" }],
                },
              }
            : { ok: false, error: "no such task" };
        }
        if (req.cmd === "report") {
          reports.push(req);
          return { ok: true, accepted: true };
        }
        return { ok: true };
      },
    });
    await new Promise<void>((resolve) => {
      const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
      tick();
    });
    client = new Client({ name: "report-identity", version: "0.0.0" });
    // `caller()` só confia no carimbo da URL (`caller-identity.ts`).
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}?card=${REVIEWER}`)));
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  beforeEach(() => {
    reports = [];
    tasks = [];
    links = [];
  });

  const task = (id: string, overrides: Partial<TaskShape> = {}): TaskShape =>
    ({ id, cardId: null, status: "running", review: "wanted", reportSchema: ["decisaoTomada"], ...overrides });

  const sign = async (card: string, report: Record<string, unknown>) => {
    const c = new Client({ name: `signer-${card}`, version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${server.url}?card=${card}`)));
    const res = (await c.callTool({ name: "report", arguments: { report, verdict: "aprovado" } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    await c.close();
    return res;
  };

  const body = (res: { content: { text: string }[] }) => JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };

  it("O CASO DO DEFEITO: revisor vinculado assina declarando o taskId — aceito, e chega ao bus", async () => {
    // O estado real do board: o vínculo vive em `task_cards`, não em
    // `tasks.card_id`. Antes do conserto esta chamada era recusada com a frase
    // falsa "Este card não tem vínculo ativo nenhum".
    tasks = [task(TASK)];
    links = [{ taskId: TASK, role: "reviewer" }];

    const res = await sign(REVIEWER, { ok: true, taskId: TASK, decisaoTomada: "revisado por reprodução" });

    expect(body(res).ok, `recusa inesperada: ${body(res).error}`).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ cmd: "report", verdict: "aprovado" });
  });

  it("CONTROLE — o vínculo de revisor em OUTRA task não autoriza esta", async () => {
    tasks = [task(TASK)];
    links = [{ taskId: TASK_B, role: "reviewer" }];

    const res = await sign(REVIEWER, { ok: true, taskId: TASK, decisaoTomada: "assinando a task errada" });

    expect(body(res).ok).toBe(false);
    expect(reports).toHaveLength(0);
  });

  it("CONTROLE — implementer (principal) NÃO assina o próprio trabalho", async () => {
    tasks = [task(TASK, { cardId: PRINCIPAL })];
    links = [{ taskId: TASK, role: "implementer" }];

    const res = await sign(PRINCIPAL, { ok: true, taskId: TASK, decisaoTomada: "auto-aprovação" });

    expect(body(res).ok).toBe(false);
    expect(reports).toHaveLength(0);
  });

  it("CONTROLE — quem não tem vínculo nenhum não vira revisor por declarar o taskId", async () => {
    tasks = [task(TASK)];
    links = [];

    const res = await sign(OUTSIDER, { ok: true, taskId: TASK, decisaoTomada: "sem vínculo" });

    expect(body(res).ok).toBe(false);
    expect(reports).toHaveLength(0);
  });

  it("DOIS vínculos vivos sem declaração: AMBÍGUO, recusa nomeando as duas candidatas", async () => {
    // A regra que não pode regredir (task 4fee76d5): com 2+, nunca desempata e
    // nunca degrada para outsider. Antes deste conserto a lista de vínculos
    // chegava VAZIA, a decisão caía em `unknown` e a chamada passava como
    // outsider — o silêncio que o preenchimento torna explícito.
    tasks = [task(TASK), task(TASK_B)];
    links = [{ taskId: TASK, role: "reviewer" }, { taskId: TASK_B, role: "reviewer" }];

    const res = await sign(REVIEWER, { ok: true, decisaoTomada: "sem dizer de qual task" });

    expect(body(res).ok).toBe(false);
    expect(body(res).error).toContain(TASK);
    expect(body(res).error).toContain(TASK_B);
    expect(reports).toHaveLength(0);
  });

  it("principal de uma E revisor de outra: RECUSA (não assina), nunca resolve em silêncio", async () => {
    tasks = [task(TASK, { cardId: REVIEWER }), task(TASK_B)];
    links = [{ taskId: TASK, role: "implementer" }, { taskId: TASK_B, role: "reviewer" }];

    const res = await sign(REVIEWER, { ok: true, decisaoTomada: "ambíguo entre dois papéis" });

    expect(body(res).ok).toBe(false);
    expect(reports).toHaveLength(0);
  });

  it("o caminho feliz do implementer segue funcionando: principal declara e chega ao bus", async () => {
    tasks = [task(TASK, { cardId: PRINCIPAL, review: null })];
    links = [{ taskId: TASK, role: "implementer" }];

    const res = await sign(PRINCIPAL, { ok: true, taskId: TASK, decisaoTomada: "entrega" });

    // O gate do MCP recusa implementer por PAPEL quando há veredito; o que este
    // teste fixa é que a resolução da task continua acontecendo (a recusa é a
    // do papel, e não a de identidade).
    expect(body(res).ok).toBe(false);
    expect(body(res).error).not.toContain("não tem vínculo ativo");

    // Sem veredito formal, o mesmo card entrega normalmente.
    reports = [];
    const c = new Client({ name: "impl-plain", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${server.url}?card=${PRINCIPAL}`)));
    const plain = (await c.callTool({
      name: "report",
      arguments: { report: { ok: true, taskId: TASK, decisaoTomada: "entrega sem veredito" } },
    })) as { content: { text: string }[] };
    await c.close();
    expect(body(plain).ok).toBe(true);
    expect(reports).toHaveLength(1);
  });
});

/**
 * A LEITURA QUE FALTAVA — `list_task_cards` contra store e bus REAIS.
 *
 * O conserto acima depende de um cmd que não existia: a porta MCP só fala
 * `handleRequest`, e nenhum dos 50 cmds devolvia os vínculos de um card (a
 * função existia só como callback interno do bus). Aqui ele é exercitado de
 * ponta a ponta — `linkTaskCard` grava em `task_cards`, o cmd lê pela mesma
 * `listTaskCardsForCard` que o handler de `report` usa, com o filtro de época.
 */
function baseTaskRow(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "default",
    cwd: null,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as TaskRow;
}

describe("list_task_cards — o vínculo persistido é legível", () => {
  it("devolve o vínculo de reviewer gravado por linkTaskCard, e nada para card sem vínculo", async () => {
    const { openStore } = await import("../../src/main/store");
    const { createMessageBus } = await import("../../src/main/message-bus");
    const dir = mkdtempSync(join(tmpdir(), "stellar-list-task-cards-"));
    const store = openStore(dir);
    const bus = createMessageBus(
      join(dir, "cards.sock"),
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            const value = (store as unknown as Record<string, unknown>)[prop];
            if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(store);
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );
    try {
      store.upsertTask(baseTaskRow("T-1"));
      store.linkTaskCard("T-1", "card-rev", "reviewer");

      const withLink = (await bus.handleRequest({ cmd: "list_task_cards", cardId: "card-rev" } as BusRequest)) as {
        ok: boolean;
        links?: { taskId: string; role: string }[];
      };
      expect(withLink.ok).toBe(true);
      expect(withLink.links).toEqual([{ taskId: "T-1", role: "reviewer" }]);

      const withoutLink = (await bus.handleRequest({ cmd: "list_task_cards", cardId: "card-sem-vinculo" } as BusRequest)) as {
        ok: boolean;
        links?: unknown[];
      };
      expect(withoutLink.ok).toBe(true);
      expect(withoutLink.links).toEqual([]);

      const missing = (await bus.handleRequest({ cmd: "list_task_cards" } as BusRequest)) as { ok: boolean };
      expect(missing.ok).toBe(false);
    } finally {
      bus.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

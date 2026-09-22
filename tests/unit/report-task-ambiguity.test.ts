import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer } from "../../src/main/mcp-server";
import type { BusRequest, BusResponse } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

const CARD_BUS = "card-bus-1";

function baseTaskRow(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "faz X",
    provider: "claude",
    status: "running",
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

/**
 * CARACTERIZAÇÃO DO FURO (task 4fee76d5) — um card com 2+ tasks ativas
 * deixa de ser reconhecido como implementer e passa a ser tratado como
 * OUTSIDER, que em task sem `review:"wanted"` PODE assinar veredito.
 *
 * A regra real, medida no código: `resolveReportVerdictContext`
 * (mcp-server.ts) só usa o resultado de `list_tasks` quando
 * `principals.length === 1`. Com 2+, `requesterRoleOnTask` fica `null`, e
 * `decideReportVerdictWrite` trata `null` como outsider → allow.
 *
 * Estes testes asserem o comportamento DESEJADO. Se passarem contra o
 * código de hoje, a hipótese está errada — e o certo é dizer isso, não
 * forçar.
 */

type TaskShape = { id: string; cardId: string; status: string; reportSchema: string[]; review: null };

function task(id: string, cardId: string, reportSchema: string[] = []): TaskShape {
  return { id, cardId, status: "running", reportSchema, review: null };
}

describe("4fee76d5 — ambiguidade de vínculo no report (caracterização)", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let tasks: TaskShape[];
  let reports: BusRequest[];

  const CARD = "c1";

  beforeAll(async () => {
    server = createMcpServer({
      port: 0,
      handleRequest: async (req: BusRequest): Promise<BusResponse> => {
        if (req.cmd === "list_tasks") return { ok: true, tasks };
        if (req.cmd === "get_task") {
          const t = tasks.find((x) => x.id === req.taskId);
          return t ? { ok: true, task: { ...t, cards: [{ cardId: CARD, role: "implementer" }] } } : { ok: false, error: "no task" };
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
    // `caller()` só confia no carimbo da URL (`caller-identity.ts`): o
    // `callerCardId` do corpo NÃO estabelece identidade. Sem `?card=` o
    // requesterId seria undefined e nada disto seria exercitado.
    client = new Client({ name: "ambiguity", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}?card=${CARD}`)));
  });

  afterAll(async () => {
    await client.close();
    server.close();
  });

  beforeEach(() => {
    reports = [];
  });

  const verdictCall = async (report: Record<string, unknown>) =>
    (await client.callTool({ name: "report", arguments: { report, verdict: "aprovado" } })) as {
      isError?: boolean;
      content: { text: string }[];
    };

  describe("pelo caminho MCP", () => {
    it("COM 2 vínculos ativos: o veredito é RECUSADO e a recusa NOMEIA as duas candidatas", async () => {
      tasks = [task("T-A", CARD), task("T-B", CARD)];
      const res = await verdictCall({ ok: true });
      const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("T-A");
      expect(body.error).toContain("T-B");
      // E o report com veredito NÃO pode ter chegado ao bus.
      expect(reports.filter((r) => r.verdict)).toHaveLength(0);
    });

    it("CONTROLE — com UM vínculo onde o card é implementer: recusa pelo papel (já funciona hoje)", async () => {
      tasks = [task("T-A", CARD)];
      const res = await verdictCall({ ok: true });
      const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(reports.filter((r) => r.verdict)).toHaveLength(0);
    });

    it("COM 2 vínculos e taskId DECLARADO: resolve pela declarada, não por desempate", async () => {
      tasks = [task("T-A", CARD), task("T-B", CARD)];
      const res = await verdictCall({ ok: true, taskId: "T-B" });
      const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
      // Implementer na T-B declarada → recusa pelo PAPEL, e a mensagem é a
      // de implementer (não a de ambiguidade).
      expect(body.ok).toBe(false);
      expect(reports.filter((r) => r.verdict)).toHaveLength(0);
    });

    it("taskId declarado que NÃO é vínculo ativo do card: recusa, nunca fallback silencioso", async () => {
      tasks = [task("T-A", CARD)];
      const res = await verdictCall({ ok: true, taskId: "T-Z" });
      const body = JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(reports.filter((r) => r.verdict)).toHaveLength(0);
    });
  });

  // A segunda porta: o handler `report` do PRÓPRIO bus, por onde o acbridge
  // entra (o comentário do choke point diz que ele é "o choke point DE
  // VERDADE"). Aqui a task é resolvida por `resolveDeclaredTaskId`, que só é
  // inequívoco com UM vínculo — a pergunta é o que acontece com dois.
  describe("pelo caminho do BUS (store real, a porta do acbridge)", () => {
    it("COM 2 vínculos e o card NÃO sendo principal de nenhuma: o veredito é RECUSADO nomeando as duas", async () => {
      const { openStore } = await import("../../src/main/store");
      const { createMessageBus } = await import("../../src/main/message-bus");
      const dir = mkdtempSync(join(tmpdir(), "stellar-ambiguity-bus-"));
      const store = openStore(dir);
      const bus = createMessageBus(
        join(dir, "ambiguity.sock"),
        new Proxy(
          {},
          {
            get: (_t, prop: string) => {
              if (prop === "listTasks") return () => store.listTasks();
              if (prop === "listTaskCardsForCard") return (cardId: string) => store.listTaskCardsForCard(cardId);
              if (prop === "getTask") return (id: string) => store.getTask(id);
              if (prop === "getTaskCards") return (id: string) => store.getTaskCards(id);
              if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
              if (prop === "upsertReport") return (row: never) => store.upsertReport(row);
              if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
              if (prop === "recordParticipationRound") return (c: string, v: string | null, at: number) => store.recordParticipationRound(c, v, at);
              if (prop === "upsertTask") return (row: never) => store.upsertTask(row);
              if (prop === "listAllConnectors") return () => [];
              if (prop === "listCards") return () => [];
              // O rig não tem pty-registry: todo id que ele nomeia É um card
              // vivo. Sem esta linha o guarda de identidade do `report` (task
              // 34e27f66) recusaria CARD_BUS por "o card não existe" e a
              // ambiguidade — que é o que este caso testa — nunca seria
              // alcançada.
              if (prop === "isCardAlive") return () => true;
              return () => undefined;
            },
          },
        ) as Parameters<typeof createMessageBus>[1],
      );
      try {
        // O card CARD-BUS participa de DUAS tasks running, sem ser principal
        // de nenhuma (é o caso de um card reusado entre tasks).
        store.upsertTask(baseTaskRow("T-A", { card_id: null }));
        store.upsertTask(baseTaskRow("T-B", { card_id: null }));
        store.linkTaskCard("T-A", CARD_BUS, "implementer");
        store.linkTaskCard("T-B", CARD_BUS, "implementer");

        const res = (await bus.handleRequest({
          cmd: "report",
          requesterId: CARD_BUS,
          report: { ok: true },
          verdict: "aprovado",
        } as BusRequest)) as { ok: boolean; error?: string };

        expect(res.ok).toBe(false);
        expect(res.error).toContain("T-A");
        expect(res.error).toContain("T-B");
      } finally {
        bus.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

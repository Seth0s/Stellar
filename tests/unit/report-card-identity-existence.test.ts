import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openStore, type CardRow, type ReportRow, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { createMcpServer } from "../../src/main/mcp-server";

/**
 * "O card que reporta É o card que existe" — o invariante que faltava, e
 * por cujo buraco SEIS relatórios de DOIS cards diferentes foram parar no
 * mesmo id fantasma (task 34e27f66).
 *
 * MEDIDO no board vivo (2026-09-22), antes deste conserto:
 *   cards com provider='cline': 97924182, 97924184, 97924186, 97924189
 *   AGENT_CANVAS_CARD_ID de TODOS:  97924181
 *   SELECT COUNT(*) FROM cards WHERE id='97924181'  ->  0
 *   reports gravados sob 97924181: seq 666..671
 * e cada autor recebia `ok:true` de volta: o card achava que tinha
 * reportado. A causa a montante é de transporte — um daemon de cline
 * compartilhado entre os cards congela o ambiente do primeiro card, e
 * todos os shims herdam aquele id (`declared-card-existence-decision.ts`
 * traz a tabela de `/proc/<pid>/environ` + `PPid` medida).
 *
 * O que este arquivo trava NÃO é a herança (não é consertável daqui): é a
 * porta de escrita aceitar uma identidade que não corresponde a card vivo
 * nenhum. O primeiro caso é o defeito, e a asserção que importa é a de que
 * NADA foi gravado — não só a de que a resposta veio `ok:false`: uma
 * recusa que já tivesse escrito mentiria igual.
 *
 * PROVA POR MUTAÇÃO: trocar `if (input.cardExists)` por `if (true)` em
 * `decideDeclaredCardExistence` deixa o primeiro caso vermelho (o fantasma
 * volta a gravar); trocar por `if (false)` deixa os controles vermelhos.
 * Ver `gatesOutput` do relatório.
 */

function baseCard(id: string): CardRow {
  return {
    id,
    board_id: "default",
    kind: "terminal",
    provider: "cline",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    resume_id: null,
    model: null,
    effort: null,
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: Date.now(),
    messages_json: null,
    archived_at: null,
  };
}

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "work",
    provider: "cline",
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
 * `isCardAlive` wired to an explicit Set, not to the `cards` table: the
 * production source is the PTY registry (`entries.has(id)`), and the whole
 * point of the last case below is that a row in `cards` is NOT liveness.
 */
function callbacksBackedByStore(
  store: ReturnType<typeof openStore>,
  liveCardIds: ReadonlySet<string>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
        if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
        if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
        if (prop === "listTaskCardsForCard") return (cardId: string) => store.listTaskCardsForCard(cardId);
        if (prop === "recordParticipationRound")
          return (cardId: string, verdict: string | null, at: number, taskId?: string | null) =>
            store.recordParticipationRound(cardId, verdict, at, taskId);
        if (prop === "listTasks") return () => store.listTasks();
        if (prop === "getTask") return (id: string) => store.getTask(id);
        if (prop === "upsertTask") return (row: TaskRow) => store.upsertTask(row);
        if (prop === "getTaskCards") return (taskId: string) => store.getTaskCards(taskId);
        if (prop === "isCardAlive") return (cardId: string) => liveCardIds.has(cardId);
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "getCardBoardId") return () => undefined;
        return () => undefined;
      },
    },
  ) as unknown as Parameters<typeof createMessageBus>[1];
}

function reportRows(dir: string, cardId: string): { seq: number; report_json: string }[] {
  const raw = new Database(join(dir, "agent-canvas.db"), { readonly: true });
  try {
    return raw.prepare("SELECT seq, report_json FROM reports WHERE card_id = ? ORDER BY seq").all(cardId) as {
      seq: number;
      report_json: string;
    }[];
  } finally {
    raw.close();
  }
}


describe("report: a identidade declarada tem de existir (task 34e27f66)", () => {
  let dir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    bus = null;
    store = null;
    dir = null;
  });

  function boot(liveCardIds: string[]): void {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-identity-"));
    store = openStore(dir);
    bus = createMessageBus(join(dir, "identity.sock"), callbacksBackedByStore(store, new Set(liveCardIds)));
  }

  it("O DEFEITO: um id que não é de card nenhum é RECUSADO e não grava nada", async () => {
    boot([]);
    store!.upsertCard(baseCard("97924182"));

    const res = (await bus!.handleRequest({
      cmd: "report",
      requesterId: "97924181",
      report: { ok: true, taskId: "3fe0db6e", entregue: "trabalho real" },
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    // A recusa NOMEIA o id declarado — sem isso o autor não tem como saber
    // que a identidade dele é que está errada (e não o payload).
    expect(res.error).toContain("97924181");
    expect(res.error).toContain("NÃO existe");
    expect(res.error).toContain("Nada foi gravado");

    // A asserção que importa: o banco. `ok:false` com uma linha gravada
    // mentiria do mesmo jeito que o `ok:true` de antes.
    expect(reportRows(dir!, "97924181")).toEqual([]);
    // `getReport` devolve `undefined`/`null` quando não há linha — a
    // asserção normaliza os dois porque o contrato do store não fixa qual.
    expect(store!.getReport("97924181") ?? null).toBeNull();
    expect(store!.nextReportSeqSeed()).toBe(0);
  });

  it("CONTROLE: um card VIVO reporta normalmente, sob o próprio id", async () => {
    boot(["97924182"]);
    store!.upsertCard(baseCard("97924182"));

    const res = (await bus!.handleRequest({
      cmd: "report",
      requesterId: "97924182",
      report: { ok: true, entregue: "trabalho real" },
    } as BusRequest)) as { ok: boolean; seq?: number; error?: string };

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    // seq 1: a recusa do caso acima não queimou sequência nenhuma.
    expect(res.seq).toBe(1);
    expect(reportRows(dir!, "97924182")).toEqual([
      { seq: 1, report_json: expect.stringContaining("trabalho real") },
    ]);
  });

  it("CONTROLE: recusar não queima a vez de quem reporta de verdade", async () => {
    boot(["97924182"]);
    store!.upsertCard(baseCard("97924182"));

    for (let i = 0; i < 2; i += 1) {
      const bad = (await bus!.handleRequest({
        cmd: "report",
        requesterId: "97924181",
        report: { ok: true },
      } as BusRequest)) as { ok: boolean };
      expect(bad.ok).toBe(false);
    }
    const good = (await bus!.handleRequest({
      cmd: "report",
      requesterId: "97924182",
      report: { ok: true },
    } as BusRequest)) as { ok: boolean; seq?: number };
    expect(good.ok).toBe(true);
    expect(good.seq).toBe(1);
    expect(store!.nextReportSeqSeed()).toBe(1);
  });

  it("CONTROLE: anônimo continua 'missing requesterId' — causa DIFERENTE, mensagem diferente", async () => {
    boot(["97924182"]);
    store!.upsertCard(baseCard("97924182"));

    const res = (await bus!.handleRequest({
      cmd: "report",
      report: { ok: true },
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toContain("missing requesterId");
    // Fundir os dois casos (anônimo × id que não existe) apagaria a
    // distinção que o defeito precisava: "não declarei" não é "declarei um
    // card fantasma".
    expect(res.error).not.toContain("NÃO existe");
  });

  it("CONTROLE: card vivo COM vínculo de task reporta, e o vínculo não vaza para o fantasma", async () => {
    boot(["97924184"]);
    store!.upsertCard(baseCard("97924184"));
    store!.upsertTask(baseTask("56604aca", { card_id: "97924184", status: "running" }));

    const good = (await bus!.handleRequest({
      cmd: "report",
      requesterId: "97924184",
      report: { ok: true, taskId: "56604aca", entregue: "a fatia" },
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(good.error).toBeUndefined();
    expect(good.ok).toBe(true);
    expect(reportRows(dir!, "97924184")).toHaveLength(1);

    // O fantasma não é dono de task nenhuma, então nem chega a ser avaliado
    // como vínculo — e o vínculo legítimo continua intacto.
    const phantom = (await bus!.handleRequest({
      cmd: "report",
      requesterId: "97924181",
      report: { ok: true, taskId: "56604aca" },
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(phantom.ok).toBe(false);
    expect(phantom.error).toContain("NÃO existe");
    expect(store!.getTask("56604aca")?.card_id).toBe("97924184");


    expect(reportRows(dir!, "97924181")).toEqual([]);
    expect(reportRows(dir!, "97924184")).toHaveLength(1);
  });

  it("id de card que existe na TABELA mas não tem processo vivo também é recusado", async () => {
    // É o caso que uma COLISÃO de id produziria (o risco que eleva a
    // prioridade): o id volta a existir como linha de `cards` e, sem esta
    // fonte de verdade (PTY, não tabela), o impostor herdado passaria a
    // gravar no lugar do dono — e a decidir autorização por ele.
    boot([]); // nenhum card vivo
    store!.upsertCard(baseCard("97924181")); // a linha existe de novo

    const res = (await bus!.handleRequest({
      cmd: "report",
      requesterId: "97924181",
      report: { ok: true },
    } as BusRequest)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toContain("NÃO existe");
    expect(reportRows(dir!, "97924181")).toEqual([]);
  });
});
/**
 * A MESMA recusa, pela PORTA que o defeito usa de verdade.
 *
 * O shim `stellar-mcp` (resources/bin) é um proxy stdio: ele carimba
 * `?card=<AGENT_CANVAS_CARD_ID>` na URL e repassa tudo para o servidor HTTP
 * (`mcp-server.ts`), que resolve a identidade SÓ pelo carimbo
 * (`caller-identity.ts`) e chama o bus. Este bloco sobe esse caminho
 * inteiro dentro do processo — store real, bus real, servidor MCP real,
 * cliente MCP real — porque um guarda que só vale no bus poderia ser
 * contornado por uma porta que passasse `requesterId` por outro caminho.
 */
describe("report: a recusa pela porta do MCP (o caminho do shim)", () => {
  let dir: string;
  let store: ReturnType<typeof openStore>;
  let bus: ReturnType<typeof createMessageBus>;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client | null = null;

  const PHANTOM = "97924181";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-identity-mcp-"));
    store = openStore(dir);
    store.upsertCard(baseCard("97924182")); // a única linha de `cards`
    bus = createMessageBus(join(dir, "mcp-door.sock"), callbacksBackedByStore(store, new Set(["97924182"])));
    server = createMcpServer({ port: 0, handleRequest: (req) => bus.handleRequest(req) });
    await new Promise<void>((resolve) => {
      const tick = () => (server.url.endsWith(":0/mcp") ? setTimeout(tick, 5) : resolve());
      tick();
    });
  });

  afterAll(async () => {
    await client?.close();
    server.close();
    bus.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function report(stampedCardId: string, payload: Record<string, unknown>) {
    const c = new Client({ name: `stamped-${stampedCardId}`, version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${server.url}?card=${stampedCardId}`)));
    const res = (await c.callTool({ name: "report", arguments: { report: payload } })) as {
      content: { text: string }[];
    };
    await c.close();
    return JSON.parse(res.content[0]!.text) as { ok: boolean; error?: string; seq?: number };
  }

  it("O DEFEITO, pela porta real: o carimbo de um card que não existe não grava nada", async () => {
    const res = await report(PHANTOM, { ok: true, taskId: "3fe0db6e", entregue: "trabalho real" });

    expect(res.ok).toBe(false);
    expect(res.error).toContain(PHANTOM);
    expect(res.error).toContain("NÃO existe");
    expect(reportRows(dir, PHANTOM)).toEqual([]);
    expect(store.nextReportSeqSeed()).toBe(0);
  });

  it("CONTROLE, pela mesma porta: o carimbo de um card VIVO reporta sob o próprio id", async () => {
    const res = await report("97924182", { ok: true, entregue: "trabalho real" });

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.seq).toBe(1);
    expect(reportRows(dir, "97924182")).toHaveLength(1);
    expect(reportRows(dir, PHANTOM)).toEqual([]);
  });
});

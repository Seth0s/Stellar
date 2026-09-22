import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, describeUndecodableReportEnvelope, type BusRequest } from "../../src/main/message-bus";
import type { ReportRow } from "../../src/main/store";

/**
 * `report` — o ENVELOPE (task 10cf58d0).
 *
 * `report` é campo livre na superfície MCP, então um cliente pode mandar o
 * payload como STRING de JSON. `acbridge` já faz `JSON.parse` local e nunca
 * manda string; o handler MCP decodifica o que parseia. O BUS não decodificava:
 * persistia a string como veio, e `JSON.stringify(string)` grava um VALOR
 * string em `report_json` — todos os campos dela inalcançáveis por consulta.
 * Medido no banco: 9 de 457 linhas nessa forma; as 4 mais recentes (canal
 * `http`) são strings de JSON MALFORMADAS que `decodeReportArgument` devolve
 * cruas. A pior delas (seq 515) tinha `"verdict":"aprovado"` embutido: o
 * veredito não foi aplicado e o revisor reemitiu por uma rodada inteira.
 *
 * Aqui: normalizar na entrada o que decodifica, RECUSAR com mensagem o que
 * parece envelope e não decodifica, e normalizar na LEITURA o que já está
 * gravado — sem tocar em dado histórico.
 */
function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    { get: (_target, prop: string) => overrides[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("message-bus: envelope do report (10cf58d0)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-envelope-"));
    const reports: ReportRow[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listTasks: () => [],
        listTaskCardsForCard: () => [],
        listCards: () => [],
        // O rig não tem pty-registry: todo id que ele nomeia É um card vivo.
        // Sem esta linha o guarda de identidade do `report` (task 34e27f66)
        // recusaria "card-1" por "o card não existe" e nada seria gravado — o
        // envelope, que é o que este arquivo testa, nunca seria alcançado. O
        // guarda é exercitado, com os dois lados, em
        // report-card-identity-existence.test.ts.
        isCardAlive: () => true,
        listAllConnectors: () => [],
        nextReportSeqSeed: () => 0,
        upsertReport: (row: ReportRow) => reports.push(row),
        recordParticipationRound: () => undefined,
        describeCardLabel: (id: string) => id,
        ...overrides,
      }),
    );
    return { bus, reports };
  }

  async function send(report: unknown): Promise<{ res: Record<string, unknown>; reports: ReportRow[] }> {
    const { bus: b, reports } = makeBus();
    const res = (await b.handleRequest({ cmd: "report", requesterId: "card-1", report } as BusRequest)) as Record<string, unknown>;
    return { res, reports };
  }

  it("o defeito: string de JSON MALFORMADA é RECUSADA antes de qualquer escrita", async () => {
    // Forma do seq 515: objeto completo, `}` fechando, e um campo colado depois.
    const { res, reports } = await send('{"ok": true, "taskId": "t1"}, "verdict": "aprovado"}');

    expect(res.ok).toBe(false);
    expect(res.field).toBe("report");
    expect(String(res.error)).toContain("not valid JSON");
    expect(String(res.error)).toContain("OBJECT"); // a mensagem ENSINA a corrigir
    expect(reports).toEqual([]); // nada persistido: não gera linha suja
  });

  it("string que DECODIFICA é normalizada: grava o OBJETO, não a string", async () => {
    const { res, reports } = await send('{"ok": true, "resumo": "x"}');

    expect(res.ok).toBe(true);
    expect(reports).toHaveLength(1);
    const stored: unknown = JSON.parse(reports[0].report_json);
    expect(typeof stored).toBe("object");
    expect(stored).toEqual({ ok: true, resumo: "x" });
  });

  it("CAMINHO FELIZ não muda: objeto passa inteiro", async () => {
    const { res, reports } = await send({ ok: true, filesChanged: ["a.ts"] });

    expect(res.ok).toBe(true);
    expect(JSON.parse(reports[0].report_json)).toEqual({ ok: true, filesChanged: ["a.ts"] });
  });

  it("CAMINHO FELIZ não muda: prosa (string livre) continua string", async () => {
    const prose = "A tese foi testada e nada quebrou.";
    const { res, reports } = await send(prose);

    expect(res.ok).toBe(true);
    expect(JSON.parse(reports[0].report_json)).toBe(prose);
  });

  it("LEITURA normaliza o passado: report_json gravado como string vira objeto no get_report", async () => {
    // Uma linha histórica: report_json É uma string de JSON.
    const storedRow = {
      card_id: "card-1",
      seq: 7,
      report_json: JSON.stringify('{"ok": true, "resumo": "antigo"}'),
      verdict: null,
      role: null,
      channel: "http" as const,
      updated_at: 1,
    };
    const { bus: b } = makeBus({ getReport: () => storedRow });

    const res = (await b.handleRequest({ cmd: "get_report", target: "card-1" } as BusRequest)) as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.report).toEqual({ ok: true, resumo: "antigo" }); // objeto, como sempre deveria ter sido
  });

  it("LEITURA de uma linha que NÃO decodifica devolve a string crua (a verdade do que está gravado)", async () => {
    const storedRow = {
      card_id: "card-1",
      seq: 8,
      report_json: JSON.stringify('{"ok": true}, "verdict": "aprovado"}'),
      verdict: null,
      role: null,
      channel: "http" as const,
      updated_at: 1,
    };
    const { bus: b } = makeBus({ getReport: () => storedRow });

    const res = (await b.handleRequest({ cmd: "get_report", target: "card-1" } as BusRequest)) as Record<string, unknown>;

    expect(typeof res.report).toBe("string");
  });

  it("a checagem pura: só a string que PARECE envelope e não parseia é problema", () => {
    // não é problema
    expect(describeUndecodableReportEnvelope({ ok: true })).toBeNull();
    expect(describeUndecodableReportEnvelope("prosa livre")).toBeNull();
    expect(describeUndecodableReportEnvelope('{"ok":true}')).toBeNull();
    // O CASO QUE A IRMÃ PROTEGEU: um relatório SOBRE o defeito CITA a chave.
    // Um relatório assim, em prosa, NÃO começa com `{` — passa intacto.
    expect(describeUndecodableReportEnvelope('a regex para "verdict": seria perigosa')).toBeNull();
    // problema
    const msg = describeUndecodableReportEnvelope('{"ok": true}, "verdict": "aprovado"}');
    expect(msg).toContain("not valid JSON");
    expect(msg).toContain("Nothing was stored");
  });
});

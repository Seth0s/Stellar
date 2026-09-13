import { describe, expect, it } from "vitest";
import { isFormalVerdict, promoteReportVerdict, resolveReporterRole } from "../../src/main/report-verdict-decision";

describe("isFormalVerdict", () => {
  it("só os dois valores da coluna", () => {
    expect(isFormalVerdict("aprovado")).toBe(true);
    expect(isFormalVerdict("reprovado")).toBe(true);
    expect(isFormalVerdict("ship")).toBe(false);
    expect(isFormalVerdict(null)).toBe(false);
    expect(isFormalVerdict("Aprovado")).toBe(false);
  });
});

describe("promoteReportVerdict", () => {
  it("JSON do acbridge: verdict formal sai do payload e vira o campo tipado", () => {
    expect(promoteReportVerdict({ ok: true, result: "done", verdict: "aprovado" })).toEqual({
      report: { ok: true, result: "done" },
      verdict: "aprovado",
    });
    expect(promoteReportVerdict({ ok: true, verdict: "reprovado" })).toEqual({
      report: { ok: true },
      verdict: "reprovado",
    });
  });

  it("verdict livre no payload (não é a coluna) fica onde está", () => {
    expect(promoteReportVerdict({ ok: true, verdict: "ship" })).toEqual({
      report: { ok: true, verdict: "ship" },
      verdict: undefined,
    });
  });

  it("req.verdict explícito vence o embutido; o embutido formal ainda é removido", () => {
    expect(promoteReportVerdict({ ok: true, verdict: "aprovado" }, "reprovado")).toEqual({
      report: { ok: true },
      verdict: "reprovado",
    });
  });

  it("explícito sozinho não mexe no payload", () => {
    expect(promoteReportVerdict({ ok: true }, "aprovado")).toEqual({
      report: { ok: true },
      verdict: "aprovado",
    });
  });

  it("array / primitivo / ausente: não inventa, só repassa o explícito", () => {
    expect(promoteReportVerdict(["ok"])).toEqual({ report: ["ok"], verdict: undefined });
    expect(promoteReportVerdict("done", "aprovado")).toEqual({ report: "done", verdict: "aprovado" });
    expect(promoteReportVerdict({ ok: true })).toEqual({ report: { ok: true }, verdict: undefined });
  });
});

// Quem mandou o verdict — `task_cards.role` do card, carimbado em
// `reports.role`. Desconhecido é `null`, nunca `implementer` por default
// (156/156 `task_verdicts` eram implementer justamente por um default
// desses).
describe("resolveReporterRole", () => {
  it("um vínculo: o papel dele, tal como gravado", () => {
    expect(resolveReporterRole([{ role: "implementer" }])).toBe("implementer");
    expect(resolveReporterRole([{ role: "reviewer" }])).toBe("reviewer");
  });

  it("vários vínculos com o MESMO papel: esse papel", () => {
    expect(resolveReporterRole([{ role: "reviewer" }, { role: "reviewer" }])).toBe("reviewer");
  });

  it("sem vínculo nenhum: null (desconhecido), não implementer", () => {
    expect(resolveReporterRole([])).toBeNull();
  });

  it("vínculos com papéis diferentes: null — o report é por card e não diz de qual task fala", () => {
    expect(resolveReporterRole([{ role: "implementer" }, { role: "reviewer" }])).toBeNull();
  });

  it("papel fora do enum é repassado como fato gravado, não normalizado", () => {
    expect(resolveReporterRole([{ role: "observer" }])).toBe("observer");
  });
});

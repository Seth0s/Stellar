import { describe, it, expect } from "vitest";
import {
  DEP_POINTER_MARKER,
  appendDepPointer,
  buildDepPointer,
  depIdsFromJson,
  summarizeReport,
  type DepPointerSource,
} from "../../src/main/dep-pointer-decision";

/**
 * dep-pointer-decision.ts — the parent POINTER a dependent's brief gets.
 * Pure: the id list comes from `deps_json`, the state per parent from
 * stored facts (status, latest report per linked card). Pins:
 *  - empty deps → brief byte-identical, including `undefined`;
 *  - 1 dep / N deps → one line per parent, ids verbatim, card ids for
 *    `read_report` without a `get_task` round-trip;
 *  - a parent with NO report says so and tells the child to verify;
 *  - `ok:false` and a verdict (column or JSON body) are surfaced;
 *  - an id that matches no task is stated, not dropped.
 */

const okDep: DepPointerSource = {
  id: "e83d2c10-92c1-4794-9800-a3fc63452400",
  status: "done",
  reports: [{ cardId: "471", ok: true, verdict: null }],
};

describe("dep-pointer-decision: appendDepPointer", () => {
  it("deps vazio deixa o brief exatamente como estava (regressão)", () => {
    expect(appendDepPointer("i18n fase 2", [])).toBe("i18n fase 2");
    expect(appendDepPointer(undefined, [])).toBeUndefined();
    expect(buildDepPointer([])).toBeUndefined();
  });

  it("1 dep: prompt intacto acima, ponteiro abaixo com id, status e card do relatório", () => {
    const out = appendDepPointer("fase 2", [okDep])!;
    expect(out.startsWith("fase 2\n\n---\n" + DEP_POINTER_MARKER)).toBe(true);
    expect(out).toContain("depends on 1 parent task.");
    expect(out).toContain("get_task");
    expect(out).toContain("read_report");
    expect(out).toContain("acbridge get-task");
    expect(out).toContain(`- ${okDep.id} — status done; read_report on card 471: ok`);
    // Pointer, not content: nothing of a report body is pasted.
    expect(out).not.toContain("summary");
  });

  it("N deps: uma linha por pai, na ordem do deps_json", () => {
    const second: DepPointerSource = { id: "97f34bf8-0000-0000-0000-000000000000", status: "done", reports: [{ cardId: "325", ok: true, verdict: "aprovado" }] };
    const out = appendDepPointer("filho", [okDep, second])!;
    expect(out).toContain("depends on 2 parent tasks.");
    const lines = out.split("\n");
    const i1 = lines.findIndex((l) => l.startsWith(`- ${okDep.id}`));
    const i2 = lines.findIndex((l) => l.startsWith(`- ${second.id}`));
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(lines[i2]).toContain("card 325: ok, verdict aprovado");
  });

  it("dep sem relatório: o ponteiro diz que não há relatório e manda verificar", () => {
    const silent: DepPointerSource = { id: "ceaabaac-4553-475f-95ff-64b5d12f494a", status: "done", reports: [] };
    const out = appendDepPointer("filho", [silent])!;
    expect(out).toContain(`- ${silent.id} — status done, NO report on file`);
    expect(out).toContain("verify its work yourself");
    expect(out).not.toContain("read_report on card");
  });

  it("dep com relatório ok:false é marcado como FAILED", () => {
    const failed: DepPointerSource = { id: "dead", status: "done", reports: [{ cardId: "9", ok: false, verdict: null }] };
    expect(appendDepPointer("x", [failed])).toContain("card 9: ok:false (FAILED");
  });

  it("dep cujo id não bate com task nenhuma é dito, não engolido", () => {
    const ghost: DepPointerSource = { id: "nope", status: null, reports: [] };
    expect(appendDepPointer("x", [ghost])).toContain("- nope — task not found");
  });

  it("task com deps mas sem prompt recebe só o ponteiro (não abre muda e sem pai)", () => {
    const out = appendDepPointer(undefined, [okDep])!;
    expect(out.startsWith(DEP_POINTER_MARKER)).toBe(true);
    expect(out).not.toContain("---");
  });
});

describe("dep-pointer-decision: depIdsFromJson / summarizeReport", () => {
  it("deps_json nulo, vazio, malformado ou com lixo vira lista limpa", () => {
    expect(depIdsFromJson(null)).toEqual([]);
    expect(depIdsFromJson("[]")).toEqual([]);
    expect(depIdsFromJson("not json")).toEqual([]);
    expect(depIdsFromJson('{"a":1}')).toEqual([]);
    expect(depIdsFromJson('["a", 3, "", null, "b"]')).toEqual(["a", "b"]);
  });

  it("ok e verdict saem do corpo; a coluna verdict vence o corpo", () => {
    expect(summarizeReport("1", '{"ok":true,"verdict":"reprovado"}', null)).toEqual({ cardId: "1", ok: true, verdict: "reprovado" });
    expect(summarizeReport("1", '{"ok":true,"verdict":"reprovado"}', "aprovado")).toEqual({ cardId: "1", ok: true, verdict: "aprovado" });
    expect(summarizeReport("1", '{"ok":false}', null)).toEqual({ cardId: "1", ok: false, verdict: null });
    expect(summarizeReport("1", "garbage", null)).toEqual({ cardId: "1", ok: undefined, verdict: null });
    expect(summarizeReport("1", '{"ok":"yes"}', null).ok).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  describeGateLine,
  gateCommandOf,
  gatesFromJson,
  gatesToJson,
  isExclusiveGate,
  normalizeGateList,
  normalizeGateSpec,
  sameGateList,
} from "../../src/main/gate-declaration";

/**
 * Task ff24b36d — a FORMA de um gate: string (de sempre) OU `{cmd, exclusive}`.
 * Compatibilidade com string é requisito; objeté sem `exclusive` volta à forma
 * antiga; `exclusive` desconhecido é RECUSADO (nunca vira "normal" em silêncio).
 */

describe("normalizeGateSpec", () => {
  it("string não-vazia passa (trimada); vazia/só espaço recusa", () => {
    expect(normalizeGateSpec("  npm run check:types  ")).toBe("npm run check:types");
    expect(normalizeGateSpec("")).toBeNull();
    expect(normalizeGateSpec("   ")).toBeNull();
  });

  it("objeto com exclusive:'machine' passa", () => {
    expect(normalizeGateSpec({ cmd: "npx lighthouse http://x", exclusive: "machine" })).toEqual({
      cmd: "npx lighthouse http://x",
      exclusive: "machine",
    });
  });

  it("objeto SEM exclusive vira a string (forma antiga)", () => {
    expect(normalizeGateSpec({ cmd: "npm test" })).toBe("npm test");
  });

  it("exclusive desconhecido / cmd vazio / shape errado RECUSAM", () => {
    expect(normalizeGateSpec({ cmd: "x", exclusive: "repo" })).toBeNull();
    expect(normalizeGateSpec({ cmd: "  " })).toBeNull();
    expect(normalizeGateSpec({ exclusive: "machine" })).toBeNull();
    expect(normalizeGateSpec(7)).toBeNull();
    expect(normalizeGateSpec(null)).toBeNull();
    expect(normalizeGateSpec(["x"])).toBeNull();
  });
});

describe("normalizeGateList", () => {
  it("lista mista preserva ordem e duplicatas", () => {
    expect(normalizeGateList(["a", { cmd: "b", exclusive: "machine" }, "a"])).toEqual([
      "a",
      { cmd: "b", exclusive: "machine" },
      "a",
    ]);
  });

  it("uma entrada ruim recusa a lista INTEIRA (nunca parcial)", () => {
    expect(normalizeGateList(["a", 7])).toBeNull();
  });

  it("vazia/ausente → null", () => {
    expect(normalizeGateList([])).toBeNull();
    expect(normalizeGateList(undefined)).toBeNull();
    expect(normalizeGateList(null)).toBeNull();
  });
});

describe("gate helpers", () => {
  it("gateCommandOf / isExclusiveGate", () => {
    expect(gateCommandOf("a")).toBe("a");
    expect(gateCommandOf({ cmd: "b", exclusive: "machine" })).toBe("b");
    expect(isExclusiveGate("a")).toBe(false);
    expect(isExclusiveGate({ cmd: "b", exclusive: "machine" })).toBe(true);
  });

  it("describeGateLine marca o escopo só quando exclusivo", () => {
    expect(describeGateLine("npm test")).toBe("npm test");
    expect(describeGateLine({ cmd: "lighthouse", exclusive: "machine" })).toContain("lighthouse");
    expect(describeGateLine({ cmd: "lighthouse", exclusive: "machine" })).toContain("exclusive: machine");
  });

  it("sameGateList compara por valor (ordem importa)", () => {
    expect(sameGateList(["a"], ["a"])).toBe(true);
    expect(sameGateList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameGateList([{ cmd: "a", exclusive: "machine" }], ["a"])).toBe(false);
    expect(sameGateList([{ cmd: "a", exclusive: "machine" }], [{ cmd: "a", exclusive: "machine" }])).toBe(true);
  });
});

describe("gatesToJson / gatesFromJson", () => {
  it("round-trip de string e objeto", () => {
    const list = ["a", { cmd: "b", exclusive: "machine" } as const];
    const json = gatesToJson([...list]);
    expect(gatesFromJson(json)).toEqual(list);
  });

  it("linha ANTIGA (só strings) continua lendo — compatibilidade", () => {
    expect(gatesFromJson(JSON.stringify(["npm test", "npm run lint"]))).toEqual(["npm test", "npm run lint"]);
  });

  it("JSON podre / shape errado → null (não declarado), nunca lista inventada", () => {
    expect(gatesFromJson("{ not json")).toBeNull();
    expect(gatesFromJson(JSON.stringify({ gates: 1 }))).toBeNull();
    expect(gatesFromJson(null)).toBeNull();
  });
});

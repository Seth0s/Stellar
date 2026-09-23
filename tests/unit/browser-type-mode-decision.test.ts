import { describe, expect, it } from "vitest";
import {
  decideTypeMode,
  describeNotEditable,
  describeNotFocused,
  type TypeTargetFacts,
} from "../../src/main/browser-type-mode-decision";

/**
 * `browser_type` com `replace: true` (task 770abd6e) na camada que decide.
 *
 * O defeito medido: `#company-name-input` ficou "Idy PlatformIdy Platform" —
 * o agente SOMOU ao que o humano já tinha digitado. O que este módulo decide é
 * estreito e é o que o smoke não consegue provar sem navegador: QUANDO
 * substituir é permitido, e quando é recusado por nome.
 */
function facts(overrides: Partial<TypeTargetFacts> = {}): TypeTargetFacts {
  return { tag: "input", editable: true, readOnly: false, disabled: false, focused: true, ...overrides };
}

describe("decideTypeMode — substituir, anexar, ou recusar", () => {
  it("sem `replace`, o comportamento de sempre (append) segue igual", () => {
    expect(decideTypeMode({ replace: false, describe: "selector \"#x\"", facts: null })).toEqual({
      action: "type",
      replace: false,
    });
  });

  it("com `replace` num campo editável e focado: substitui", () => {
    expect(decideTypeMode({ replace: true, describe: "selector \"#x\"", facts: facts() })).toEqual({
      action: "type",
      replace: true,
    });
  });

  it("RECUSA quando o alvo não é campo editável (um div) — nada é digitado", () => {
    const decision = decideTypeMode({
      replace: true,
      describe: "selector \"#nao-editavel\"",
      facts: facts({ tag: "div", editable: false }),
    });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.error).toContain("not an editable field");
    expect(decision.error).toContain("nothing was typed");
  });

  it("RECUSA em readonly e em disabled, nomeando qual dos dois", () => {
    const ro = decideTypeMode({ replace: true, describe: "s", facts: facts({ readOnly: true }) });
    const dis = decideTypeMode({ replace: true, describe: "s", facts: facts({ disabled: true }) });
    expect(ro.action).toBe("refuse");
    expect(dis.action).toBe("refuse");
    if (ro.action === "refuse") expect(ro.error).toContain("readonly");
    if (dis.action === "refuse") expect(dis.error).toContain("disabled");
  });

  it("RECUSA quando não deu para ler o alvo: selecionar tudo às cegas seleciona o DOCUMENTO", () => {
    const decision = decideTypeMode({ replace: true, describe: "the focused element", facts: null });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.error).toContain("selects the whole document");
  });

  it("RECUSA quando o foco não pousou — o clear agiria em OUTRO campo", () => {
    // Medido: sem esperar o foco, o `selectAll` limpava nada e o `insertText`
    // seguinte virava append — o defeito original, intermitente.
    const decision = decideTypeMode({ replace: true, describe: "selector \"#x\"", facts: facts({ focused: false }) });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.error).toContain("never took focus");
  });

  it("as frases de recusa dizem que NADA foi digitado", () => {
    expect(describeNotEditable('selector "#x"', facts({ tag: "div", editable: false }))).toContain("nothing was typed");
    expect(describeNotFocused('selector "#x"')).toContain("Nothing was typed");
  });
});

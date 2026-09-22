import { describe, expect, it } from "vitest";
import {
  decideSnapshotTarget,
  describeSnapshotSkip,
  isCheckableInput,
  type SnapshotControlFacts,
} from "../../src/main/browser-snapshot-target-decision";

/**
 * O snapshot que omitia 40 rádios (task 4bdb257e), na camada que decide.
 *
 * As formas de esconder NÃO são equivalentes — o probe real contra o build
 * mediu cada uma: `opacity:0` era omitido, `left:-9999px` era LISTADO (e o
 * clique não acontecia), `width:0;height:0` era listado (e o clique não
 * acertava o input), `display:none` + label visível era omitido, mesmo com o
 * clique no label funcionando. Estes testes fixam a decisão para as quatro,
 * sem depender do navegador.
 */
function facts(overrides: Partial<SnapshotControlFacts> = {}): SnapshotControlFacts {
  return {
    tag: "input",
    selfVisible: true,
    pointInViewport: true,
    pointHitsSelf: true,
    label: null,
    ...overrides,
  };
}

describe("decideSnapshotTarget — o que entra no snapshot, e onde vai o ref", () => {
  it("controle com caixa visível e ponto acertando ele mesmo: ref nele", () => {
    expect(decideSnapshotTarget(facts())).toEqual({ list: true, refOn: "self" });
  });

  it("`opacity: 0` com label associado visível: LISTA, e o ref vai no label — o caso do relato", () => {
    const decision = decideSnapshotTarget(
      facts({ selfVisible: false, label: { kind: "for", visible: true } }),
    );
    expect(decision).toEqual({ list: true, refOn: "label", via: "label" });
  });

  it("`display: none` com label visível: LISTA (clicar o label funciona de verdade)", () => {
    expect(decideSnapshotTarget(facts({ selfVisible: false, label: { kind: "for", visible: true } })).list).toBe(true);
  });

  it("label ANCESTRAL (sem `for`) vale igual: é a associação mais comum do sr-only", () => {
    expect(decideSnapshotTarget(facts({ selfVisible: false, label: { kind: "wrapping", visible: true } }))).toEqual({
      list: true,
      refOn: "label",
      via: "label",
    });
  });

  it("`position:absolute; left:-9999px`: o ponto sai da viewport, então o ref vai no label", () => {
    // Medido: este é o caso em que o snapshot de hoje LISTA e o clique não
    // acontece (o ponto está fora da viewport e browser_click recusa).
    expect(decideSnapshotTarget(facts({ pointInViewport: false, label: { kind: "for", visible: true } }))).toEqual({
      list: true,
      refOn: "label",
      via: "label",
    });
  });

  it("0×0 sem label: FORA — um ref que não leva a clique nenhum é a mentira oposta", () => {
    const decision = decideSnapshotTarget(facts({ selfVisible: false, pointInViewport: false, pointHitsSelf: false }));
    expect(decision.list).toBe(false);
  });

  it("passo de formulário fechado (input e label escondidos juntos): FORA", () => {
    const decision = decideSnapshotTarget(
      facts({ selfVisible: false, pointInViewport: false, label: { kind: "for", visible: false } }),
    );
    expect(decision.list).toBe(false);
    if (decision.list) return;
    expect(decision.reason).toContain("label");
  });

  it("coberto por outra coisa no ponto: sem label visível, FORA; com label, o label", () => {
    const covered = facts({ pointHitsSelf: false });
    expect(decideSnapshotTarget(covered).list).toBe(false);
    expect(decideSnapshotTarget({ ...covered, label: { kind: "wrapping", visible: true } })).toEqual({
      list: true,
      refOn: "label",
      via: "label",
    });
  });

  it("a razão da omissão nomeia o fato medido (diagnóstico, não opinião)", () => {
    expect(describeSnapshotSkip(facts({ selfVisible: false, label: null }))).toContain("no visible box of its own");
    expect(describeSnapshotSkip(facts({ pointInViewport: false }))).toContain("outside the viewport");
    expect(describeSnapshotSkip(facts({ pointHitsSelf: false }))).toContain("on top of its point");
    expect(describeSnapshotSkip(facts({ label: { kind: "for", visible: false } }))).toContain("not visible");
  });

  it("`checked`/`group` só fazem sentido em rádio e checkbox", () => {
    expect(isCheckableInput("radio")).toBe(true);
    expect(isCheckableInput("checkbox")).toBe(true);
    expect(isCheckableInput("text")).toBe(false);
    expect(isCheckableInput(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  CLICK_DRIFT_TOLERANCE_PX,
  clickDipScale,
  clickDrift,
  decideClickVerdict,
  describeLayoutMoved,
  describeMultiMatch,
  describeNoElementAtPoint,
  describePointOutsideViewport,
  describeTargetCovered,
  targetOutsideViewport,
  type ClickIntent,
  type ClickSite,
  type ClickTargetDescriptor,
} from "../../src/main/browser-click-decision";

const viewport = { width: 1340, height: 852 };

function descriptor(id: string, tag = "button"): ClickTargetDescriptor {
  return { tag, id, role: null, text: id.toUpperCase() };
}

function elementIntent(id: string, matched = 1): Extract<ClickIntent, { kind: "element" }> {
  return { kind: "element", describe: `selector "#${id}"`, target: descriptor(id), matched };
}

function site(overrides: Partial<ClickSite> = {}): ClickSite {
  return {
    intent: elementIntent("alvo"),
    point: { x: 700, y: 400 },
    hit: descriptor("alvo"),
    relation: "self",
    viewport,
    drift: { dx: 0, dy: 0 },
    ...overrides,
  };
}

describe("decideClickVerdict — o que a resposta pode afirmar", () => {
  it("clicar no alvo, com o layout parado, é sucesso e devolve o alvo nomeado", () => {
    const verdict = decideClickVerdict(site());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.target.id).toBe("alvo");
    expect(verdict.matched).toBe(1);
    expect(verdict.warning).toBeNull();
  });

  it("um filho dentro do alvo (`<span>` num botão) continua sendo o mesmo alvo", () => {
    const verdict = decideClickVerdict(
      site({ hit: { tag: "span", id: null, role: null, text: "Enviar" }, relation: "descendant" }),
    );
    expect(verdict.ok).toBe(true);
  });

  it("RECUSA nomeando o motivo quando o ponto cai fora da viewport", () => {
    const verdict = decideClickVerdict(
      site({ point: { x: 200, y: 9000 }, hit: null, relation: "none" }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain("outside the page's viewport");
    expect(verdict.error).toContain("(200, 9000)");
    expect(verdict.error).toContain("Nothing was clicked");
  });

  it("RECUSA quando não há elemento nenhum no ponto", () => {
    const verdict = decideClickVerdict(site({ hit: null, relation: "none" }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain("nothing is at the point");
  });

  it("RECUSA quando o alvo se moveu entre a resolução e o disparo — o defeito relatado", () => {
    const verdict = decideClickVerdict(site({ drift: { dx: 0, dy: 160 } }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain("the page was still moving");
    expect(verdict.error).toContain("(0, 160)");
    expect(verdict.error).toContain("Nothing was clicked");
  });

  it("movimento dentro da tolerância não invalida o clique", () => {
    const verdict = decideClickVerdict(site({ drift: { dx: CLICK_DRIFT_TOLERANCE_PX, dy: -1 } }));
    expect(verdict.ok).toBe(true);
  });

  it("RECUSA quando outra coisa está por cima, nomeando os DOIS", () => {
    const verdict = decideClickVerdict(site({ hit: descriptor("over", "div"), relation: "other" }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toContain("#alvo");
    expect(verdict.error).toContain("#over");
    expect(verdict.error).toContain("covered by");
  });

  it("seletor que casa N elementos: clica o primeiro e AVISA qual foi", () => {
    const verdict = decideClickVerdict(site({ intent: elementIntent("salvar", 2) }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.matched).toBe(2);
    expect(verdict.warning).toContain("matched 2 elements");
    expect(verdict.warning).toContain("#salvar");
  });

  it("clique por PONTO não tem intenção: reporta o que está ali, sem inventar recusa", () => {
    const verdict = decideClickVerdict(
      site({
        intent: { kind: "point" },
        hit: descriptor("qualquer", "div"),
        relation: "other",
        drift: null,
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.target.id).toBe("qualquer");
    expect(verdict.matched).toBe(0);
  });

  it("clique por PONTO sem elemento nenhum continua sendo recusa", () => {
    const verdict = decideClickVerdict(
      site({ intent: { kind: "point" }, hit: null, relation: "none", drift: null }),
    );
    expect(verdict.ok).toBe(false);
  });

  it("ponto exatamente na borda da viewport ainda conta como dentro", () => {
    expect(targetOutsideViewport({ x: 1340, y: 852 }, viewport)).toBe(false);
    expect(targetOutsideViewport({ x: 1340.5, y: 852 }, viewport)).toBe(true);
    expect(targetOutsideViewport({ x: -1, y: 10 }, viewport)).toBe(true);
  });

  it("o fator px-logicos -> DIP e a RAZAO medida, nao um palpite", () => {
    // Medido: viewport logico 1340 e conteudo 2680 DIP => cliques chegavam na
    // METADE (670 -> 335, 47.5 -> 24) e marcavam a linha de cima.
    expect(clickDipScale(2680, 1340)).toBe(2);
    // A outra geometria medida: 2680 DIP / 2680 CSS => fator 1 (por isso o
    // defeito nao aparecia em todo run).
    expect(clickDipScale(2680, 2680)).toBe(1);
  });

  it("leitura invalida do conteudo nao inventa fator: cai no comportamento antigo (1)", () => {
    expect(clickDipScale(0, 1340)).toBe(1);
    expect(clickDipScale(2680, 0)).toBe(1);
    expect(clickDipScale(Number.NaN, 1340)).toBe(1);
    expect(clickDipScale(99999, 10)).toBe(1);
  });

  it("clickDrift devolve o vetor do movimento e `null` quando não há rect de alvo", () => {
    expect(
      clickDrift({ x: 10, y: 20, width: 1, height: 1 }, { x: 10, y: 180, width: 1, height: 1 }),
    ).toEqual({
      dx: 0,
      dy: 160,
    });
    expect(clickDrift(null, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });

  it("cada frase de recusa nomeia o fato medido e diz que nada foi clicado", () => {
    const intent = elementIntent("alvo");
    for (const text of [
      describePointOutsideViewport({ x: 1, y: 2 }, viewport),
      describeNoElementAtPoint({ x: 1, y: 2 }),
      describeTargetCovered(intent, { x: 1, y: 2 }, descriptor("over", "div")),
      describeLayoutMoved(intent, { dx: 0, dy: 5 }, { x: 1, y: 2 }),
    ]) {
      expect(text).toContain("Nothing was clicked");
      expect(text).not.toContain("ok: true");
    }
    expect(describeMultiMatch(3, descriptor("a"), 'selector "button"')).toContain(
      "matched 3 elements",
    );
  });
});

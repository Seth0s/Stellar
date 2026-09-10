import { describe, it, expect } from "vitest";
import {
  computeCompassLayout,
  MIN_STRIP_WIDTH,
  OUTER_GAP,
  FULL_HARD_CAP,
  COMPACT_CHIP_W,
  GAP,
} from "../../src/renderer/src/Compass";

/**
 * Pedido real do dono do repo, com screenshot da topbar (2026-09-09): "a
 * bússola na topbar não aproveita o espaço que tem, ela comprime mesmo
 * tendo bastante espaço sobrando na topbar, e não mostra seta indicadora
 * nesse estado comprimido". `computeCompassLayout` é o núcleo puro
 * extraído do componente — sem DOM, sem React — exatamente pra poder
 * travar esses dois defeitos como regressão sem montar `<Compass/>` nem
 * abrir o app de verdade.
 */

type Fixture = { bearing: number; label: string };

function candidate(bearing: number, label = "card"): Fixture {
  return { bearing, label };
}

describe("computeCompassLayout: sem teto fixo de largura (DEFEITO 1)", () => {
  it("numa janela larga com muito espaço livre, a fita usa TODO o espaço livre — não trava em nenhum valor fixo", () => {
    // ~2400px livres entre os vizinhos, como no relato ao vivo original
    // (2026-09-06/09). Decisão final do dono do repo: sem teto nenhum —
    // `stripWidth` é exatamente `availableRight - availableLeft`.
    const titleRight = 400;
    const zoomPillLeft = 2800;
    const result = computeCompassLayout([candidate(0)], {
      titleRight,
      zoomPillLeft,
      windowInnerWidth: 3795,
    });

    const expectedWidth = zoomPillLeft - OUTER_GAP - (titleRight + OUTER_GAP);
    expect(result.stripWidth).toBe(expectedWidth);
    expect(result.stripWidth).toBeGreaterThan(460); // sintoma original: travava em 460
    expect(result.stripWidth).toBeGreaterThan(960); // regressão: não pode voltar a travar num teto "mais alto" também
  });

  it("numa tela ultrawide (5000px+), continua sem teto — usa o espaço inteiro, sem guarda-chuva de sanidade", () => {
    const titleRight = 200;
    const zoomPillLeft = 5000;
    const result = computeCompassLayout([candidate(0)], {
      titleRight,
      zoomPillLeft,
      windowInnerWidth: 5200,
    });

    expect(result.stripWidth).toBe(zoomPillLeft - OUTER_GAP - (titleRight + OUTER_GAP));
  });

  it("nunca ultrapassa o espaço realmente livre entre os vizinhos", () => {
    const result = computeCompassLayout([candidate(0)], {
      titleRight: 1000,
      zoomPillLeft: 1300,
      windowInnerWidth: 2000,
    });

    expect(result.stripWidth).toBeLessThanOrEqual(1300 - OUTER_GAP - (1000 + OUTER_GAP));
    expect(result.stripLeft).toBeGreaterThanOrEqual(1000 + OUTER_GAP);
    expect(result.stripLeft + result.stripWidth).toBeLessThanOrEqual(1300 - OUTER_GAP);
  });

  it("respeita o piso mínimo quando o espaço livre é menor que MIN_STRIP_WIDTH", () => {
    const result = computeCompassLayout([candidate(0)], {
      titleRight: 990,
      zoomPillLeft: 1000,
      windowInnerWidth: 2000,
    });

    expect(result.stripWidth).toBe(MIN_STRIP_WIDTH);
  });

  it("largura de sobra deixa de forçar modo compacto sem necessidade: poucos chips cabem em completo", () => {
    // 3 candidatos, bem abaixo de FULL_HARD_CAP, com rótulos curtos —
    // numa fita larga de verdade eles cabem tranquilamente no modo
    // completo. Antes do fix, um teto fixo (460, depois 960) bastava pra
    // empurrar pro compacto em janelas bem menores que isso.
    const result = computeCompassLayout([candidate(10, "a"), candidate(90, "b"), candidate(-120, "c")], {
      titleRight: 400,
      zoomPillLeft: 2800,
      windowInnerWidth: 3795,
    });

    expect(result.compact).toBe(false);
  });
});

describe("computeCompassLayout: modo compacto — empacotamento e '+N'", () => {
  it("acima de FULL_HARD_CAP candidatos sempre entra em modo compacto", () => {
    const all = Array.from({ length: FULL_HARD_CAP + 1 }, (_, i) => candidate(i));
    const result = computeCompassLayout(all, { titleRight: null, zoomPillLeft: null, windowInnerWidth: 1200 });
    expect(result.compact).toBe(true);
  });

  it("candidatos além do que cabe viram hiddenCount, não somem", () => {
    const all = Array.from({ length: 40 }, (_, i) => candidate((i * 9) % 360));
    const result = computeCompassLayout(all, { titleRight: null, zoomPillLeft: null, windowInnerWidth: 500 });
    expect(result.positioned.length + result.hiddenCount).toBe(all.length);
    expect(result.positioned.length).toBeGreaterThan(0);
  });

  it("chips compactos nunca se sobrepõem (respiro mínimo GAP entre bordas)", () => {
    const all = Array.from({ length: 15 }, (_, i) => candidate((i * 24) % 360 - 180));
    const result = computeCompassLayout(all, { titleRight: null, zoomPillLeft: null, windowInnerWidth: 900 });
    expect(result.compact).toBe(true);

    for (let i = 1; i < result.positioned.length; i++) {
      const prev = result.positioned[i - 1];
      const cur = result.positioned[i];
      expect(cur.x - cur.w / 2).toBeGreaterThanOrEqual(prev.x + prev.w / 2 + GAP - 0.001);
    }
  });

  it("nenhum chip sai da fita (bolinha de gude clampada nas pontas)", () => {
    const all = [candidate(179), candidate(-179), candidate(178), candidate(-178)];
    const result = computeCompassLayout(all, { titleRight: 0, zoomPillLeft: 200, windowInnerWidth: 800 });
    for (const p of result.positioned) {
      expect(p.x - p.w / 2).toBeGreaterThanOrEqual(-0.001);
      expect(p.x + p.w / 2).toBeLessThanOrEqual(result.stripWidth + 0.001);
    }
  });

  it("chip compacto usa largura fixa COMPACT_CHIP_W", () => {
    const all = Array.from({ length: 10 }, (_, i) => candidate(i * 30));
    const result = computeCompassLayout(all, { titleRight: null, zoomPillLeft: null, windowInnerWidth: 900 });
    expect(result.compact).toBe(true);
    for (const p of result.positioned) {
      expect(p.w).toBe(COMPACT_CHIP_W);
    }
  });
});

describe("computeCompassLayout: posicionamento por rumo", () => {
  it("bearing 0 cai no centro da fita (antes do empacotamento distorcer)", () => {
    const result = computeCompassLayout([candidate(0)], { titleRight: null, zoomPillLeft: null, windowInnerWidth: 1000 });
    expect(result.positioned[0].x).toBeCloseTo(result.stripWidth / 2, 5);
  });
});

import { describe, it, expect } from "vitest";
import {
  nearestFreeSlot,
  hierarchicalLayout,
  rectsOverlap,
  rectCenter,
  MIN_GAP,
  EDGE_SEARCH_RADIUS,
  type Rect,
  type ExistingRect,
  type GraphNode,
  type GraphEdge,
} from "../../src/renderer/src/board-model";

/**
 * Pedido do dono do repo, com screenshot (2026-09-09): cards existentes
 * formavam um cluster no canto superior esquerdo, um vazio enorme no meio
 * do board, e o card novo nascia longe, na diagonal inferior direita —
 * `centeredSlot`'s ring-search antigo aceitava a PRIMEIRA posição livre na
 * ordem fixa de 8 direções (a diagonal vinha antes de uma direção cardeal
 * mais perto), e "livre" era só `!rectsOverlap`, sem folga mínima.
 *
 * 2a rodada (review adversarial reprovou o 1º diff, 4 achados — ver
 * layout-round2.md): esta suíte foi reescrita pra cobrir os 4: ids
 * numéricos comparados como texto (achado 1), degrade que podia plantar
 * sobre um card de navegador (achado 2), candidatos só em 8 raios fixos
 * (achado 3) e barycenter com desempate por string em vez de id numérico
 * (achado 4).
 */
describe("nearestFreeSlot: placement de spawn por custo", () => {
  it("usa o slot base como está quando nada colide", () => {
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    expect(nearestFreeSlot(base, [])).toEqual(base);
  });

  it("colisão resolve pro vizinho mais PRÓXIMO livre, não pela ordem fixa da bússola", () => {
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const existingRects: Rect[] = [
      { x: 0, y: 0, w: 20, h: 20 }, // ocupa o próprio slot base
      { x: 60, y: 0, w: 20, h: 20 }, // "direita" (1ª direção da bússola antiga) bloqueada
      { x: 0, y: 60, w: 20, h: 20 }, // "baixo" bloqueada
      { x: 0, y: -60, w: 20, h: 20 }, // "cima" bloqueada
      // "direita-baixo" (2ª direção da bússola antiga, na diagonal) fica
      // livre de propósito — é o que a ordem fixa antiga escolheria.
    ];

    const result = nearestFreeSlot(base, existingRects);

    // Candidato de BORDA (achado 3 — encostado à esquerda do próprio slot
    // base, só 24px de folga em vez dos 60px de um passo de anel): mais
    // perto do anchor que qualquer candidato de anel, cardeal ou diagonal.
    expect(result).toEqual({ x: -44, y: 0, w: 20, h: 20 });
    // Regressão: a ordem fixa antiga pararia na primeira livre que
    // encontrasse, a diagonal "direita-baixo" — bem mais longe.
    expect(result).not.toEqual({ x: 60, y: 60, w: 20, h: 20 });
  });

  it("respeita folga mínima — encostar (0px de gap) não conta mais como livre", () => {
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const touching: Rect = { x: 20, y: 0, w: 20, h: 20 }; // toca a borda direita do base
    expect(rectsOverlap(base, touching)).toBe(false); // critério antigo aceitaria isso

    const result = nearestFreeSlot(base, [touching]);

    expect(result).not.toEqual(base);
    const inflatedResult: Rect = { x: result.x - MIN_GAP, y: result.y - MIN_GAP, w: result.w + MIN_GAP * 2, h: result.h + MIN_GAP * 2 };
    expect(rectsOverlap(inflatedResult, touching)).toBe(false);
  });

  it("prefere um candidato dentro do visibleRect quando a distância empata", () => {
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const occupiesBase: Rect = { x: 0, y: 0, w: 20, h: 20 };
    // Cobre a faixa horizontal do candidato de borda "esquerda" — exclui
    // "direita" (mesma distância) e qualquer candidato de anel (todos mais
    // longe de qualquer forma).
    const visible: Rect = { x: -100, y: -10, w: 150, h: 40 };

    const result = nearestFreeSlot(base, [occupiesBase], visible);

    expect(result).toEqual({ x: -44, y: 0, w: 20, h: 20 });
  });

  it("acha vaga que só existe como candidato de BORDA, fora dos 8 raios fixos do anel", () => {
    // Um único obstáculo do mesmo tamanho do slot: a vaga mais próxima de
    // verdade é encostada nele (24px de folga), não em nenhum dos raios de
    // 60px em 60px do ring-search — se `edgeCandidates` sumir, a busca só
    // acha o vizinho de anel (bem mais longe) ou degrada.
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const obstacle: Rect = { x: 0, y: 0, w: 20, h: 20 };

    const result = nearestFreeSlot(base, [obstacle]);

    expect(rectsOverlap(result, obstacle)).toBe(false);
    const distToAnchor = Math.hypot(result.x + 10 - 10, result.y + 10 - 10);
    expect(distToAnchor).toBeLessThan(60); // mais perto que qualquer candidato de anel (ring1 = 60)
  });

  it("degrada pro candidato de menor overlap quando saturado, sem travar (nada bloqueante)", () => {
    // "Rosca" ao redor do próprio slot base: cobre todo o raio de anel E
    // toda borda alcançável a partir do obstáculo que ocupa o buraco. As 4
    // paredes ficam a só 10px do anchor pela distância ponto-retângulo
    // (então entram como candidatas de borda), mas toda borda delas nasce
    // dentro de OUTRA parede (o próprio buraco é pequeno — 20×20 — sertado
    // por paredes de milhares de pixels) ou é podada pelo teto de distância
    // do candidato — nenhuma vira um escape de verdade, e o buraco continua
    // sendo a única posição com folga zero contra alguma coisa.
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const hole: Rect = { x: 0, y: 0, w: 20, h: 20 }; // ocupa exatamente o buraco da rosca
    const topWall: Rect = { x: -2000, y: -3000, w: 4000, h: 3000 };
    const bottomWall: Rect = { x: -2000, y: 20, w: 4000, h: 3000 };
    const leftWall: Rect = { x: -3000, y: 0, w: 3000, h: 20 };
    const rightWall: Rect = { x: 20, y: 0, w: 3000, h: 20 };

    const result = nearestFreeSlot(base, [hole, topWall, bottomWall, leftWall, rightWall]);

    expect(result.w).toBe(20);
    expect(result.h).toBe(20);
    // Todo candidato fica igualmente coberto (overlap bruto empatado) — sem
    // nenhum rect marcado como bloqueante, o desempate por distância faz o
    // próprio base vencer.
    expect(result).toEqual(base);
  });

  it("degrade NUNCA escolhe uma posição que sobrepõe um card de navegador, mesmo que a alternativa tenha mais overlap", () => {
    // Mesma "rosca" do teste acima, mas agora quem ocupa o buraco é um card
    // de navegador (`blocking: true`) — o desempate por menor overlap bruto
    // empataria em base (igual ao teste anterior), só que base sobrepõe o
    // navegador. O resultado tem que ser outro lugar, mesmo que o overlap
    // bruto ali seja pior (não é: aqui é o mesmo 400px², mas o ponto é que
    // isso não pode ser o critério).
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const browser: ExistingRect = { rect: { x: 0, y: 0, w: 20, h: 20 }, blocking: true };
    const topWall: ExistingRect = { rect: { x: -2000, y: -3000, w: 4000, h: 3000 }, blocking: false };
    const bottomWall: ExistingRect = { rect: { x: -2000, y: 20, w: 4000, h: 3000 }, blocking: false };
    const leftWall: ExistingRect = { rect: { x: -3000, y: 0, w: 3000, h: 20 }, blocking: false };
    const rightWall: ExistingRect = { rect: { x: 20, y: 0, w: 3000, h: 20 }, blocking: false };

    const result = nearestFreeSlot(base, [browser, topWall, bottomWall, leftWall, rightWall]);

    expect(result).not.toEqual(base);
    expect(rectsOverlap(result, browser.rect)).toBe(false);
  });

  it("é determinístico — mesma entrada (inclusive rects em outra ordem), mesma saída", () => {
    const base: Rect = { x: 10, y: 10, w: 20, h: 20 };
    const existingRects: Rect[] = [
      { x: 10, y: 10, w: 20, h: 20 },
      { x: 70, y: 10, w: 20, h: 20 },
      { x: 10, y: 70, w: 20, h: 20 },
    ];
    const a = nearestFreeSlot(base, existingRects);
    const b = nearestFreeSlot(base, [...existingRects].reverse());
    const c = nearestFreeSlot(base, [existingRects[2], existingRects[0], existingRects[1]]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  // ---- Review adversarial, 3a rodada — `edgeCandidates` media proximidade
  // pelo CENTROIDE do rect em vez da distância ponto-retângulo, e não tinha
  // teto na distância do CANDIDATO gerado. Os 3 testes abaixo cobrem os dois
  // lados do mesmo defeito. ----

  it("um wall gigante centrado no anchor NÃO arremessa o card a milhares de pixels", () => {
    // Antes da correção: o wall (centroide == anchor, dist 0) entrava como
    // candidato de borda, e sua própria borda nascia a ~2000px do anchor —
    // bem além do alcance documentado do anel. Com o teto na distância do
    // CANDIDATO (não só do rect), essas bordas são descartadas e o degrade
    // volta a respeitar o mesmo alcance do ring-search.
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const anchor = rectCenter(base);
    const wall: Rect = { x: -2000, y: -2000, w: 4000, h: 4000 };

    const result = nearestFreeSlot(base, [wall]);

    const dist = Math.hypot(rectCenter(result).x - anchor.x, rectCenter(result).y - anchor.y);
    expect(dist).toBeLessThanOrEqual(EDGE_SEARCH_RADIUS);
  });

  it("achado (b) — rect comprido que só TANGENCIA o anchor tem a borda perto dele encontrada, não descartada por causa do centroide distante", () => {
    // longRect vai de x=30 a x=2030 — centroide em x≈1045, a mais de
    // EDGE_SEARCH_RADIUS (720) do anchor (10,10). Pela distância CENTROIDE
    // (defeito), o rect inteiro seria ignorado. Pela distância ponto-
    // retângulo (correção), a borda esquerda dele está a só 20px do anchor
    // — bem dentro do alcance — e é exatamente a vaga mais próxima livre.
    const base: Rect = { x: 0, y: 0, w: 20, h: 20 };
    const longRect: Rect = { x: 30, y: -10, w: 2000, h: 40 };
    const centroidDist = Math.hypot(rectCenter(longRect).x - rectCenter(base).x, rectCenter(longRect).y - rectCenter(base).y);
    expect(centroidDist).toBeGreaterThan(EDGE_SEARCH_RADIUS); // confirma que é mesmo um caso do achado (b)

    const result = nearestFreeSlot(base, [longRect]);

    // Encostado à esquerda do longRect, com a folga mínima.
    expect(result).toEqual({ x: 30 - MIN_GAP - 20, y: 0, w: 20, h: 20 });
  });

  it("custo com ~250 rects existentes (board grande) é irrelevante — medido, não só suposto", () => {
    const rects: Rect[] = [];
    for (let i = 0; i < 250; i++) {
      rects.push({ x: (i % 20) * 90, y: Math.floor(i / 20) * 90, w: 80, h: 80 });
    }
    const base: Rect = { x: 500, y: 500, w: 1340, h: 900 }; // tamanho real de spawn (SPAWN_W/SPAWN_H)

    const start = performance.now();
    const ITERATIONS = 20;
    for (let i = 0; i < ITERATIONS; i++) nearestFreeSlot(base, rects);
    const elapsedMs = (performance.now() - start) / ITERATIONS;

    // eslint-disable-next-line no-console -- número medido pra relatório, não debug esquecido
    console.log(`nearestFreeSlot com 250 rects existentes: ${elapsedMs.toFixed(3)}ms/chamada`);
    // Generoso de propósito — não é microbenchmark, é uma rede de segurança
    // contra uma regressão de ORDEM DE GRANDEZA (ex.: virar O(n²) de verdade
    // pesado), não um teto de performance apertado.
    expect(elapsedMs).toBeLessThan(50);
  });
});

/** Soma de todos os pares — nenhum pode ficar mais perto que MIN_GAP. */
function assertMinGapRespected(rects: Rect[], minGap = MIN_GAP) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const inflatedA: Rect = { x: a.x - minGap, y: a.y - minGap, w: a.w + minGap * 2, h: a.h + minGap * 2 };
      expect(rectsOverlap(inflatedA, rects[j])).toBe(false);
    }
  }
}

/** Map -> array de entradas ordenado por id, pra comparar dois layouts por
 * valor sem depender da ordem de inserção do Map. */
function sortedEntries(positions: Map<string, Rect>): [string, Rect][] {
  return [...positions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe("hierarchicalLayout: organizar por grafo de conectores", () => {
  it("grafo vazio não gera posição nenhuma", () => {
    const positions = hierarchicalLayout([], []);
    expect(positions.size).toBe(0);
  });

  it("componente linear (pai -> filho -> neto) gera camadas na ordem certa", () => {
    const nodes: GraphNode[] = [
      { id: "a", w: 100, h: 50 },
      { id: "b", w: 100, h: 50 },
      { id: "c", w: 100, h: 50 },
    ];
    const edges: GraphEdge[] = [
      { fromCardId: "a", toCardId: "b" },
      { fromCardId: "b", toCardId: "c" },
    ];
    const positions = hierarchicalLayout(nodes, edges);

    const a = positions.get("a")!;
    const b = positions.get("b")!;
    const c = positions.get("c")!;
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(c.y);
    // Folga exata entre camadas (uma por linha, sem barycenter pra desempatar).
    expect(b.y - (a.y + a.h)).toBe(MIN_GAP);
    expect(c.y - (b.y + b.h)).toBe(MIN_GAP);
    assertMinGapRespected([a, b, c]);
  });

  it("dois componentes não se sobrepõem", () => {
    const nodes: GraphNode[] = [
      { id: "a", w: 50, h: 50 },
      { id: "b", w: 50, h: 50 },
      { id: "c", w: 50, h: 50 },
      { id: "d", w: 50, h: 50 },
    ];
    const edges: GraphEdge[] = [
      { fromCardId: "a", toCardId: "b" },
      { fromCardId: "c", toCardId: "d" },
    ];
    const positions = hierarchicalLayout(nodes, edges);
    assertMinGapRespected([...positions.values()]);
  });

  it("ciclo puro não trava e não duplica nó", () => {
    const nodes: GraphNode[] = [
      { id: "a", w: 40, h: 40 },
      { id: "b", w: 40, h: 40 },
      { id: "c", w: 40, h: 40 },
    ];
    const edges: GraphEdge[] = [
      { fromCardId: "a", toCardId: "b" },
      { fromCardId: "b", toCardId: "c" },
      { fromCardId: "c", toCardId: "a" },
    ];
    const positions = hierarchicalLayout(nodes, edges);

    expect(positions.size).toBe(3);
    // Raiz de fallback = menor id ("a") — camadas em ordem a, b, c.
    expect(positions.get("a")!.y).toBeLessThan(positions.get("b")!.y);
    expect(positions.get("b")!.y).toBeLessThan(positions.get("c")!.y);
    assertMinGapRespected([...positions.values()]);
  });

  it("card isolado (sem conector nenhum) vai pra grade à parte, abaixo do grafo", () => {
    const nodes: GraphNode[] = [
      { id: "a", w: 50, h: 50 },
      { id: "b", w: 50, h: 50 },
      { id: "iso", w: 30, h: 30 },
    ];
    const edges: GraphEdge[] = [{ fromCardId: "a", toCardId: "b" }];
    const positions = hierarchicalLayout(nodes, edges);

    const b = positions.get("b")!;
    const iso = positions.get("iso")!;
    expect(iso.y).toBeGreaterThan(b.y);
    assertMinGapRespected([...positions.values()]);
  });

  it("board sem conector nenhum: todo mundo cai só na grade (comportamento preservado)", () => {
    const nodes: GraphNode[] = [
      { id: "1", w: 40, h: 40 },
      { id: "2", w: 40, h: 40 },
      { id: "3", w: 40, h: 40 },
      { id: "4", w: 40, h: 40 },
    ];
    const positions = hierarchicalLayout(nodes, []);

    expect(positions.size).toBe(4);
    // Grade de 3 colunas — o 4º item quebra pra próxima linha.
    expect(positions.get("4")!.y).toBeGreaterThan(positions.get("1")!.y);
    assertMinGapRespected([...positions.values()]);
  });

  // ---- Review adversarial, 2a rodada ----

  it("achado 1 — grade de isolados usa ordem NUMÉRICA dos ids, não lexicográfica", () => {
    // ".sort()" puro ordenaria ["10", "2", "3"] (texto: "10" < "2" < "3").
    // Numérico correto: 2, 3, 10 — todos cabem numa linha só (grade de 3
    // colunas), então a ordem vira posição x crescente da esquerda pra
    // direita.
    const nodes: GraphNode[] = [
      { id: "10", w: 20, h: 20 },
      { id: "2", w: 20, h: 20 },
      { id: "3", w: 20, h: 20 },
    ];
    const positions = hierarchicalLayout(nodes, []);

    expect(positions.get("2")!.x).toBeLessThan(positions.get("3")!.x);
    expect(positions.get("3")!.x).toBeLessThan(positions.get("10")!.x);
  });

  it("achado 1 — raiz de fallback em ciclo puro é o menor id NUMÉRICO, não o lexicográfico", () => {
    // Ciclo de 2 nós, ids "9" e "10" — nenhum dos dois tem indegree 0.
    // Lexicograficamente "10" < "9" (o dígito '1' vem antes de '9'), então
    // um `.sort()` ingênuo escolheria "10" como raiz. Numericamente 9 < 10,
    // então a raiz certa é "9".
    const nodes: GraphNode[] = [
      { id: "10", w: 40, h: 40 },
      { id: "9", w: 40, h: 40 },
    ];
    const edges: GraphEdge[] = [
      { fromCardId: "9", toCardId: "10" },
      { fromCardId: "10", toCardId: "9" },
    ];
    const positions = hierarchicalLayout(nodes, edges);

    expect(positions.get("9")!.y).toBeLessThan(positions.get("10")!.y);
  });

  it("achado 4 — barycenter empatado desempata pelo id NUMÉRICO, não por comparação de string", () => {
    // "9" e "10" são os dois únicos filhos da mesma raiz — o barycenter dos
    // dois empata exatamente (um único pai em comum, mesma posição). O
    // desempate tem que colocar "9" antes de "10"; a comparação de string
    // ingênua ("10" < "9") os colocaria na ordem errada.
    const nodes: GraphNode[] = [
      { id: "root", w: 100, h: 40 },
      { id: "10", w: 40, h: 40 },
      { id: "9", w: 40, h: 40 },
    ];
    const edges: GraphEdge[] = [
      { fromCardId: "root", toCardId: "10" },
      { fromCardId: "root", toCardId: "9" },
    ];
    const positions = hierarchicalLayout(nodes, edges);

    expect(positions.get("9")!.x).toBeLessThan(positions.get("10")!.x);
  });

  it("determinístico mesmo com nós e arestas EMBARALHADOS (não só chamado duas vezes na mesma ordem)", () => {
    const nodes: GraphNode[] = [
      { id: "1", w: 50, h: 40 },
      { id: "2", w: 60, h: 30 },
      { id: "3", w: 70, h: 50 },
      { id: "4", w: 40, h: 40 },
      { id: "iso", w: 20, h: 20 },
    ];
    const edges: GraphEdge[] = [
      { fromCardId: "1", toCardId: "2" },
      { fromCardId: "1", toCardId: "3" },
      { fromCardId: "2", toCardId: "4" },
      { fromCardId: "3", toCardId: "4" },
    ];

    const baseline = hierarchicalLayout(nodes, edges);
    const shuffledNodes = [nodes[4], nodes[2], nodes[0], nodes[3], nodes[1]];
    const shuffledEdges = [edges[3], edges[1], edges[0], edges[2]];
    const shuffled = hierarchicalLayout(shuffledNodes, shuffledEdges);

    expect(sortedEntries(shuffled)).toEqual(sortedEntries(baseline));
  });
});

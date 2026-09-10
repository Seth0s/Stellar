// Pure, React-free board geometry — the coordinate system every board item
// (terminal today; files/annotation/browser later) shares. Kept separate so
// new item kinds don't reimplement drag/resize/z-order/culling math.

export type BoardItemKind = "terminal" | "files" | "changes" | "sticky" | "browser" | "stroke";

export type Rect = { x: number; y: number; w: number; h: number };

export type BoardItem = {
  id: string;
  kind: BoardItemKind;
  rect: Rect;
};

export type WorldTransform = { panX: number; panY: number; zoom: number };

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Intersection area of two rects, 0 when they don't overlap. Used by
 * App.tsx's `tryChangeRect` to tell "this drag makes an existing browser
 * overlap worse" apart from "this drag is escaping one" — see its doc
 * comment for why the distinction matters. */
export function overlapArea(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}

/** AABB visibility test — is `rect` at least partially inside `viewport`? */
export function isInView(rect: Rect, viewport: Rect): boolean {
  return rectsOverlap(rect, viewport);
}

/** Screen-space point (relative to the viewport element) -> world-space point. */
export function screenToWorld(screen: { x: number; y: number }, world: WorldTransform): { x: number; y: number } {
  return {
    x: (screen.x - world.panX) / world.zoom,
    y: (screen.y - world.panY) / world.zoom,
  };
}

/** The world-space rect currently visible through a viewport of the given screen size. */
export function viewportWorldRect(viewportSize: { width: number; height: number }, world: WorldTransform): Rect {
  const topLeft = screenToWorld({ x: 0, y: 0 }, world);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: viewportSize.width / world.zoom,
    h: viewportSize.height / world.zoom,
  };
}

/** Topmost item (by z-order) whose rect contains `point`, or null. */
export function hitTest(items: BoardItem[], point: { x: number; y: number }, order: string[]): BoardItem | null {
  const byId = new Map(items.map((it) => [it.id, it]));
  for (let i = order.length - 1; i >= 0; i--) {
    const item = byId.get(order[i]);
    if (!item) continue;
    const { rect } = item;
    if (point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h) {
      return item;
    }
  }
  return null;
}

// Sized so a freshly spawned terminal lands close to 80×24 (the PTY's own
// initial size — DEFAULT_COLS/ROWS in useTerminal.ts) instead of squeezing
// it to ~47×15: most CLI TUIs (Claude Code, Codex, Cursor) assume something
// near a standard terminal width and render broken/wrapped box drawing well
// below that. Confirmed empirically via CDP: 440×380 (the old default)
// measured out to 47 cols × 15 rows.
// DESIGN-BACKLOG.md item 12, achado 3 — bumped up from 720×560 on the
// user's explicit ask. Registered tension: item 10's selection-tool
// finding was that 720×560 was ALREADY too big to fully separate two
// cards on screen at zoom 1 in a 1280×800 window — this makes that worse,
// not better. Kept anyway (explicit, repeated request beats an
// unprompted usability finding); the real fix for the separation problem
// is zooming out, which already works (see smoke-group-select.mjs).
// 2026-09-09 — subiu de novo, de 860x660, agora com EVIDÊNCIA de uso real
// em vez de só o pedido: no store deste usuário (`cards` em
// `agent-canvas.db`), TODO card `claude` tinha sido redimensionado à mão
// para muito além do padrão — 1119x907, 1164x862, 1374x793, 1377x911, e o
// card ativo da sessão em 1332x1070. 860 de largura não cabe a status
// line do CLI, então o usuário refazia o mesmo resize em todo card.
// A largura sai dessa faixa; a altura é a mediana do uso real, escolhida
// DE PROPÓSITO abaixo dos 1070 do card ativo, que nasceria ocupando quase
// toda a vertical num monitor menor.
//
// Tamanho por provider foi proposto e RECUSADO pelo dono do repo ("melhor
// manter padrão herdado, para não ferir o paradigma") — uma constante,
// herdada por todo kind e todo provider. Não reintroduzir o mapa.
//
// A tensão do parágrafo acima piora mais uma vez, e continua aceita pelo
// mesmo motivo (pedido explícito), agora com a medição do uso real como
// argumento mais forte do que nas vezes anteriores. Consequência que o
// dono do repo conhece e aceitou: um card de nota adesiva também nasce
// neste tamanho, porque a constante é única.
//
// Colunas/linhas do PTY neste tamanho: ~118 x ~32. É INTERPOLAÇÃO entre as
// duas medições documentadas acima (440x380 -> 47x15, medido por CDP, e
// 860x660 -> ~80x24), não uma medição nova — ninguém abriu o app para
// conferir.
// Exportadas (2026-09-09) porque `tests/unit/board-model.test.ts` fixava
// 860/660 na mão e quebrou silenciosamente quando este valor mudou — teste
// que repete a constante em vez de importá-la só falha DEPOIS do estrago.
export const SPAWN_W = 1340;
export const SPAWN_H = 900;

/**
 * Cascading default position for the n-th item created, anchored at a fixed
 * world-space origin. Only used for the very first card of a brand new
 * board (see App.tsx's loadBoard) — the world transform has just been reset
 * to identity right before that, so world-space origin and screen origin
 * coincide anyway. Every other spawn path uses `centeredSlot` below.
 */
export function cascadeSlot(index: number): Rect {
  // D1 — x: 84 para livrar a área ocupada pela Rail lateral (12px + 48px + margem) no carregamento inicial
  return {
    x: 84 + (index % 3) * (SPAWN_W + 20),
    y: 40 + Math.floor(index / 3) * (SPAWN_H + 20),
    w: SPAWN_W,
    h: SPAWN_H,
  };
}

// Folga mínima entre dois cards quaisquer no board — usada tanto pelo
// placement de spawn (`nearestFreeSlot`/`centeredSlot`) quanto pelo layout
// de grafo (`hierarchicalLayout`, item 2), pra não duplicar a noção de
// "espaço livre" em dois lugares com critérios diferentes. `rectsOverlap`
// sozinho não bastava pro placement: dois cards encostados (0px de gap)
// contam como "livre" e o board fica visualmente apertado enquanto sobra
// espaço adiante — achado real do dono do repo, 2026-09-09 (screenshot: um
// cluster de cards colado no canto enquanto o meio do board ficava vazio).
export const MIN_GAP = 24;

function inflateRect(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
}

function isFullyInside(rect: Rect, container: Rect): boolean {
  return (
    rect.x >= container.x &&
    rect.y >= container.y &&
    rect.x + rect.w <= container.x + container.w &&
    rect.y + rect.h <= container.y + container.h
  );
}

function totalOverlap(candidate: Rect, rects: Rect[]): number {
  return rects.reduce((sum, r) => sum + overlapArea(candidate, r), 0);
}

/** `rects` respeitam `minGap` de `candidate`? Infla o candidato em vez de
 * cada rect existente — um único inflate por candidato testado, em vez de
 * um por par. */
function respectsGap(candidate: Rect, rects: Rect[], minGap: number): boolean {
  const inflated = inflateRect(candidate, minGap);
  return rects.every((r) => !rectsOverlap(inflated, r));
}

/**
 * Review adversarial, 2026-09-09 (achado 2, ALTA) — um card existente pode
 * ser "bloqueante": hoje só o card de navegador (`WebContentsView` nativo,
 * pinta acima de todo DOM, e `tryChangeRect` em App.tsx RECUSA qualquer
 * arrasto que aumente overlap com ele) — plantar OUTRO card em cima dele
 * deixa os dois permanentemente inarrastáveis um pro outro. `nearestFreeSlot`
 * precisa saber quais rects são desses pra nunca escolher sobrepor um, nem
 * no degrade. Aceita tanto um `Rect` cru (bloqueante=false, forma antiga,
 * mantém `centeredSlot`/os testes de board-model.test.ts compilando) quanto
 * a forma marcada `{ rect, blocking }`. */
export type ExistingRect = Rect | { rect: Rect; blocking?: boolean };

function normalizeExisting(item: ExistingRect): { rect: Rect; blocking: boolean } {
  if ("rect" in item) return { rect: item.rect, blocking: !!item.blocking };
  return { rect: item, blocking: false };
}

function blockingOverlap(candidate: Rect, normalized: { rect: Rect; blocking: boolean }[]): number {
  return normalized.reduce((sum, r) => (r.blocking ? sum + overlapArea(candidate, r.rect) : sum), 0);
}

const RING_STEP = 60;
const MAX_RINGS = 12; // 12 * 60 = 720px — clears an 860×660 spawn even from dead-center overlap
const RING_DIRECTIONS = [
  { dx: 1, dy: 0 },
  { dx: 1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
];

/** Candidatos em anel ao redor do centro de `base` — mesmo formato do
 * ring-walk antigo, mantido só pra limitar a busca (nunca infinita), não
 * mais pra decidir o vencedor pela ordem de iteração (ver
 * `nearestFreeSlot`). Não enxerga rect nenhum: só geometria de `base`. */
function ringCandidates(base: Rect): Rect[] {
  const list: Rect[] = [base];
  for (let ring = 1; ring <= MAX_RINGS; ring++) {
    for (const { dx, dy } of RING_DIRECTIONS) {
      list.push({ ...base, x: base.x + dx * ring * RING_STEP, y: base.y + dy * ring * RING_STEP });
    }
  }
  return list;
}

// Review adversarial, 2026-09-09 (achado 3, MÉDIA) — os anéis só cobrem 8
// raios fixos; uma vaga fora dessas retas (ex.: bem ao lado de um cluster,
// numa diagonal que os anéis não cruzam) era invisível pra busca — a MESMA
// classe de defeito que a gente veio consertar. `edgeCandidates` abaixo
// completa o anel com posições encostadas (mais a folga) nas 4 bordas de
// cada rect existente PERTO do anchor — "o vazio ao lado do cluster" é
// literalmente uma borda de um rect do cluster. Custo sob controle: só os
// rects a até `EDGE_SEARCH_RADIUS` do anchor entram (um rect muito longe
// não ia vencer por distância mesmo se virasse candidato), e no máximo
// `EDGE_CANDIDATE_RECT_LIMIT` deles (os mais próximos primeiro) — pior caso
// 40*4=160 candidatos extras, poucos milissegundos mesmo num board de
// milhares de cards (medido — ver o teste de custo em board-layout.test.ts).
//
// Review, 2a rodada (2026-09-09) — a 1ª versão media essa proximidade pelo
// CENTROIDE do rect (`rectCenter(rect)` vs `anchor`), mas os candidatos
// nascem na BORDA do rect. Duas consequências reais: (a) um rect enorme
// cujo centroide cai dentro do raio gerava candidatos a milhares de pixels
// do anchor — a proteção do `MAX_RINGS` deixava de valer por outro caminho,
// reintroduzindo o sintoma original (card plantado longe demais); (b) um
// rect comprido que TANGENCIA o anchor, cuja borda é a vaga mais útil que
// existe, era descartado porque o centroide dele caía longe. Corrigido nos
// dois pontos abaixo: filtra/ranqueia pela distância PONTO-RETÂNGULO (zero
// quando o anchor está dentro do rect, não o centroide), e poda depois de
// gerar qualquer candidato cujo PRÓPRIO centro fique além do alcance —
// agora o teto realmente significa o que promete nos dois sentidos.
export const EDGE_SEARCH_RADIUS = MAX_RINGS * RING_STEP; // mesmo alcance do ring-search
const EDGE_CANDIDATE_RECT_LIMIT = 40;

/** Distância de `point` até o retângulo mais próximo — 0 quando `point`
 * está dentro dele. Distância ponto-AABB clássica: clampa cada eixo à faixa
 * do rect e mede o que sobra. */
function pointRectDistance(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

function edgeCandidates(rects: Rect[], anchor: Point, size: { w: number; h: number }, gap: number): Rect[] {
  const nearby = rects
    .map((rect) => ({ rect, dist: pointRectDistance(anchor, rect) }))
    .filter(({ dist }) => dist <= EDGE_SEARCH_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, EDGE_CANDIDATE_RECT_LIMIT);

  const list: Rect[] = [];
  for (const { rect } of nearby) {
    list.push(
      { x: rect.x - gap - size.w, y: anchor.y - size.h / 2, w: size.w, h: size.h }, // encostado à esquerda
      { x: rect.x + rect.w + gap, y: anchor.y - size.h / 2, w: size.w, h: size.h }, // encostado à direita
      { x: anchor.x - size.w / 2, y: rect.y - gap - size.h, w: size.w, h: size.h }, // encostado em cima
      { x: anchor.x - size.w / 2, y: rect.y + rect.h + gap, w: size.w, h: size.h }, // encostado embaixo
    );
  }
  // Teto na distância do CANDIDATO (não do rect que o originou) ao anchor —
  // um rect perto (pela distância ponto-retângulo acima) ainda pode ser
  // grande o bastante pra que a borda encostada nasça longe (achado a). O
  // teto ESCALA com o próprio tamanho do candidato (`size`): driblar um
  // vizinho do mesmo tamanho exige encostar a uma distância da ordem da
  // largura/altura DELE, não de um número fixo — um `EDGE_SEARCH_RADIUS`
  // cru quebrava exatamente esse caso assim que o spawn padrão cresceu pra
  // 1340×900 (achado real, `board-model.test.ts`'s "dodges" — precisa de
  // ~1364px pra driblar um vizinho do próprio tamanho, acima dos 720 fixos
  // de antes). Continua limitado (não vira "sem teto" de novo): uma parede
  // de milhares de pixels ainda é descartada, só que agora em relação ao
  // tamanho de quem está procurando vaga, não a uma constante emprestada do
  // tamanho de spawn antigo.
  const maxCandidateReach = EDGE_SEARCH_RADIUS + size.w + size.h;
  return list.filter((c) => {
    const center = rectCenter(c);
    return Math.hypot(center.x - anchor.x, center.y - anchor.y) <= maxCandidateReach;
  });
}

/**
 * Escolhe onde plantar um rect do tamanho de `base`, perto da própria
 * posição de `base`, evitando `existingRects` por pelo menos `minGap` de
 * cada lado. Substitui o "anda numa ordem fixa de 8 direções e aceita a
 * PRIMEIRA posição livre" de antes — essa ordem fixa podia fazer um card
 * novo pular na diagonal, passando por um vazio óbvio mais perto, só porque
 * a lista de direções via a diagonal primeiro (achado real, 2026-09-09:
 * cards agrupados no canto superior esquerdo, um vazio enorme no meio do
 * board, e o card novo plantado na diagonal inferior direita — havia
 * espaço livre bem mais perto). Agora todo candidato (anel + borda, ver
 * `edgeCandidates`) é pontuado e o mais barato vence: mais perto do centro
 * de `base` é melhor, e um candidato que caiba inteiro dentro de
 * `preferInside` (o `visibleRect`, quando informado) é preferido a um que
 * não caiba — não faz sentido plantar fora da vista do humano se havia
 * espaço na vista.
 *
 * Mesma garantia de "nunca trava" de antes: se nada respeita `minGap`
 * dentro do raio de busca, degrada pro candidato avaliado com MENOS
 * sobreposição — mas sobrepor um rect `blocking` (card de navegador, ver
 * `ExistingRect`) é proibitivo mesmo no degrade, nunca só "caro": um card
 * plantado por cima de um navegador fica permanentemente inarrastável
 * (`tryChangeRect` em App.tsx), o que é pior que qualquer overlap comum.
 * Ainda determinístico — a mesma entrada sempre escolhe o mesmo candidato.
 */
export function nearestFreeSlot(base: Rect, existingRects: ExistingRect[] = [], preferInside?: Rect, minGap = MIN_GAP): Rect {
  const normalized = existingRects.map(normalizeExisting);
  const rawRects = normalized.map((r) => r.rect);
  const anchor = rectCenter(base);
  const candidates = [...ringCandidates(base), ...edgeCandidates(rawRects, anchor, base, minGap)];
  const free = candidates.filter((c) => respectsGap(c, rawRects, minGap));
  const pool = free.length > 0 ? free : candidates;
  const INSIDE_BONUS = RING_STEP * 2; // preferência, não veto — ver doc acima
  const BLOCKING_PENALTY = 1_000_000; // domina qualquer combinação plausível de overlap comum + distância — ver doc acima

  let best = pool[0];
  let bestCost = Infinity;
  for (const candidate of pool) {
    const center = rectCenter(candidate);
    const dist = Math.hypot(center.x - anchor.x, center.y - anchor.y);
    const cost =
      free.length > 0
        ? dist - (preferInside && isFullyInside(candidate, preferInside) ? INSIDE_BONUS : 0)
        : blockingOverlap(candidate, normalized) * BLOCKING_PENALTY + totalOverlap(candidate, rawRects) * 1000 + dist;
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  }
  return best;
}

/**
 * Default position for the n-th item created via a rail button, centered on
 * whatever part of the board the user is actually looking at (`visibleRect`
 * — the world-space rect the viewport currently shows) instead of a fixed
 * world-space origin. `cascadeSlot` planted every new card at the same
 * (40,40)-anchored spot regardless of where the user had panned/zoomed to —
 * fine the first few times, but once the user had panned away, a new card
 * (especially a browser card: a native WebContentsView, which paints above
 * every DOM element regardless of z-index) could land stacked exactly on
 * top of an existing card far outside the visible area, or directly over
 * one still in view, visually swallowing it. Small per-index stagger (same
 * idea as cascadeSlot, just centered) so several quick spawns still fan out
 * instead of exact-stacking; cycles every 5 so it never drifts off the
 * visible area after many spawns.
 */
/**
 * `existingRects` (2026-09-02, real bug report — a browser card spawned
 * right on top of a terminal left BOTH permanently undraggable, see
 * App.tsx's `tryChangeRect`: it refuses any drag that would increase
 * overlap with a browser card, but never GRANTED that overlap in the first
 * place — nothing here checked for one). The 36px/5-cycle stagger above was
 * only ever meant to fan out a quick burst of spawns, not avoid collision;
 * past the 5th card at an unmoved viewport it wraps back to (0,0) and
 * guarantees an exact restack. When the plain staggered slot collides with
 * something already on the board, this now delegates to `nearestFreeSlot`
 * (below) to pick where to land — see its own doc comment for what changed
 * and why (2026-09-09 fix: the old fixed-compass-order ring walk could jump
 * a new card to the far diagonal past an obviously closer gap).
 */
export function centeredSlot(visibleRect: Rect, index: number, existingRects: ExistingRect[] = []): Rect {
  const cx = visibleRect.x + visibleRect.w / 2;
  const cy = visibleRect.y + visibleRect.h / 2;
  const stagger = (index % 5) * 36;
  const base: Rect = {
    x: cx - SPAWN_W / 2 + stagger,
    y: cy - SPAWN_H / 2 + stagger,
    w: SPAWN_W,
    h: SPAWN_H,
  };
  return nearestFreeSlot(base, existingRects, visibleRect);
}

/** Default position for a card spawned at a specific world point — the
 * radial menu (item 1) opens at the cursor and should plant the new card
 * right there, not back at the viewport center like `centeredSlot`. No
 * stagger: this only ever spawns one card per invocation. */
export function pointSlot(point: Point): Rect {
  return { x: point.x - SPAWN_W / 2, y: point.y - SPAWN_H / 2, w: SPAWN_W, h: SPAWN_H };
}

export type AnchorSide = "left" | "right" | "top" | "bottom";

/** Pendentes #188 ("spawn_card por coordenadas") — a card spawned right
 * next to another one an agent already cares about (an editor already
 * focused on the file in question, e.g.), instead of wherever
 * `centeredSlot`'s ring-search happens to land. Same size as every other
 * spawn (`SPAWN_W`/`SPAWN_H`), centered on the anchor's cross-axis, offset
 * by `gap` along the requested side. Still no collision avoidance of its
 * own — this only computes the IDEAL anchored position, same spirit as
 * `pointSlot` above. 2026-09-09 fix: the caller (`spawnCardFor` in
 * App.tsx) used to take this rect as-is even when it landed on top of an
 * occupied card, which defeated the point of anchoring (a conector longo
 * até um card escondido atrás de outro); it now feeds this rect into
 * `nearestFreeSlot` as the search's `base`, so the parent-anchored ideal
 * wins whenever it's free and degrades to the nearest free neighbor of
 * THAT position otherwise — never back to `centeredSlot`'s viewport-center
 * anchor. */
export function anchoredSlot(anchor: Rect, side: AnchorSide, gap = 24): Rect {
  const cx = anchor.x + anchor.w / 2;
  const cy = anchor.y + anchor.h / 2;
  switch (side) {
    case "left":
      return { x: anchor.x - gap - SPAWN_W, y: cy - SPAWN_H / 2, w: SPAWN_W, h: SPAWN_H };
    case "right":
      return { x: anchor.x + anchor.w + gap, y: cy - SPAWN_H / 2, w: SPAWN_W, h: SPAWN_H };
    case "top":
      return { x: cx - SPAWN_W / 2, y: anchor.y - gap - SPAWN_H, w: SPAWN_W, h: SPAWN_H };
    case "bottom":
      return { x: cx - SPAWN_W / 2, y: anchor.y + anchor.h + gap, w: SPAWN_W, h: SPAWN_H };
  }
}

/** World-space rect -> window-content pixel rect. Used by the snapshot
 * IPC handler (see App.tsx / main/index.ts's handleSnapshotRequest), which
 * only knows a card's live world-space rect and needs it in real screen
 * pixels to crop `capturePage()`'s output. */
export function worldRectToScreen(rect: Rect, world: WorldTransform, viewportOrigin: { x: number; y: number }): Rect {
  return {
    x: viewportOrigin.x + world.panX + rect.x * world.zoom,
    y: viewportOrigin.y + world.panY + rect.y * world.zoom,
    w: rect.w * world.zoom,
    h: rect.h * world.zoom,
  };
}

export type Point = { x: number; y: number };

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Bounding box of a set of rects, or null for an empty board — used by fitView. */
export function bboxOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Control point for a quadratic bezier bowed away from the straight line between `from` and `to`, by `bow` × its length. */
export function quadraticControlPoint(from: Point, to: Point, bow = 0.18): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  if (len === 0) return { x: mx, y: my };
  const nx = -dy / len;
  const ny = dx / len;
  return { x: mx + nx * len * bow, y: my + ny * len * bow };
}

/**
 * Where the segment from `from` to `to` first exits `rect`, assuming `from`
 * is inside it (true for every call site here — `from` is always that
 * rect's own center). Used to clip a connector's end to the edge of its
 * card instead of drawing through its middle. Falls back to `to` itself if
 * the segment is degenerate or never crosses a finite edge span.
 */
export function clipLineToRect(from: Point, to: Point, rect: Rect): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  const candidates: number[] = [];
  if (dx !== 0) {
    const tLeft = (x1 - from.x) / dx;
    const yAtLeft = from.y + tLeft * dy;
    if (tLeft > 0 && tLeft <= 1 && yAtLeft >= y1 && yAtLeft <= y2) candidates.push(tLeft);
    const tRight = (x2 - from.x) / dx;
    const yAtRight = from.y + tRight * dy;
    if (tRight > 0 && tRight <= 1 && yAtRight >= y1 && yAtRight <= y2) candidates.push(tRight);
  }
  if (dy !== 0) {
    const tTop = (y1 - from.y) / dy;
    const xAtTop = from.x + tTop * dx;
    if (tTop > 0 && tTop <= 1 && xAtTop >= x1 && xAtTop <= x2) candidates.push(tTop);
    const tBottom = (y2 - from.y) / dy;
    const xAtBottom = from.x + tBottom * dx;
    if (tBottom > 0 && tBottom <= 1 && xAtBottom >= x1 && xAtBottom <= x2) candidates.push(tBottom);
  }
  const t = candidates.length > 0 ? Math.min(...candidates) : 1;
  return { x: from.x + t * dx, y: from.y + t * dy };
}

// ---- Item 2 — layout hierárquico dirigido a partir do grafo de conectores ----
// Tipos locais em vez de importar `Connector`/`Card` de card-types.ts: esse
// módulo importa `Rect` DAQUI (board-model.ts), então o caminho inverso
// criaria um ciclo. `GraphEdge` é estruturalmente compatível com
// `Connector` (mesmos `fromCardId`/`toCardId`), então App.tsx passa
// `connectors` direto, sem mapear.
export type GraphNode = { id: string; w: number; h: number };
export type GraphEdge = { fromCardId: string; toCardId: string };

const INTEGER_ID = /^-?\d+$/;

/**
 * Review adversarial, 2026-09-09 (achado 1, ALTA) — card ids são
 * `String(contador++)` (`App.tsx`'s `nextId`), e o board deste usuário já
 * passa de 200 cards. `.sort()` nativo compara como texto: "10" < "2" —
 * embaralha a grade dos isolados fora da ordem cronológica e faz a raiz
 * determinística de um ciclo puro ("menor id") escolher o id ERRADO.
 * Compara numericamente quando os dois lados são um inteiro puro; cai pra
 * comparação de string (estável) quando não são — nada aqui pode assumir
 * que todo id do app é numérico pra sempre (outro caminho do app pode
 * gerar um id que não é). */
function compareIds(a: string, b: string): number {
  if (INTEGER_ID.test(a) && INTEGER_ID.test(b)) {
    const na = Number(a);
    const nb = Number(b);
    if (na !== nb) return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Posição de cada card num layout hierárquico dirigido: pai em cima, filho
 * embaixo, uma camada por profundidade a partir das raízes de cada
 * componente conexo. Decisão do dono do repo (item 2, 2026-09-09) —
 * `aiReorganize` em App.tsx era literalmente uma grade de 3 colunas na
 * ordem de criação, ignorando os conectores por completo. Nada radial, nada
 * force-directed/simulação física (não seria reprodutível, e um botão de
 * "organizar" tem que dar o mesmo resultado pra o mesmo board): os
 * conectores do Stellar já são direcionados (`fromCardId -> toCardId`,
 * "quem originou/influenciou quem"), então a leitura de linhagem é o que
 * importa aqui.
 *
 * Cards sem NENHUM conector (nem como origem, nem como destino) não entram
 * no grafo — vão pra uma grade própria à parte, depois do grafo inteiro,
 * pra não empurrar as camadas (um board sem conector nenhum continua caindo
 * só nessa grade — comportamento preservado).
 *
 * Determinístico por construção: todo desempate usa o id do card, nunca
 * ordem de iteração de Map/Set e nunca Math.random/Date.now. Reutiliza
 * `MIN_GAP` — nenhum par de rects resultante fica mais perto que isso.
 */
export function hierarchicalLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  origin: Point = { x: 0, y: 0 },
  minGap = MIN_GAP,
): Map<string, Rect> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const validEdges = edges.filter(
    (e) => byId.has(e.fromCardId) && byId.has(e.toCardId) && e.fromCardId !== e.toCardId,
  );

  const connected = new Set<string>();
  for (const e of validEdges) {
    connected.add(e.fromCardId);
    connected.add(e.toCardId);
  }

  const childrenOf = new Map<string, string[]>();
  const undirected = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const id of connected) {
    childrenOf.set(id, []);
    undirected.set(id, new Set());
    inDegree.set(id, 0);
  }
  for (const e of validEdges) {
    childrenOf.get(e.fromCardId)!.push(e.toCardId);
    undirected.get(e.fromCardId)!.add(e.toCardId);
    undirected.get(e.toCardId)!.add(e.fromCardId);
    inDegree.set(e.toCardId, (inDegree.get(e.toCardId) ?? 0) + 1);
  }
  for (const kids of childrenOf.values()) kids.sort(compareIds);

  // Componentes conexos (não-direcionado) — busca em pilha; `componentOfId`
  // guarda contra visitar o mesmo nó duas vezes (também cobre ciclo).
  const componentOfId = new Map<string, number>();
  const components: string[][] = [];
  for (const id of [...connected].sort(compareIds)) {
    if (componentOfId.has(id)) continue;
    const index = components.length;
    const members: string[] = [];
    const stack = [id];
    componentOfId.set(id, index);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      members.push(cur);
      for (const next of undirected.get(cur)!) {
        if (!componentOfId.has(next)) {
          componentOfId.set(next, index);
          stack.push(next);
        }
      }
    }
    components.push(members.sort(compareIds));
  }

  const positions = new Map<string, Rect>();
  let cursorX = origin.x;
  let tallestComponent = 0;

  for (const members of components) {
    // Profundidade a partir das raízes (indegree 0 dentro do componente).
    // Ciclo puro = nenhuma raiz natural — cai pro menor id (determinístico,
    // combinado com o dono do repo). BFS multi-fonte a partir de todas as
    // raízes; se sobrar nó não alcançado (só chega ao componente por uma
    // aresta que "aponta de volta" pra árvore, nunca pra fora dela), repete
    // com o menor id restante até cobrir o componente inteiro. Nunca
    // duplica (guardado por `depth.has`) nem trava (cada rodada extra
    // cobre pelo menos 1 nó novo, e o componente é finito).
    const depth = new Map<string, number>();
    let queue = members.filter((id) => (inDegree.get(id) ?? 0) === 0);
    if (queue.length === 0) queue = [members[0]]; // `members` já ordenado — menor id
    for (const root of queue) depth.set(root, 0);
    let qi = 0;
    for (;;) {
      while (qi < queue.length) {
        const cur = queue[qi++];
        for (const kid of childrenOf.get(cur)!) {
          if (!depth.has(kid)) {
            depth.set(kid, depth.get(cur)! + 1);
            queue.push(kid);
          }
        }
      }
      const unreached = members.filter((id) => !depth.has(id));
      if (unreached.length === 0) break;
      depth.set(unreached[0], 0);
      queue.push(unreached[0]);
    }

    const maxDepth = Math.max(...members.map((id) => depth.get(id)!));
    const layers: string[][] = [];
    for (let d = 0; d <= maxDepth; d++) {
      layers.push(members.filter((id) => depth.get(id) === d));
    }

    let cursorY = origin.y;
    let componentWidth = 0;
    for (let d = 0; d < layers.length; d++) {
      const layer = layers[d];
      if (d > 0) {
        // Barycenter, uma passada só: ordena pela posição média (x) dos
        // pais já posicionados (camadas anteriores só, já resolvidas neste
        // laço). Sem nenhum pai posicionado ainda (raiz de fallback no meio
        // do grafo) vai pro fim, com o id como desempate — mesmo desempate
        // usado quando os barycenters empatam.
        //
        // Review adversarial, 2026-09-09 (achado 4, MÉDIA) — a média soma
        // floats na ordem do array de arestas, e soma de float não é
        // associativa: a MESMA aresta em ordens diferentes produz valores
        // minimamente diferentes (ruído na casa de 1e-10 a 1e-13), então
        // `ba === bb` quase nunca batia e o desempate por id nunca rodava
        // de verdade. Arredonda pro pixel inteiro antes de comparar — "uma
        // casa útil" pra posição de card, bem acima do ruído de soma — e só
        // então cai pro desempate por id (já numérico, ver `compareIds`).
        const barycenter = (id: string): number => {
          const parents = validEdges
            .filter((e) => e.toCardId === id && positions.has(e.fromCardId))
            .map((e) => rectCenter(positions.get(e.fromCardId)!).x);
          return parents.length > 0 ? parents.reduce((s, x) => s + x, 0) / parents.length : Number.POSITIVE_INFINITY;
        };
        layer.sort((a, b) => {
          const ba = Math.round(barycenter(a));
          const bb = Math.round(barycenter(b));
          if (ba !== bb) return ba - bb;
          return compareIds(a, b);
        });
      }
      let x = cursorX;
      let rowHeight = 0;
      for (const id of layer) {
        const node = byId.get(id)!;
        positions.set(id, { x, y: cursorY, w: node.w, h: node.h });
        x += node.w + minGap;
        rowHeight = Math.max(rowHeight, node.h);
      }
      componentWidth = Math.max(componentWidth, x - minGap - cursorX);
      cursorY += rowHeight + minGap;
    }
    tallestComponent = Math.max(tallestComponent, cursorY - origin.y - minGap);
    cursorX += componentWidth + minGap;
  }

  // Cards sem conector nenhum: grade própria (3 colunas, mesmo espírito do
  // `cascadeSlot`), sempre ABAIXO do grafo inteiro — nunca empurra as
  // camadas, e some sozinha quando não sobra card isolado nenhum.
  const isolated = nodes.map((n) => n.id).filter((id) => !connected.has(id)).sort(compareIds);
  if (isolated.length > 0) {
    const ISOLATED_COLUMNS = 3;
    let isoY = origin.y + (components.length > 0 ? tallestComponent + minGap : 0);
    let col = 0;
    let x = origin.x;
    let rowHeight = 0;
    for (const id of isolated) {
      const node = byId.get(id)!;
      if (col === ISOLATED_COLUMNS) {
        col = 0;
        x = origin.x;
        isoY += rowHeight + minGap;
        rowHeight = 0;
      }
      positions.set(id, { x, y: isoY, w: node.w, h: node.h });
      x += node.w + minGap;
      rowHeight = Math.max(rowHeight, node.h);
      col++;
    }
  }

  return positions;
}

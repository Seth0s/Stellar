/**
 * Decide QUAIS conectores ganham um pulso em movimento — e amostra os
 * pontos do caminho que esse pulso percorre.
 *
 * Contexto (2026-09-15, docs/PERF.md): o commit 9764011 tirou a animação
 * de conector do caminho de repintura enquanto o board está PARADO
 * (`connector-motion-decision.ts`). Só que, quando o board volta a
 * trabalhar, a classe `connectors-animated` religava
 * `animation: dash 1.1s linear infinite` — e `stroke-dashoffset` é PAINT,
 * não compositor: TODO conector do board voltava a re-rasteirizar o `<svg>`
 * a cada frame, exatamente no instante em que o app mais precisa responder.
 * O defeito irmão foi medido ao vivo na landing (repo StellarPage, commit
 * 0ec4fe0): CPU a 50% e GPU parada. Worker não resolveria — o custo é
 * rasterização (Skia), não JavaScript; não há computação para terceirizar.
 *
 * Duas rotas foram consideradas para tirar o movimento do caminho de paint:
 *
 *  (a) `offset-path: path(d)` + animar `offset-distance` 0% → 100%. Acompanha
 *      o `d` sozinha (cards sendo arrastados), mas foi REJEITADA com
 *      evidência: no Chromium 148 (o mesmo do Electron 42.3.0 empacotado
 *      aqui), a lista `kCompositableProperties` de
 *      `third_party/blink/renderer/core/animation/compositor_animations.cc`
 *      NÃO inclui `offset-distance`/`offset-path` — só BackdropFilter,
 *      Filter, Opacity, Rotate, Scale, Transform, Translate,
 *      BackgroundColor e ClipPath. Animar essas duas continua na thread
 *      principal, rasterizando: a mesma classe de problema com outro nome.
 *
 *  (b) mover o pulso com `transform: translate3d()`, que ESTÁ nessa lista e
 *      o compositor resolve sem repintar. Adotada. Em vez de ler o DOM com
 *      `getPointAtLength`, os pontos são calculados analiticamente: o `d`
 *      do conector é sempre uma Bézier quadrática (App.tsx `M…Q…`), o que
 *      mantém a amostragem pura, sem I/O e testável. Os frames saem
 *      reparametrizados por comprimento de arco para o pulso correr em
 *      velocidade constante, sem "acelerar" no meio da curva.
 *
 * O tracejado ESTÁTICO (layout.css: `6 6` + cor por kind) fica intocado — ele
 * já diz "aresta" sem mover um pixel. O pulso é só o cue de TRABALHO VIVO:
 * pulsam apenas conectores `kind === "spawned"` cuja ponta de destino é um
 * card de agente (terminal, provider ≠ bash) VIVO. Sem esse filtro, um board
 * cheio de conectores manuais/depends animaria todos por nada.
 */
export type ConnectorPulseInput = {
  /** `Connector.kind` — null quando nenhum. */
  connectorKind: string | null;
  /** `Card["kind"]` do card de DESTINO do conector. */
  toCardKind: string;
  /** provider do card de destino quando terminal; null em qualquer outro kind. */
  toCardProvider: string | null;
  /** O card de destino está vivo (não `error` nem `exited`). */
  toCardLive: boolean;
};

/**
 * Puro — sem DOM, sem I/O, sem estado. O gate de board
 * (`decideConnectorMotion`) decide se ALGO anima; este decide se ESTE
 * conector merece o pulso. App.tsx combina os dois.
 */
export function decideConnectorPulse(input: ConnectorPulseInput): boolean {
  if (input.connectorKind !== "spawned") return false;
  if (input.toCardKind !== "terminal") return false;
  if (input.toCardProvider === "bash") return false;
  return input.toCardLive;
}

export type PulsePoint = { x: number; y: number };

/** Um ponto do caminho e em que fração (0..1) do percurso ele cai. */
export type PulseFrame = { offset: number; x: number; y: number };

/** Resolução da tabela de comprimento de arco usada para reparametrizar. */
const ARC_SAMPLES = 64;

/** B(t) de uma Bézier quadrática com P0=start, P1=control, P2=end. */
function quadraticPoint(
  start: PulsePoint,
  control: PulsePoint,
  end: PulsePoint,
  t: number,
): PulsePoint {
  const mt = 1 - t;
  const a = mt * mt;
  const b = 2 * mt * t;
  const c = t * t;
  return {
    x: a * start.x + b * control.x + c * end.x,
    y: a * start.y + b * control.y + c * end.y,
  };
}

/**
 * Amostra `frameCount` pontos do caminho da Bézier quadrática, igualmente
 * espaçados POR COMPRIMENTO DE ARCO (não por `t` — senão o pulso correria
 * mais devagar nas pontas). `offset` vai de 0 a 1 e é o que o keyframe usa
 * como posição na linha do tempo; `x`/`y` são coordenadas ABSOLUTAS no
 * espaço do board (o elemento pulso nasce em 0,0 e é só transladado).
 *
 * Devolve `[]` para caminho degenerado (comprimento zero) — o chamador
 * simplesmente não anima aquele conector.
 */
export function connectorPulseFrames(
  start: PulsePoint,
  control: PulsePoint,
  end: PulsePoint,
  frameCount = 40,
): PulseFrame[] {
  const count = Math.max(2, Math.floor(frameCount));

  const cumulative = new Array<number>(ARC_SAMPLES + 1);
  cumulative[0] = 0;
  let previous = quadraticPoint(start, control, end, 0);
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    const point = quadraticPoint(start, control, end, i / ARC_SAMPLES);
    cumulative[i] = cumulative[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }

  const total = cumulative[ARC_SAMPLES];
  if (total === 0) return [];

  const frames: PulseFrame[] = [];
  // `target` cresce a cada frame, então o segmento só avança para frente.
  let segment = 1;
  for (let k = 0; k < count; k++) {
    const offset = k / (count - 1);
    const target = total * offset;
    while (segment < ARC_SAMPLES && cumulative[segment] < target) segment++;
    const segmentLength = cumulative[segment] - cumulative[segment - 1];
    const within = segmentLength > 0 ? (target - cumulative[segment - 1]) / segmentLength : 0;
    const t = Math.min(1, (segment - 1 + within) / ARC_SAMPLES);
    const point = quadraticPoint(start, control, end, t);
    frames.push({ offset, x: point.x, y: point.y });
  }
  return frames;
}

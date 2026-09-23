import { useEffect, useRef } from "react";

/**
 * DESIGN-BACKLOG.md item 14 addendum — the star layer used to live inside
 * `.home-bg`'s own `opacity: 0.22` (the "vidro fumê" dimming meant for the
 * color blobs), so it was never going to read as actual stars, let alone
 * constellations — reported live twice. Split out as its own SVG layer
 * with independent opacity: a loose star field for texture, plus a
 * handful of named clusters where a few brighter, glowing points are
 * *linked with thin lines* — that connective line is what makes something
 * read as "a constellation" instead of just more dots.
 *
 * `viewBox` + `preserveAspectRatio="xMidYMid slice"` scales like a CSS
 * `background-size: cover` so the layout holds at any window size.
 *
 * DESIGN-BACKLOG.md item 16 — the field/cluster shapes below became the
 * REST state of a reactive layer, not the whole picture anymore: the
 * mouse pushes nearby stars (force proportional to how fast it's moving,
 * not just proximity) and a slow autonomous camera drift reveals more of
 * a virtual field 2.8x the viewport's area over time. All of that lives
 * in the effect below, driven by direct DOM attribute writes on refs in
 * a single `requestAnimationFrame` loop — NOT React state — because
 * re-rendering ~200 SVG elements through React at 60fps for a decorative
 * background is real, needless cost; this component renders its JSX
 * exactly once and the loop mutates `cx`/`cy`/`points` attributes
 * directly afterward.
 *
 * `prefers-reduced-motion: reduce` skips the effect's `start()` entirely
 * (listened live via `matchMedia("...").addEventListener("change", ...)`,
 * not just read once at mount) — camera/offsets then stay frozen at their
 * initial {0,0} rest values, which is EXACTLY the pre-item-16 static
 * layout: the original 20 field points + 4 clusters keep their original
 * 0-100 coordinates (now `CLUSTER_OFFSETS[0] = [0,0]`), and every bonus
 * point item 16 adds is generated to deliberately avoid landing inside
 * that same 0-100 square (`isInOriginalTile`, rejection-sampled) — so a
 * reduced-motion user sees pixel-identical output to what item 14
 * shipped, not a differently-distributed procedural subset of it.
 */

// ---- deterministic seeded PRNG (mulberry32) — the field needs to look
// "procedural" (item 16's own sketch: "gerado proceduralmente, não só os
// ~44 pontos fixos de hoje"), but a genuinely random field would relayout
// on every app launch, which reads as flicker/instability for a sky that's
// supposed to feel fixed. A fixed seed makes it procedural exactly once,
// then stable forever after, same spirit as CLUSTERS being hand-placed.
function mulberry32(seed: number) {
  return function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The virtual field the camera drifts across — bigger than the 100x100
// viewBox so there's real ground to reveal (item 16: "precisa de um campo
// de estrelas bem maior que o viewport"). 2.8x per axis: enough headroom
// that a full drift cycle takes a couple of minutes, not enough to make
// the bonus content feel sparse.
const VIRTUAL_W = 280;
const VIRTUAL_H = 280;
const BONUS_FIELD_COUNT = 130;

function isInOriginalTile(x: number, y: number) {
  return x < 100 && y < 100;
}

const FIELD_STARS = (() => {
  // The original 20, unchanged coordinates — item 16's own note: "pontos
  // fixos de hoje viram só o estado de repouso", not replaced.
  const original: { x: number; y: number; r: number; opacity: number }[] = [
    [4, 8], [18, 95], [28, 40], [38, 92], [42, 55], [55, 18], [62, 92],
    [72, 70], [82, 88], [90, 45], [95, 12], [8, 78], [65, 62], [30, 78],
    [50, 6], [86, 60], [12, 35], [75, 15], [46, 34], [20, 15],
  ].map(([x, y], i) => ({ x, y, r: i % 3 === 0 ? 0.35 : 0.22, opacity: i % 3 === 0 ? 0.55 : 0.35 }));

  const rand = mulberry32(20260827);
  const bonus: typeof original = [];
  while (bonus.length < BONUS_FIELD_COUNT) {
    const x = rand() * VIRTUAL_W;
    const y = rand() * VIRTUAL_H;
    if (isInOriginalTile(x, y)) continue; // keeps the reduced-motion view untouched, see header comment
    bonus.push({ x, y, r: rand() < 0.25 ? 0.35 : 0.22, opacity: rand() < 0.25 ? 0.55 : 0.35 });
  }
  return [...original, ...bonus];
})();

// Each cluster shape is a small constellation: points connected in
// sequence by thin lines, with 1-2 points promoted to a bright, glowing
// "hero" star. Shapes are hand-placed (art-directed), same as before item
// 16 — only the SCATTERING across more of the virtual field is new.
const CLUSTER_SHAPES: { points: [number, number][]; hero: number[] }[] = [
  { points: [[14, 20], [22, 14], [31, 22], [26, 32], [17, 30]], hero: [0, 2] },
  { points: [[68, 30], [78, 24], [84, 34], [76, 42]], hero: [1] },
  { points: [[56, 68], [64, 60], [72, 66], [70, 78], [60, 80]], hero: [0, 3] },
  { points: [[10, 62], [18, 58], [24, 66]], hero: [1] },
];

// [0,0] first — that placement must land exactly on the original 0-100
// tile so reduced-motion output stays identical. The other two are what
// drift reveals; chosen so none of the three placements' bounding boxes
// overlap each other within the 280x280 field.
const CLUSTER_OFFSETS: [number, number][] = [[0, 0], [140, 30], [40, 150]];

let heroIndex = 0;
const CLUSTER_INSTANCES = CLUSTER_OFFSETS.flatMap(([ox, oy]) =>
  CLUSTER_SHAPES.map((shape) => {
    const points = shape.points.map(([x, y]) => [x + ox, y + oy] as [number, number]);
    const centroid = points.reduce((acc, [x, y]) => [acc[0] + x / points.length, acc[1] + y / points.length], [0, 0]);
    return { points, hero: shape.hero, centroid: centroid as [number, number] };
  }),
);

function wrap(v: number, size: number) {
  return ((v % size) + size) % size;
}

// Rigid-body wrap: every point of a cluster shifts by the SAME multiple
// of VIRTUAL_W/H (derived from the cluster's centroid crossing the wrap
// boundary), instead of each point wrapping independently. Independent
// per-point wrapping was tried and visibly broke the shape for several
// seconds every cycle — the 4-16 units of spread between a cluster's own
// points meant they crossed the modulo boundary at slightly different
// camera positions, so the connecting polyline briefly stretched across
// almost the whole canvas while some points had wrapped and others hadn't.
function clusterWrapShift(centroid: number, cam: number, size: number) {
  const raw = centroid - cam;
  return wrap(raw, size) - raw;
}

const DRIFT_VX = VIRTUAL_W / 150_000; // units/ms — full width cycle ~2.5min
const DRIFT_VY = VIRTUAL_H / 210_000; // different period so the path isn't a repeating diagonal
const PUSH_RADIUS = 12; // viewBox units (canvas is 0-100)
const PUSH_STRENGTH = 0.6;
const MAX_OFFSET = 5;
const SPRING_K = 0.06; // fraction of the offset that decays back to rest each frame

// Perf (achado ao vivo, 2026-09-03 — reportado como "spike de CPU ao entrar
// na home"): a ~204 elementos SVG recebendo geometry attrs (`cx`/`cy`) via
// DOM direto a 60fps, cada write força o navegador a recalcular layout/paint
// do documento SVG inteiro — caro, e desnecessário pra um fundo decorativo
// com deriva lenta (ciclo de alguns minutos) e empurrão de mouse sutil.
// Duas mudanças, sem qualquer diferença visual perceptível:
// (1) a lógica (deriva + física de empurrão + escrita no DOM) roda numa
// cadência própria de ~30fps via acumulador de tempo real, independente da
// taxa de atualização da tela (60/120/144Hz) — movimento tão lento não se
// distingue entre 30 e 60fps.
// (2) estrelas passam a se mover via `style.transform` (delta relativo à
// posição-base já declarada no JSX) em vez de sobrescrever `cx`/`cy` — CSS
// transform não invalida geometria/layout do SVG, só recompõe, então é
// ordens de magnitude mais barato por escrita mesmo na mesma frequência.
// As polylines dos clusters (só 12, poucos pontos cada) continuam via
// atributo `points` — não são o custo real e não dá pra representar como
// transform único (cada vértice tem seu próprio deslocamento de empurrão).
const LOGIC_FPS = 30;
const LOGIC_INTERVAL_MS = 1000 / LOGIC_FPS;

type Offset = { x: number; y: number };

export function ConstellationBg() {
  const svgRef = useRef<SVGSVGElement>(null);
  const sizeRef = useRef({ w: 1, h: 1, left: 0, top: 0 });
  const mouseRef = useRef({ x: 50, y: 50, vx: 0, vy: 0 });
  const cameraRef = useRef({ x: 0, y: 0 });
  const fieldElsRef = useRef<(SVGCircleElement | null)[]>([]);
  const fieldOffsetsRef = useRef<Offset[]>(FIELD_STARS.map(() => ({ x: 0, y: 0 })));
  const clusterPointElsRef = useRef<(SVGCircleElement | null)[][]>(CLUSTER_INSTANCES.map(() => []));
  const clusterPointOffsetsRef = useRef<Offset[][]>(CLUSTER_INSTANCES.map((c) => c.points.map(() => ({ x: 0, y: 0 }))));
  const clusterLineElsRef = useRef<(SVGPolylineElement | null)[]>([]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const measure = () => {
      const r = svg.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height, left: r.left, top: r.top };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);

    function onPointerMove(e: PointerEvent) {
      const { w, h, left, top } = sizeRef.current;
      if (w < 1 || h < 1) return;
      // Same math as the SVG's own `preserveAspectRatio="xMidYMid slice"`
      // (background-size: cover-equivalent): scale up until the 100x100
      // viewBox fully covers the container, centered.
      const scale = Math.max(w / 100, h / 100);
      const offX = (w - 100 * scale) / 2;
      const offY = (h - 100 * scale) / 2;
      const px = (e.clientX - left - offX) / scale;
      const py = (e.clientY - top - offY) / scale;
      const m = mouseRef.current;
      // Not normalized by dt against a stored lastT — pointermove doesn't
      // fire on a fixed clock, but the rAF loop below decays vx/vy by a
      // fixed factor every frame regardless, which already gives "mouse
      // parado = sem força" without needing a second time source here.
      m.vx = (px - m.x) * 4;
      m.vy = (py - m.y) * 4;
      m.x = px;
      m.y = py;
    }

    function applyPush(offset: Offset, dispX: number, dispY: number, speed: number) {
      const dx = dispX - mouseRef.current.x;
      const dy = dispY - mouseRef.current.y;
      const dist = Math.hypot(dx, dy);
      if (dist < PUSH_RADIUS && dist > 0.001 && speed > 0.05) {
        const falloff = 1 - dist / PUSH_RADIUS;
        const impulse = falloff * speed * PUSH_STRENGTH;
        offset.x += (dx / dist) * impulse;
        offset.y += (dy / dist) * impulse;
      }
      offset.x -= offset.x * SPRING_K;
      offset.y -= offset.y * SPRING_K;
      const mag = Math.hypot(offset.x, offset.y);
      if (mag > MAX_OFFSET) {
        const k = MAX_OFFSET / mag;
        offset.x *= k;
        offset.y *= k;
      }
    }

/**
 * Arredonda para o MEIO PIXEL. Usado para decidir se vale ESCREVER no DOM: um
 * `transform` que difere menos que isso rasteriza identicamente, então escrever
 * de novo só custa recálculo de estilo (medido: 603 recálculos e 225 layouts a
 * cada 10 s com ZERO cards, só por causa destas escritas — task 27e13021).
 */
function quantizeHalfPx(valor: number): number {
  return Math.round(valor * 2) / 2;
}

    let raf = 0;
    let lastFrame = performance.now();
    function frame(now: number) {
      raf = requestAnimationFrame(frame);

      // JANELA OCULTA NÃO ANIMA (task 27e13021): com a janela minimizada ou em
      // segundo plano o campo não é visto por ninguém, e continuar calculando
      // física + escrevendo DOM era CPU paga para pintar o que ninguém olha.
      // O relógio é reancorado na volta para o campo não "pular" o tempo parado.
      if (document.hidden) {
        lastFrame = now;
        return;
      }

      // Throttle da LÓGICA (não do agendamento) a ~30fps — ver comentário
      // de LOGIC_INTERVAL_MS acima. `requestAnimationFrame` continua sendo
      // chamado na taxa real da tela (precisa disso pra ter timestamps),
      // só o trabalho de física+DOM abaixo é que roda mais devagar.
      const elapsed = now - lastFrame;
      if (elapsed < LOGIC_INTERVAL_MS) return;
      const dt = Math.min(elapsed, 100); // clamp — a tab-switch/minimize gap shouldn't jump the drift
      lastFrame = now;

      const cam = cameraRef.current;
      cam.x = wrap(cam.x + DRIFT_VX * dt, VIRTUAL_W);
      cam.y = wrap(cam.y + DRIFT_VY * dt, VIRTUAL_H);

      const m = mouseRef.current;
      m.vx *= 0.85;
      m.vy *= 0.85;
      const speed = Math.hypot(m.vx, m.vy);

      FIELD_STARS.forEach((star, i) => {
        const el = fieldElsRef.current[i];
        if (!el) return;
        const dispX = wrap(star.x - cam.x, VIRTUAL_W);
        const dispY = wrap(star.y - cam.y, VIRTUAL_H);
        const off = fieldOffsetsRef.current[i];
        applyPush(off, dispX, dispY, speed);
        // Delta relativo ao cx/cy-base já declarado no JSX (star.x/star.y)
        // — ver comentário de LOGIC_INTERVAL_MS acima.
        //
        // SÓ ESCREVE QUANDO MUDA (task 27e13021): o perfil do renderer mediu
        // 603 recálculos de estilo e 225 layouts a cada 10 s com ZERO cards, e
        // a causa é esta linha — uma escrita de `transform` por estrela por
        // tick. O valor é quantizado ao MEIO PIXEL antes de comparar: um
        // deslocamento menor que isso rasteriza idêntico, então pular a escrita
        // não muda o que se vê — e some com a maior parte dos recálculos quando
        // o campo apenas deriva devagar.
        const tx = quantizeHalfPx(dispX + off.x - star.x);
        const ty = quantizeHalfPx(dispY + off.y - star.y);
        const valor = `translate(${tx}px, ${ty}px)`;
        if (el.style.transform !== valor) el.style.transform = valor;
      });

      CLUSTER_INSTANCES.forEach((cluster, ci) => {
        const shiftX = clusterWrapShift(cluster.centroid[0], cam.x, VIRTUAL_W);
        const shiftY = clusterWrapShift(cluster.centroid[1], cam.y, VIRTUAL_H);
        const pts: [number, number][] = [];
        cluster.points.forEach(([bx, by], pi) => {
          const dispX = bx - cam.x + shiftX;
          const dispY = by - cam.y + shiftY;
          const off = clusterPointOffsetsRef.current[ci][pi];
          applyPush(off, dispX, dispY, speed);
          const fx = dispX + off.x;
          const fy = dispY + off.y;
          pts.push([fx, fy]);
          const el = clusterPointElsRef.current[ci]?.[pi];
          // Delta relativo ao cx/cy-base já declarado no JSX (bx/by) — ver
          // comentário de LOGIC_INTERVAL_MS acima. A polyline continua via
          // atributo `points` (poucos elementos, cada vértice desloca
          // independente — não representável como um único transform).
          if (el) {
            const valor = `translate(${quantizeHalfPx(fx - bx)}px, ${quantizeHalfPx(fy - by)}px)`;
            if (el.style.transform !== valor) el.style.transform = valor;
          }
        });
        const line = clusterLineElsRef.current[ci];
        if (line) {
          // Mesma razão da estrela: `setAttribute` a cada tick é um recálculo
          // garantido, mesmo quando nenhum vértice mudou o suficiente para
          // aparecer. Compara a string antes de tocar no DOM.
          const pontos = pts.map(([x, y]) => `${quantizeHalfPx(x)},${quantizeHalfPx(y)}`).join(" ");
          if (line.getAttribute("points") !== pontos) line.setAttribute("points", pontos);
        }
      });
    }

    function start() {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      window.removeEventListener("pointermove", onPointerMove);
      cancelAnimationFrame(raf);
    }

    // Live, not just read-once-at-mount: the user can flip this OS
    // setting while the app is open.
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!mql.matches) start();
    function onMqlChange() {
      if (mql.matches) stop();
      else start();
    }
    mql.addEventListener("change", onMqlChange);

    return () => {
      stop();
      mql.removeEventListener("change", onMqlChange);
      ro.disconnect();
    };
  }, []);

  heroIndex = 0;

  return (
    <svg
      ref={svgRef}
      className="home-stars"
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id="star-glow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="1.1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {FIELD_STARS.map((star, i) => (
        <circle
          key={`field-${i}`}
          ref={(el) => {
            fieldElsRef.current[i] = el;
          }}
          cx={star.x}
          cy={star.y}
          r={star.r}
          fill="var(--text)"
          opacity={star.opacity}
        />
      ))}

      {CLUSTER_INSTANCES.map((cluster, ci) => (
        <g key={`cluster-${ci}`}>
          <polyline
            ref={(el) => {
              clusterLineElsRef.current[ci] = el;
            }}
            points={cluster.points.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke="var(--foam)"
            strokeWidth="0.15"
            strokeOpacity="0.4"
            strokeLinecap="round"
          />
          {cluster.points.map(([x, y], pi) => {
            const isHero = cluster.hero.includes(pi);
            const delay = isHero ? -((heroIndex++ % 6) * 0.7) : 0;
            return (
              <circle
                key={`cluster-${ci}-${pi}`}
                ref={(el) => {
                  (clusterPointElsRef.current[ci] ??= [])[pi] = el;
                }}
                cx={x}
                cy={y}
                r={isHero ? 0.55 : 0.3}
                fill={isHero ? "var(--foam)" : "var(--text)"}
                opacity={isHero ? 0.95 : 0.6}
                filter={isHero ? "url(#star-glow)" : undefined}
                className={isHero ? "home-star-hero" : undefined}
                style={isHero ? { animationDelay: `${delay}s` } : undefined}
              />
            );
          })}
        </g>
      ))}
    </svg>
  );
}

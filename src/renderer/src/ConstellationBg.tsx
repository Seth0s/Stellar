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
 */
const FIELD_STARS = [
  [4, 8], [18, 95], [28, 40], [38, 92], [42, 55], [55, 18], [62, 92],
  [72, 70], [82, 88], [90, 45], [95, 12], [8, 78], [65, 62], [30, 78],
  [50, 6], [86, 60], [12, 35], [75, 15], [46, 34], [20, 15],
] as const;

// Each cluster is a small constellation: points connected in sequence by
// thin lines, with 1-2 of its points promoted to a bright, glowing "hero"
// star so the shape actually stands out against the field stars.
const CLUSTERS: { points: [number, number][]; hero: number[] }[] = [
  { points: [[14, 20], [22, 14], [31, 22], [26, 32], [17, 30]], hero: [0, 2] },
  { points: [[68, 30], [78, 24], [84, 34], [76, 42]], hero: [1] },
  { points: [[56, 68], [64, 60], [72, 66], [70, 78], [60, 80]], hero: [0, 3] },
  { points: [[10, 62], [18, 58], [24, 66]], hero: [1] },
];

export function ConstellationBg() {
  return (
    <svg
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

      {FIELD_STARS.map(([x, y], i) => (
        <circle key={`field-${i}`} cx={x} cy={y} r={i % 3 === 0 ? 0.35 : 0.22} fill="var(--text)" opacity={i % 3 === 0 ? 0.55 : 0.35} />
      ))}

      {CLUSTERS.map((cluster, ci) => (
        <g key={`cluster-${ci}`}>
          <polyline
            points={cluster.points.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke="var(--foam)"
            strokeWidth="0.15"
            strokeOpacity="0.4"
            strokeLinecap="round"
          />
          {cluster.points.map(([x, y], pi) => {
            const isHero = cluster.hero.includes(pi);
            return (
              <circle
                key={`cluster-${ci}-${pi}`}
                cx={x}
                cy={y}
                r={isHero ? 0.55 : 0.3}
                fill={isHero ? "var(--foam)" : "var(--text)"}
                opacity={isHero ? 0.95 : 0.6}
                filter={isHero ? "url(#star-glow)" : undefined}
                className={isHero ? "home-star-hero" : undefined}
              />
            );
          })}
        </g>
      ))}
    </svg>
  );
}

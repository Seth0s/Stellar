/** Inline SVGs from Rail.dc.html — keep stroke/paths identical to the prototype. */

type GlyphProps = { stroke?: string; size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 18 18",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  "aria-hidden": true as const,
});

export function RailGlyphPointer({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 2l10 6-4.5 1.5L7.5 14z" />
    </svg>
  );
}

export function RailGlyphPen({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3l3 3-8.5 8.5H3.5v-3z" />
    </svg>
  );
}

/** Line with two endpoint dots — not a chain-link. */
export function RailGlyphConnector({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <circle cx="4" cy="14" r="2" />
      <circle cx="14" cy="4" r="2" />
      <path d="M5.5 12.5l7-7" />
    </svg>
  );
}

export function RailGlyphSelect({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeDasharray="2.5 2">
      <rect x="3" y="3" width="12" height="12" rx="2" />
    </svg>
  );
}

export function RailGlyphExport({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 2v11h11M2 5h11v11" />
    </svg>
  );
}

export function RailGlyphPlus({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeWidth={1.8}>
      <path d="M9 3v12M3 9h12" />
    </svg>
  );
}

export function RailGlyphFind({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <circle cx="8" cy="8" r="5" />
      <path d="M12 12l4 4" />
    </svg>
  );
}

/** Four-point star from the prototype (AI actions). */
export function RailGlyphAi({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 2l1.6 4.4L15 8l-4.4 1.6L9 14l-1.6-4.4L3 8l4.4-1.6z" />
    </svg>
  );
}

/** Two offset squares — prototype "Agrupar seleção". */
export function RailGlyphGroup({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="2" width="6" height="6" rx="1.5" />
      <rect x="10" y="10" width="6" height="6" rx="1.5" />
    </svg>
  );
}

export function RailGlyphSettings({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <circle cx="9" cy="9" r="2.5" />
      <path d="M9 1.5v2.5M9 14v2.5M1.5 9H4M14 9h2.5M3.7 3.7l1.8 1.8M12.5 12.5l1.8 1.8M3.7 14.3l1.8-1.8M12.5 5.5l1.8-1.8" />
    </svg>
  );
}

export function RailGlyphCollapse({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <rect x="2.5" y="3" width="13" height="12" rx="2" />
      <path d="M7 3v12" />
    </svg>
  );
}

export function RailGlyphTerminal({ size = 18 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="3" width="14" height="12" rx="2" />
      <path d="M5 7l2.5 2L5 11M9 11h4" />
    </svg>
  );
}

export function RailGlyphLogo({ size = 16 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="var(--rail-link)" aria-hidden="true">
      <path d="M8 0l1.8 6.2L16 8l-6.2 1.8L8 16l-1.8-6.2L0 8l6.2-1.8z" />
    </svg>
  );
}

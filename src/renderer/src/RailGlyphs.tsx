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

export function RailGlyphPointer({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 2l10 6-4.5 1.5L7.5 14z" />
    </svg>
  );
}

export function RailGlyphPen({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3l3 3-8.5 8.5H3.5v-3z" />
    </svg>
  );
}

/** Check mark of the active session row (RailPassos.dc.html). */
export function RailGlyphCheck({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} viewBox="0 0 16 16" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.4 8.4l3 3 6-6.4" />
    </svg>
  );
}

/** Line with two endpoint dots — not a chain-link. */
export function RailGlyphConnector({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <circle cx="4" cy="14" r="2" />
      <circle cx="14" cy="4" r="2" />
      <path d="M5.5 12.5l7-7" />
    </svg>
  );
}

export function RailGlyphSelect({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeDasharray="2.5 2">
      <rect x="3" y="3" width="12" height="12" rx="2" />
    </svg>
  );
}

export function RailGlyphExport({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 2v11h11M2 5h11v11" />
    </svg>
  );
}

export function RailGlyphPlus({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeWidth={1.8}>
      <path d="M9 3v12M3 9h12" />
    </svg>
  );
}

export function RailGlyphFind({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <circle cx="8" cy="8" r="5" />
      <path d="M12 12l4 4" />
    </svg>
  );
}

/** Four-point star from the prototype (AI actions). */
export function RailGlyphAi({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 2l1.6 4.4L15 8l-4.4 1.6L9 14l-1.6-4.4L3 8l4.4-1.6z" />
    </svg>
  );
}

/** Two offset squares — prototype "Agrupar seleção". */
export function RailGlyphGroup({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="2" width="6" height="6" rx="1.5" />
      <rect x="10" y="10" width="6" height="6" rx="1.5" />
    </svg>
  );
}

/** Eight-tooth cog with a hub — reads as a gear, not a sun. */
export function RailGlyphSettings({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinejoin="round">
      <path d="M7.28 3.36L7.68 1.52L10.32 1.52L10.72 3.36A5.9 5.9 0 0 1 11.77 3.79L13.36 2.77L15.23 4.64L14.21 6.23A5.9 5.9 0 0 1 14.64 7.28L16.48 7.68L16.48 10.32L14.64 10.72A5.9 5.9 0 0 1 14.21 11.77L15.23 13.36L13.36 15.23L11.77 14.21A5.9 5.9 0 0 1 10.72 14.64L10.32 16.48L7.68 16.48L7.28 14.64A5.9 5.9 0 0 1 6.23 14.21L4.64 15.23L2.77 13.36L3.79 11.77A5.9 5.9 0 0 1 3.36 10.72L1.52 10.32L1.52 7.68L3.36 7.28A5.9 5.9 0 0 1 3.79 6.23L2.77 4.64L4.64 2.77L6.23 3.79A5.9 5.9 0 0 1 7.28 3.36Z" />
      <circle cx="9" cy="9" r="2.3" />
    </svg>
  );
}

/** Double chevron — hides the rail (there is no matching "open" button). */
export function RailGlyphHide({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinejoin="round" strokeLinecap="round">
      <path d="M10 4L5 9l5 5M14.5 4L9.5 9l5 5" />
    </svg>
  );
}

export function RailGlyphHome({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinejoin="round" strokeLinecap="round">
      <path d="M2.5 8.5L9 3l6.5 5.5M4.5 7.5V15h3.5v-4h2v4h3.5V7.5" />
    </svg>
  );
}

/** Command key — the Ctrl K palette. */
export function RailGlyphPalette({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinejoin="round" strokeLinecap="round">
      <path d="M6.5 6.5V5A2 2 0 1 0 5 6.5h8A2 2 0 1 0 11.5 5v8A2 2 0 1 0 13 11.5H5A2 2 0 1 0 6.5 13z" />
    </svg>
  );
}

/** Four tiles — the Board / session panel. */
export function RailGlyphBoard({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="5.5" height="7" rx="1" />
      <rect x="10" y="2.5" width="5.5" height="4" rx="1" />
      <rect x="10" y="8.5" width="5.5" height="7" rx="1" />
      <rect x="2.5" y="11.5" width="5.5" height="4" rx="1" />
    </svg>
  );
}

export function RailGlyphTerminal({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="3" width="14" height="12" rx="2" />
      <path d="M5 7l2.5 2L5 11M9 11h4" />
    </svg>
  );
}

/* View-pill glyphs (zoom / fullscreen / grid / pair phone) — RailPassos.dc.html. */

export function RailGlyphZoomOut({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinecap="round">
      <path d="M4 9h10" />
    </svg>
  );
}

export function RailGlyphZoomIn({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinecap="round">
      <path d="M4 9h10M9 4v10" />
    </svg>
  );
}

export function RailGlyphFullscreen({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinejoin="round" strokeLinecap="round">
      <path d="M3 6.5V3h3.5M11.5 3H15v3.5M15 11.5V15h-3.5M6.5 15H3v-3.5" />
    </svg>
  );
}

export function RailGlyphFullscreenExit({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinejoin="round" strokeLinecap="round">
      <path d="M6.5 3v3.5H3M15 6.5h-3.5V3M11.5 15v-3.5H15M3 11.5h3.5V15" />
    </svg>
  );
}

export function RailGlyphGrid({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeLinecap="round">
      <path d="M3 6h12M3 12h12M6 3v12M12 3v12" />
    </svg>
  );
}

/** QR code — pair a phone. */
export function RailGlyphQr({ size = 16 }: GlyphProps) {
  return (
    <svg {...base(size)} strokeWidth={1.3} strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="5" height="5" rx="1" />
      <rect x="10.5" y="2.5" width="5" height="5" rx="1" />
      <rect x="2.5" y="10.5" width="5" height="5" rx="1" />
      <path d="M11 11h1.5v1.5H11zM14 14h1.5v1.5H14zM14 11h1.5M11 14h1.5" />
    </svg>
  );
}

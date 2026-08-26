/**
 * Inline brand mark — same artwork as `build/icon.svg` (the app/window
 * icon), just cropped to its own content (no background square, no
 * glow — those only read right against a dark backdrop, not inline next
 * to text) so it drops cleanly next to the "Stellar" wordmark wherever
 * it's used (Titlebar, Home's header — DESIGN-BACKLOG.md item 14).
 */
export function StellarMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="240 280 560 540" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g stroke="#39404d" strokeWidth="10" strokeLinecap="round">
        <line x1="512" y1="512" x2="300" y2="360" />
        <line x1="512" y1="512" x2="724" y2="360" />
        <line x1="512" y1="512" x2="512" y2="760" />
      </g>
      <path
        d="M512 300 L556 468 L724 512 L556 556 L512 724 L468 556 L300 512 L468 468 Z"
        fill="#45c8ff"
      />
      <circle cx="300" cy="360" r="34" fill="#8f7bff" />
      <circle cx="724" cy="360" r="34" fill="#e8c547" />
      <circle cx="512" cy="760" r="34" fill="#4ad87a" />
    </svg>
  );
}

/**
 * Best-effort current-symbol label for the code breadcrumb. Uses only the
 * open buffer text and cursor line — no invented AST when the line has no
 * recognizable declaration.
 */

const DECL =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+|class\s+|const\s+|let\s+|var\s+|type\s+|interface\s+|enum\s+)([A-Za-z_$][\w$]*)/;

/**
 * Walk upward from `line` (1-based) and return the nearest declaration
 * name, or null when none is found in the preceding window.
 */
export function decideBreadcrumbSymbol(content: string, line: number): string | null {
  if (!content || line < 1) return null;
  const lines = content.split("\n");
  const idx = Math.min(line, lines.length) - 1;
  const start = Math.max(0, idx - 80);
  for (let i = idx; i >= start; i--) {
    const m = lines[i]!.match(DECL);
    if (m?.[1]) return m[1];
  }
  return null;
}

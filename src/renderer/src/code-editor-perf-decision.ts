/**
 * Budget helpers for the code card when the open buffer is large enough
 * that full syntax work / markdown preview / per-frame string splits would
 * stall the board's pan/zoom path (CSS transform on `.world` still
 * re-renders card props every pointer move).
 */

/** Above this, markdown opens in the code editor instead of preview.
 * Measured: a 1000-line preview produced ~9 long tasks / 546ms during a
 * 5s board drag; keep the auto-preview budget well under that. */
export const MARKDOWN_PREVIEW_MAX_LINES = 800;

/** Above this (or PLAIN_MAX_BYTES), CodeMirror skips language/indent/fold work. */
export const PLAIN_EDITOR_MAX_LINES = 8_000;

/** Same byte ceiling the IDE used to refuse entirely — now triggers plain mode. */
export const PLAIN_EDITOR_MAX_BYTES = 512 * 1024;

export type EditorPerfMode = "full" | "plain";

export type EditorPerfDecision = {
  mode: EditorPerfMode;
  allowMarkdownPreview: boolean;
  showPlainBanner: boolean;
  lineCount: number;
};

/** Line count without allocating a full `split("\\n")` array. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

export function decideEditorPerfMode(content: string): EditorPerfDecision {
  const lineCount = countLines(content);
  const byteLength = content.length;
  const plain =
    lineCount >= PLAIN_EDITOR_MAX_LINES || byteLength >= PLAIN_EDITOR_MAX_BYTES;
  const allowMarkdownPreview =
    lineCount < MARKDOWN_PREVIEW_MAX_LINES && byteLength < PLAIN_EDITOR_MAX_BYTES;
  return {
    mode: plain ? "plain" : "full",
    allowMarkdownPreview,
    showPlainBanner: plain,
    lineCount,
  };
}

/**
 * Slice of `content` covering at most `before` lines above `line` (1-based)
 * through that line — for breadcrumb symbol scan without splitting the
 * whole buffer into an array.
 */
export function extractLineWindow(content: string, line: number, before = 80): {
  text: string;
  cursorLineInWindow: number;
} {
  if (!content || line < 1) return { text: "", cursorLineInWindow: 1 };
  const startLine = Math.max(1, line - before);
  let lineNo = 1;
  let startIdx = 0;
  let endIdx = content.length;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) !== 10) continue;
    if (lineNo === line) {
      endIdx = i;
      break;
    }
    lineNo += 1;
    if (lineNo === startLine) startIdx = i + 1;
  }
  return {
    text: content.slice(startIdx, endIdx),
    cursorLineInWindow: line - startLine + 1,
  };
}

export type MinimapBarSpec = {
  lineNo: number;
  widthPct: number;
  color: string | undefined;
};

/**
 * Build the decorative minimap bars in one pass — no `split("\\n")`, at
 * most `maxBars` entries. Callers must memoize; this is still O(n) in
 * content length.
 */
export function decideMinimapBars(
  content: string,
  maxBars: number,
  colorForLine: (lineNo: number) => string | undefined,
): MinimapBarSpec[] {
  if (!content || maxBars <= 0) return [];
  const lineCount = countLines(content);
  const step = Math.max(1, Math.ceil(lineCount / maxBars));
  const bars: MinimapBarSpec[] = [];
  let lineNo = 1;
  let lineStart = 0;
  for (let i = 0; i <= content.length; i++) {
    const atEnd = i === content.length;
    const nl = !atEnd && content.charCodeAt(i) === 10;
    if (!nl && !atEnd) continue;
    if ((lineNo - 1) % step === 0) {
      const len = i - lineStart;
      bars.push({
        lineNo,
        widthPct: Math.min(100, 12 + Math.min(88, len)),
        color: colorForLine(lineNo),
      });
    }
    lineNo += 1;
    lineStart = i + 1;
    if (atEnd) break;
  }
  return bars;
}

/**
 * browser_screenshot / acbridge snapshot flags — which capture mode and
 * where the PNG lands. Pure: the registry owns capturePage / crop / I/O.
 *
 * Modes are mutually exclusive: viewport (default), fullPage, or one
 * element (selector XOR ref). Optional `out` names the destination path;
 * optional `width` temporarily sets CSS viewport width for the capture
 * (acbridge snapshot --width), then the previous emulation is restored.
 */

import { isAbsolute } from "node:path";

export type ScreenshotInput = {
  fullPage?: boolean | null;
  selector?: string | null;
  ref?: string | null;
  /** Absolute destination path. Omit → temp file under the app temp dir. */
  out?: string | null;
  /** Temporary CSS viewport width for this capture only. */
  width?: number | null;
};

export type ScreenshotMode =
  | { kind: "viewport" }
  | { kind: "fullPage" }
  | { kind: "element"; selector: string }
  | { kind: "element"; ref: string };

export type ScreenshotDecision =
  | {
      action: "capture";
      mode: ScreenshotMode;
      out: string | null;
      width: number | null;
    }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeScreenshotRefuse(reason: string): string {
  return `browser_screenshot refused: ${reason}`;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Decide capture mode. Element targeting prefers `ref` over `selector` when
 * both are present (same precedence as browser_click).
 */
export function decideScreenshot(input: ScreenshotInput): ScreenshotDecision {
  const fullPage = input.fullPage === true;
  const selector = typeof input.selector === "string" ? input.selector.trim() : "";
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  const outRaw = typeof input.out === "string" ? input.out.trim() : "";
  const width = asFiniteNumber(input.width);

  const elementAsked = Boolean(selector || ref);
  if (fullPage && elementAsked) {
    return {
      action: "refuse",
      error: describeScreenshotRefuse("pass fullPage OR selector/ref — not both"),
    };
  }
  if (selector && ref) {
    // Prefer ref (click/type convention) — still refuse ambiguous dual to
    // keep the agent-facing contract honest about one target.
    return {
      action: "refuse",
      error: describeScreenshotRefuse("pass selector OR ref — not both"),
    };
  }

  if (outRaw) {
    if (!isAbsolute(outRaw)) {
      return {
        action: "refuse",
        error: describeScreenshotRefuse(
          `out must be an absolute path (got ${JSON.stringify(outRaw)})`,
        ),
      };
    }
  }

  if (width !== null) {
    if (width < 100 || width > 3000) {
      return {
        action: "refuse",
        error: describeScreenshotRefuse("width must be between 100 and 3000 CSS pixels"),
      };
    }
  }

  let mode: ScreenshotMode = { kind: "viewport" };
  if (fullPage) mode = { kind: "fullPage" };
  else if (ref) mode = { kind: "element", ref };
  else if (selector) mode = { kind: "element", selector };

  return {
    action: "capture",
    mode,
    out: outRaw || null,
    width: width !== null ? Math.round(width) : null,
  };
}

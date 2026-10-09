/**
 * browser_set_viewport — validate device-emulation params for one browser
 * card. Pure: the registry owns setContentSize / UA / CDP touch overrides.
 *
 * Media queries evaluate at the emulated CSS width (content size ÷ zoom),
 * not the card's on-board pixel size. reset restores the card's last layout
 * size (tracked by resize), not a hardcoded default.
 */

export const VIEWPORT_DIM_MIN = 100;
export const VIEWPORT_DIM_MAX = 3000;
export const VIEWPORT_DSF_MIN = 1;
export const VIEWPORT_DSF_MAX = 3;

export type ViewportInput = {
  width?: number | null;
  height?: number | null;
  deviceScaleFactor?: number | null;
  mobile?: boolean | null;
  /** Explicit reset — mutually exclusive with width/height. */
  reset?: boolean | null;
};

export type ViewportDecision =
  | {
      action: "apply";
      width: number;
      height: number;
      deviceScaleFactor: number;
      mobile: boolean;
    }
  | { action: "reset" }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeViewportRefuse(reason: string): string {
  return `browser_set_viewport refused: ${reason}`;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function clampDim(n: number): number {
  return Math.max(VIEWPORT_DIM_MIN, Math.min(VIEWPORT_DIM_MAX, Math.round(n)));
}

/**
 * Decide apply vs reset. `mobile` defaults to width < 768 (same heuristic as
 * the inspector's custom-size path). `deviceScaleFactor` defaults to 1.
 */
export function decideViewport(input: ViewportInput): ViewportDecision {
  if (input.reset === true) {
    if (asFiniteNumber(input.width) !== null || asFiniteNumber(input.height) !== null) {
      return {
        action: "refuse",
        error: describeViewportRefuse("pass reset:true alone, or width+height — not both"),
      };
    }
    return { action: "reset" };
  }

  const width = asFiniteNumber(input.width);
  const height = asFiniteNumber(input.height);
  if (width === null || height === null) {
    return {
      action: "refuse",
      error: describeViewportRefuse(
        "width and height are required (CSS pixels), or pass reset:true to leave device emulation",
      ),
    };
  }
  if (width < VIEWPORT_DIM_MIN || height < VIEWPORT_DIM_MIN) {
    return {
      action: "refuse",
      error: describeViewportRefuse(`width/height must be >= ${VIEWPORT_DIM_MIN}`),
    };
  }
  if (width > VIEWPORT_DIM_MAX || height > VIEWPORT_DIM_MAX) {
    return {
      action: "refuse",
      error: describeViewportRefuse(`width/height must be <= ${VIEWPORT_DIM_MAX}`),
    };
  }

  let deviceScaleFactor = 1;
  const dsf = asFiniteNumber(input.deviceScaleFactor);
  if (dsf !== null) {
    if (dsf < VIEWPORT_DSF_MIN || dsf > VIEWPORT_DSF_MAX) {
      return {
        action: "refuse",
        error: describeViewportRefuse(
          `deviceScaleFactor must be between ${VIEWPORT_DSF_MIN} and ${VIEWPORT_DSF_MAX}`,
        ),
      };
    }
    deviceScaleFactor = dsf;
  }

  const mobile = typeof input.mobile === "boolean" ? input.mobile : clampDim(width) < 768;

  return {
    action: "apply",
    width: clampDim(width),
    height: clampDim(height),
    deviceScaleFactor,
    mobile,
  };
}

export type EmulationSummary = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  /** Who last applied this state — inspector unmount only clears its own. */
  source: "inspector" | "agent";
};

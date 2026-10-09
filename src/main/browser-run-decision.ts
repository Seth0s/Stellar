/**
 * browser_run — one MCP call, many browser actions on the same card.
 *
 * Measured cost without this: 15–20 round-trips per screen (click → snapshot →
 * type → …). The owner still watches the card live; this only collapses the
 * agent↔tool chatter. Each step reuses the existing browser_* handlers — this
 * module only validates the batch shape, limits, and stop/timeout policy.
 */

export const BROWSER_RUN_MAX_STEPS = 40;
/** Default wall-clock budget for the whole run, in ms. */
export const BROWSER_RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const BROWSER_RUN_MIN_TIMEOUT_MS = 1_000;
/** Ceiling so a hung wait_for inside a step cannot pin the MCP idle timeout. */
export const BROWSER_RUN_MAX_TIMEOUT_MS = 300_000;

export const BROWSER_RUN_ACTIONS = ["click", "type", "wait_for", "navigate", "snapshot", "eval"] as const;
export type BrowserRunAction = (typeof BROWSER_RUN_ACTIONS)[number];

export type BrowserRunStep = {
  action: BrowserRunAction;
  selector?: string;
  ref?: string;
  role?: string;
  name?: string;
  /** For type: the string to insert. For click/wait_for: visible-text locator. */
  text?: string;
  frame?: string;
  x?: number;
  y?: number;
  replace?: boolean;
  gone?: boolean;
  url?: string;
  expectSelector?: string;
  js?: string;
  timeoutMs?: number;
};

export type BrowserRunPlan = {
  steps: BrowserRunStep[];
  stopOnError: boolean;
  finalSnapshot: boolean;
  timeoutMs: number;
};

function isAction(value: unknown): value is BrowserRunAction {
  return typeof value === "string" && (BROWSER_RUN_ACTIONS as readonly string[]).includes(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Normalize the wall-clock budget (absent/invalid → default, clamped). */
export function normalizeBrowserRunTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return BROWSER_RUN_DEFAULT_TIMEOUT_MS;
  const clamped = Math.round(value);
  if (clamped < BROWSER_RUN_MIN_TIMEOUT_MS) return BROWSER_RUN_MIN_TIMEOUT_MS;
  if (clamped > BROWSER_RUN_MAX_TIMEOUT_MS) return BROWSER_RUN_MAX_TIMEOUT_MS;
  return clamped;
}

/**
 * Validate and normalize a browser_run payload. Pure — no I/O.
 * AGENT-FACING error strings — DO NOT TRANSLATE.
 */
export function normalizeBrowserRun(input: {
  steps: unknown;
  stopOnError?: unknown;
  finalSnapshot?: unknown;
  timeoutMs?: unknown;
}): { ok: true; plan: BrowserRunPlan } | { ok: false; error: string } {
  if (!Array.isArray(input.steps)) {
    return {
      ok: false,
      error:
        "browser_run refused: `steps` must be an array of actions (click|type|wait_for|navigate|snapshot|eval). Nothing was run.",
    };
  }
  if (input.steps.length === 0) {
    return {
      ok: false,
      error: "browser_run refused: `steps` is empty — pass at least one action. Nothing was run.",
    };
  }
  if (input.steps.length > BROWSER_RUN_MAX_STEPS) {
    return {
      ok: false,
      error:
        `browser_run refused: ${input.steps.length} steps exceeds the limit of ${BROWSER_RUN_MAX_STEPS} ` +
        `(pass fewer steps, or split across calls). Nothing was run.`,
    };
  }

  const steps: BrowserRunStep[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const raw = input.steps[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        error: `browser_run refused: steps[${i}] must be an object with an \`action\` field. Nothing was run.`,
      };
    }
    const obj = raw as Record<string, unknown>;
    if (!isAction(obj.action)) {
      return {
        ok: false,
        error:
          `browser_run refused: steps[${i}].action must be one of ${BROWSER_RUN_ACTIONS.join("|")} ` +
          `(got ${JSON.stringify(obj.action)}). Nothing was run.`,
      };
    }
    const action = obj.action;
    const step: BrowserRunStep = {
      action,
      selector: asOptionalString(obj.selector),
      ref: asOptionalString(obj.ref),
      role: asOptionalString(obj.role),
      name: asOptionalString(obj.name),
      text: asOptionalString(obj.text),
      frame: asOptionalString(obj.frame),
      x: asOptionalNumber(obj.x),
      y: asOptionalNumber(obj.y),
      replace: asOptionalBoolean(obj.replace),
      gone: asOptionalBoolean(obj.gone),
      url: asOptionalString(obj.url),
      expectSelector: asOptionalString(obj.expectSelector),
      js: asOptionalString(obj.js),
      timeoutMs: asOptionalNumber(obj.timeoutMs),
    };

    if (action === "click") {
      if (
        !step.ref &&
        !step.selector &&
        !step.role &&
        !step.text &&
        (step.x === undefined || step.y === undefined)
      ) {
        return {
          ok: false,
          error: `browser_run refused: steps[${i}] click needs a ref, selector, role, text, or both x and y. Nothing was run.`,
        };
      }
    } else if (action === "type") {
      if (step.text === undefined) {
        return {
          ok: false,
          error: `browser_run refused: steps[${i}] type needs \`text\`. Nothing was run.`,
        };
      }
    } else if (action === "wait_for") {
      if (!step.selector && !step.text) {
        return {
          ok: false,
          error: `browser_run refused: steps[${i}] wait_for needs \`selector\` or \`text\`. Nothing was run.`,
        };
      }
    } else if (action === "navigate") {
      if (!step.url) {
        return {
          ok: false,
          error: `browser_run refused: steps[${i}] navigate needs \`url\`. Nothing was run.`,
        };
      }
    } else if (action === "eval") {
      if (!step.js) {
        return {
          ok: false,
          error: `browser_run refused: steps[${i}] eval needs \`js\`. Nothing was run.`,
        };
      }
    }
    steps.push(step);
  }

  return {
    ok: true,
    plan: {
      steps,
      stopOnError: input.stopOnError === false ? false : true,
      finalSnapshot: input.finalSnapshot === true,
      timeoutMs: normalizeBrowserRunTimeout(input.timeoutMs),
    },
  };
}

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeBrowserRunTimeout(timeoutMs: number): string {
  return (
    `[de: stellar] browser_run gave up after ${timeoutMs}ms (${(timeoutMs / 1000).toFixed(1)}s) wall-clock — ` +
    `this is the run's own \`timeoutMs\` (default ${BROWSER_RUN_DEFAULT_TIMEOUT_MS}ms, ceiling ${BROWSER_RUN_MAX_TIMEOUT_MS}ms). ` +
    `Completed steps keep their results; later steps were not started. Raise \`timeoutMs\` or shorten the script.`
  );
}

/**
 * Build the BusRequest body for one normalized step (target/requester filled by caller).
 */
export function stepToBusFields(step: BrowserRunStep): {
  cmd:
    | "browser_click"
    | "browser_type"
    | "browser_wait_for"
    | "browser_navigate"
    | "browser_snapshot"
    | "browser_eval";
  fields: Record<string, unknown>;
} {
  switch (step.action) {
    case "click":
      return {
        cmd: "browser_click",
        fields: {
          selector: step.selector,
          ref: step.ref,
          role: step.role,
          name: step.name,
          text: step.text,
          frame: step.frame,
          x: step.x,
          y: step.y,
        },
      };
    case "type":
      return {
        cmd: "browser_type",
        fields: {
          text: step.text,
          selector: step.selector,
          ref: step.ref,
          role: step.role,
          name: step.name,
          frame: step.frame,
          replace: step.replace === true,
        },
      };
    case "wait_for":
      return {
        cmd: "browser_wait_for",
        fields: {
          selector: step.selector,
          text: step.text,
          gone: step.gone,
          timeoutMs: step.timeoutMs,
        },
      };
    case "navigate":
      return {
        cmd: "browser_navigate",
        fields: { url: step.url, expectSelector: step.expectSelector, timeoutMs: step.timeoutMs },
      };
    case "snapshot":
      return { cmd: "browser_snapshot", fields: { frame: step.frame } };
    case "eval":
      return { cmd: "browser_eval", fields: { js: step.js, timeoutMs: step.timeoutMs } };
  }
}

/** Pull url/title out of a step result or a meta probe when present. */
export function extractAfterState(result: unknown): { url?: string; title?: string } {
  if (!result || typeof result !== "object") return {};
  const obj = result as Record<string, unknown>;
  const url = typeof obj.url === "string" ? obj.url : undefined;
  const title = typeof obj.title === "string" ? obj.title : undefined;
  if (url !== undefined || title !== undefined) return { url, title };
  // browser_eval JSON-stringifies; a probe may arrive as result: "{\"url\":...}"
  if (typeof obj.result === "string") {
    try {
      const parsed = JSON.parse(obj.result) as unknown;
      return extractAfterState(parsed);
    } catch {
      return {};
    }
  }
  return {};
}

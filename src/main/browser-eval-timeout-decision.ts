/**
 * browser_eval — how long to wait, how to run the script, what to say on failure.
 *
 * Two wait-mode failures seen in real use:
 *
 * MODE 1 — an eval whose JS took a few seconds was killed by the MCP idle
 * timeout (~300s), and the error that arrived ("idle timeout") did not name
 * the script. MECHANISM: the expression returned a thenable that NEVER
 * settled (a nested setTimeout hung the chain) and the wait stayed open until
 * an ALIEN limit. The fix is not "wait less": it is an OWN limit and a message
 * that says what was waited for.
 *
 * MODE 2 — on an Angular SPA, returning a Promise brought back literally
 * `{"__zone_symbol__state": null, "__zone_symbol__value": []}`. Zone.js
 * REPLACES the global Promise; Electron's wait recognises Promise by
 * identity, does not recognise the swapped one, and returns the OBJECT as if
 * it were the value — a plausible value that is not the value, worse than an
 * error. The smoke fixture replaces global Promise the way Zone does: the
 * same expression returned the Zone object before this envelope, and the
 * value after.
 *
 * Script shape (card-browser feedback):
 * - Top-level `return` failed with Electron's opaque "Script failed to
 *   execute…" because the script was wrapped as a parenthesized expression.
 * - Without `await` as a statement, a Radix portal flow needed two calls.
 * - A throw lost message/stack/line behind the same opaque Electron string.
 *
 * Form choice (expression vs statements) happens in MAIN with Node's
 * `new Function` (parse only). The page receives the chosen body as a
 * literal inside an async IIFE — no `eval` / `new Function` in the page,
 * so CSP `script-src` without `unsafe-eval` (GitHub, many production apps)
 * does not break browser_eval. executeJavaScript injects the source; only
 * in-page dynamic compile was subject to that CSP rule.
 *
 * The default 30s covers normal use (measure/scroll/wait a render) and is a
 * PARAMETER because some evals are legitimately slow; the ceiling exists so
 * the call fails before the MCP idle timeout.
 */

/** Default wait for one browser_eval, in ms. */
export const EVAL_TIMEOUT_DEFAULT_MS = 30_000;
/** Floor: below this even one round-trip to the page does not fit. */
export const EVAL_TIMEOUT_MIN_MS = 200;
/** Ceiling: the MCP idle timeout (~300s) is a BAD error to receive; the own
 * limit must fire first, with a message about the script. */
export const EVAL_TIMEOUT_MAX_MS = 120_000;

/** Page-side success marker (structured clone back to main). */
export const EVAL_OK_KEY = "__stellar_browser_eval_ok" as const;
/** Page-side thrown-error marker. */
export const EVAL_ERR_KEY = "__stellar_browser_eval_err" as const;

export type EvalThrown = {
  message: string;
  stack: string | null;
  line: number | null;
};

export type UnwrappedEval =
  | { kind: "value"; value: unknown }
  | { kind: "thrown"; error: EvalThrown };

/** Which shape MAIN chose after a parse-only probe (Node, not page CSP). */
export type EvalScriptForm = "expression" | "statements";

export type EvalFormChoice =
  | { form: EvalScriptForm }
  | { form: "invalid"; error: EvalThrown };

/** Normalize the caller's limit (absent/invalid → default). */
export function normalizeEvalTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return EVAL_TIMEOUT_DEFAULT_MS;
  const clamped = Math.round(value);
  if (clamped < EVAL_TIMEOUT_MIN_MS) return EVAL_TIMEOUT_MIN_MS;
  if (clamped > EVAL_TIMEOUT_MAX_MS) return EVAL_TIMEOUT_MAX_MS;
  return clamped;
}

/** AGENT-FACING — DO NOT TRANSLATE. Says what happened and how to change it. */
export function describeEvalTimeout(input: { waitedMs: number; timeoutMs: number }): string {
  return (
    `[de: stellar] browser_eval gave up after waiting ${input.timeoutMs}ms (${(input.timeoutMs / 1000).toFixed(1)}s) ` +
    `for the expression to settle — the script itself KEPT RUNNING in the page (nothing was killed, and its result ` +
    `was discarded), and if it resolves a promise later you will not see it. This is a limit of THIS call, not the ` +
    `page's: pass a larger \`timeoutMs\` (up to ${EVAL_TIMEOUT_MAX_MS}ms) when the eval legitimately takes long ` +
    `(waiting a render, scrolling a big page), or make the expression resolve faster — an expression that never ` +
    `settles (a promise with no resolve, a chained setTimeout that hangs) will always hit this. Nothing was returned.`
  );
}

/** AGENT-FACING — DO NOT TRANSLATE. Real exception surface (not Electron's opaque string). */
export function describeEvalThrown(error: EvalThrown): string {
  const linePart = error.line != null ? ` (script line ${error.line})` : "";
  const stackPart = error.stack ? `\n${error.stack}` : "";
  return `[de: stellar] browser_eval threw: ${error.message}${linePart}${stackPart}`;
}

/**
 * Unpack the page-side envelope. A bare value (no marker) is treated as the
 * result so an older path without the wrapper still surfaces something useful.
 */
export function unwrapEvalRaw(raw: unknown): UnwrappedEval {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj[EVAL_OK_KEY] === true) {
      return { kind: "value", value: obj.value };
    }
    if (obj[EVAL_ERR_KEY] === true) {
      return {
        kind: "thrown",
        error: {
          message: typeof obj.message === "string" ? obj.message : String(obj.message ?? "unknown error"),
          stack: typeof obj.stack === "string" ? obj.stack : obj.stack == null ? null : String(obj.stack),
          line: typeof obj.line === "number" && Number.isFinite(obj.line) ? obj.line : null,
        },
      };
    }
  }
  return { kind: "value", value: raw };
}

function toEvalThrown(err: unknown): EvalThrown {
  const e = err instanceof Error ? err : new Error(String(err));
  let line: number | null = null;
  const stack = e.stack || null;
  if (stack) {
    const m = /(?:<anonymous>|anonymous code):(\d+):\d+/.exec(stack);
    if (m) {
      const raw = Number(m[1]);
      if (Number.isFinite(raw)) line = Math.max(1, raw - 1);
    }
  }
  return { message: e.message, stack, line };
}

/**
 * Decide expression vs statements in MAIN with a parse-only `new Function`
 * probe. Only SyntaxError falls through to the statement form — any other
 * throw (should not happen in Node) is invalid, not a silent fallback.
 * Node's Function constructor is not subject to the page's CSP.
 */
export function chooseEvalScriptForm(script: string): EvalFormChoice {
  try {
    // Parse only — the function is never invoked.
    // Newlines around the script so a trailing line comment cannot swallow `);`.
    new Function(`return (async () => {\nreturn (\n${script}\n);\n})()`);
    return { form: "expression" };
  } catch (e1) {
    if (!(e1 instanceof SyntaxError)) {
      return { form: "invalid", error: toEvalThrown(e1) };
    }
  }
  try {
    new Function(`return (async () => {\n${script}\n})()`);
    return { form: "statements" };
  } catch (e2) {
    return { form: "invalid", error: toEvalThrown(e2) };
  }
}

/**
 * Body that runs INSIDE the page: MAIN already chose expression vs statements;
 * the chosen body is spliced in as a literal (string concat, not a template
 * that would re-interpolate `${…}` in the caller's script). No `eval` /
 * `new Function` on the page — CSP without `unsafe-eval` stays happy.
 *
 * Thenables are awaited by `.then`, NOT by Promise identity — that survives
 * Zone.js and any polyfill that replaces the global Promise.
 *
 * Throws are caught in-page and returned as a structured envelope so the
 * agent sees message/stack/line instead of Electron's opaque
 * "Script failed to execute…".
 */
export function awaitExpressionSource(script: string): string {
  const choice = chooseEvalScriptForm(script);
  if (choice.form === "invalid") {
    return (
      `(async () => (` +
      JSON.stringify({
        [EVAL_ERR_KEY]: true,
        message: choice.error.message,
        stack: choice.error.stack,
        line: choice.error.line,
      }) +
      `))()`
    );
  }

  // Expression: return (\nexpr\n); — newlines so a trailing `//` comment cannot
  // swallow the closing `);` (which would SyntaxError into statements and yield undefined).
  // Statements: caller body as-is (may use return/await).
  const userBody = choice.form === "expression" ? `return (\n${script}\n);` : script;

  // Build with join so user `${…}` / backticks are never re-interpolated by a template.
  const beforeUser = [
    `(async () => {`,
    `  const __stellar_ok = ${JSON.stringify(EVAL_OK_KEY)};`,
    `  const __stellar_err = ${JSON.stringify(EVAL_ERR_KEY)};`,
    `  const __stellar_line_offset = __LINE_OFFSET_PLACEHOLDER__;`,
    `  function __stellar_line(err) {`,
    `    const stack = err && err.stack ? String(err.stack) : "";`,
    `    const m = /(?:<anonymous>|anonymous code):(\\d+):\\d+/.exec(stack);`,
    `    if (!m) return null;`,
    `    const raw = Number(m[1]);`,
    `    if (!Number.isFinite(raw)) return null;`,
    `    return Math.max(1, raw - __stellar_line_offset);`,
    `  }`,
    `  function __stellar_pack_err(err) {`,
    `    const e = err instanceof Error ? err : new Error(String(err));`,
    `    return {`,
    `      [__stellar_err]: true,`,
    `      message: e.message,`,
    `      stack: e.stack || String(e),`,
    `      line: __stellar_line(e),`,
    `    };`,
    `  }`,
    `  try {`,
    `    let valor = await (async () => {`,
  ].join("\n");

  const afterUser = [
    `    })();`,
    `    if (valor && typeof valor.then === "function") valor = await valor;`,
    `    return { [__stellar_ok]: true, value: valor };`,
    `  } catch (__err) {`,
    `    return __stellar_pack_err(__err);`,
    `  }`,
    `})()`,
  ].join("\n");

  // Lines before the first line of the caller's script. Expression form inserts
  // an extra `return (` line ahead of the script; statements start at userBody.
  const lineOffset = beforeUser.split("\n").length + (choice.form === "expression" ? 1 : 0);
  const header = beforeUser.replace("__LINE_OFFSET_PLACEHOLDER__", String(lineOffset));
  return header + "\n" + userBody + "\n" + afterUser;
}

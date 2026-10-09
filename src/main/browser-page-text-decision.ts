/**
 * `get_page_text` scope — pure decision.
 *
 * Without a scope, list-heavy pages dump thousands of tokens (Programathor).
 * Without a dialog default, reading a modal pulled the page behind it
 * (IdyPlatform feedback). This module picks body vs selector vs auto-dialog.
 */

/** Default cap: preserved for callers that omit maxChars. */
export const DEFAULT_MAX_PAGE_TEXT_CHARS = 20_000;
/** Floor: below this a read is useless (and maxChars:0 would return ""). */
export const MIN_MAX_PAGE_TEXT_CHARS = 200;
/** Hard ceiling — maxChars is a request, not a blank cheque. */
export const MAX_MAX_PAGE_TEXT_CHARS = 200_000;

/** Default open-dialog probe used when the caller omits selector/ref/scope. */
export const DEFAULT_DIALOG_SCOPE_SELECTOR =
  'dialog[open], [role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"])';

export type PageTextScope =
  | { scope: "selector"; selector: string; source: "selector" | "scope" | "ref" | "dialog" }
  | { scope: "body" };

export type PageTextRequestDecision = {
  scope: PageTextScope;
  /** Effective cap, already clamped. */
  cap: number;
  requestedCap: number | null;
  clamped: "below-min" | "above-max" | null;
};

/**
 * Resolve which node to read.
 * Precedence: ref → selector → scope → open dialog (when present) → body.
 * `dialogPresent` is measured by the registry before calling this when the
 * caller gave no explicit target; pass false to skip the dialog default.
 */
export function decidePageTextRequest(input: {
  selector?: string | null;
  scope?: string | null;
  ref?: string | null;
  maxChars?: number | null;
  /** True when an open dialog exists and should become the default scope. */
  dialogPresent?: boolean;
}): PageTextRequestDecision {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  const selector = typeof input.selector === "string" ? input.selector.trim() : "";
  const scopeParam = typeof input.scope === "string" ? input.scope.trim() : "";

  let scope: PageTextScope;
  if (ref.length > 0) {
    scope = { scope: "selector", selector: `[data-stellar-ref="${cssAttrEscape(ref)}"]`, source: "ref" };
  } else if (selector.length > 0) {
    scope = { scope: "selector", selector, source: "selector" };
  } else if (scopeParam.length > 0) {
    scope = { scope: "selector", selector: scopeParam, source: "scope" };
  } else if (input.dialogPresent === true) {
    scope = { scope: "selector", selector: DEFAULT_DIALOG_SCOPE_SELECTOR, source: "dialog" };
  } else {
    scope = { scope: "body" };
  }

  const requested =
    typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0
      ? Math.floor(input.maxChars)
      : null;
  if (requested === null) return { scope, cap: DEFAULT_MAX_PAGE_TEXT_CHARS, requestedCap: null, clamped: null };
  if (requested < MIN_MAX_PAGE_TEXT_CHARS) {
    return { scope, cap: MIN_MAX_PAGE_TEXT_CHARS, requestedCap: requested, clamped: "below-min" };
  }
  if (requested > MAX_MAX_PAGE_TEXT_CHARS) {
    return { scope, cap: MAX_MAX_PAGE_TEXT_CHARS, requestedCap: requested, clamped: "above-max" };
  }
  return { scope, cap: requested, requestedCap: requested, clamped: null };
}

function cssAttrEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Truncation phrase — null when nothing was cut. Always names the cap and
 * the real total so a cut is never silent.
 */
export function describePageTextTruncation(input: {
  truncated: boolean;
  totalChars: number;
  cap: number;
}): string | null {
  if (!input.truncated) return null;
  return (
    `page text truncated: showing the first ${input.cap} of ${input.totalChars} characters ` +
    `(the rest exists and was NOT read — narrow the scope with \`selector\`/\`scope\`/\`ref\`, or raise \`maxChars\`, instead of assuming the text ends here)`
  );
}

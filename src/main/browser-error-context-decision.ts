/**
 * Diagnostics attached when browser_wait_for / browser_navigate time out.
 *
 * Measured gap: a 20s wait_for said nothing about what was on screen; the
 * agent had to spend another tool call to learn the page state. Same for
 * navigate that reported route success on a SPA 404. This module shapes the
 * facts the registry already has (url, visible text, console ring, failed
 * network) into a bounded payload — pure, no I/O.
 */

/** Visible-text budget on a timeout — enough to see a heading/toast, not a dump. */
export const ERROR_CONTEXT_TEXT_MAX_CHARS = 1_200;
/** Last N console lines (most recent). */
export const ERROR_CONTEXT_CONSOLE_LIMIT = 8;
/** Last N failed network entries. */
export const ERROR_CONTEXT_FAILED_NETWORK_LIMIT = 8;

export type ErrorContextConsoleFact = { level: string; message: string };
export type ErrorContextNetworkFact = {
  method: string;
  url: string;
  status: number | null;
  error?: string;
};

export type BrowserErrorContext = {
  url: string;
  title: string;
  visibleText: string;
  visibleTextTruncated: boolean;
  console: ErrorContextConsoleFact[];
  failedRequests: ErrorContextNetworkFact[];
};

/** Collapse whitespace and cut at the budget — never silent about the cut. */
export function summarizeVisibleText(raw: string, maxChars = ERROR_CONTEXT_TEXT_MAX_CHARS): {
  text: string;
  truncated: boolean;
} {
  const collapsed = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return { text: collapsed, truncated: false };
  return { text: collapsed.slice(0, maxChars), truncated: true };
}

export function pickConsoleTail(
  messages: ErrorContextConsoleFact[],
  limit = ERROR_CONTEXT_CONSOLE_LIMIT,
): ErrorContextConsoleFact[] {
  return messages.slice(-limit).map((m) => ({
    level: m.level,
    message: m.message.length > 400 ? `${m.message.slice(0, 400)}…` : m.message,
  }));
}

export function pickFailedRequests(
  network: ErrorContextNetworkFact[],
  limit = ERROR_CONTEXT_FAILED_NETWORK_LIMIT,
): ErrorContextNetworkFact[] {
  const failed = network.filter((r) => r.error !== undefined || r.status === null || (r.status !== null && r.status >= 400));
  return failed.slice(-limit).map((r) => ({
    method: r.method,
    url: r.url.length > 200 ? `${r.url.slice(0, 200)}…` : r.url,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
  }));
}

/** Assemble the timeout/diagnostic payload from already-collected facts. */
export function buildErrorContext(input: {
  url: string;
  title: string;
  visibleTextRaw: string;
  console: ErrorContextConsoleFact[];
  network: ErrorContextNetworkFact[];
}): BrowserErrorContext {
  const summary = summarizeVisibleText(input.visibleTextRaw);
  return {
    url: input.url,
    title: input.title,
    visibleText: summary.text,
    visibleTextTruncated: summary.truncated,
    console: pickConsoleTail(input.console),
    failedRequests: pickFailedRequests(input.network),
  };
}

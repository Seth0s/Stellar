/** Pure display decisions for the shared card footer. Missing measurements
 * stay absent; this module does not infer values from a card's kind. */

export type TerminalFooterInput = {
  lastActivityAt: number | null;
  context: { usedTokens: number; windowTokens?: number } | null;
  quota: { text: string; percent?: number } | null;
};

export function decideTerminalFooter(input: TerminalFooterInput, now: number) {
  const activitySeconds = input.lastActivityAt == null
    ? null
    : Math.max(0, Math.floor((now - input.lastActivityAt) / 1000));
  const contextPercent = input.context?.windowTokens && input.context.windowTokens > 0
    ? Math.round((input.context.usedTokens / input.context.windowTokens) * 100)
    : null;
  const quotaLabel = input.quota == null
    ? null
    : input.quota.percent == null
      ? input.quota.text
      : `cota ${input.quota.percent}%`;
  return { activitySeconds, contextPercent, quotaLabel };
}

export type BrowserFooterInput = {
  httpStatusCode: number | null;
  viewport: { width: number; height: number };
  zoom: number;
  consoleErrors: number;
  consoleWarnings: number;
  visible: boolean;
};

export function decideBrowserFooter(input: BrowserFooterInput) {
  const statusTone = input.httpStatusCode == null
    ? null
    : input.httpStatusCode >= 400
      ? "danger"
      : input.httpStatusCode >= 300
        ? "warn"
        : "good";
  const consoleLabel = input.consoleWarnings > 0
    ? `console ${input.consoleErrors} erros · ${input.consoleWarnings} avisos`
    : `console ${input.consoleErrors} erros`;
  return {
    statusTone,
    viewportLabel: `${input.viewport.width} × ${input.viewport.height} · zoom ${Math.round(input.zoom * 100)}%`,
    consoleLabel,
    paused: !input.visible,
  };
}

export function decideFilesFooter(input: {
  repo: boolean;
  branch: string;
  changedEntries: number;
  folderCardCount: number;
}) {
  return {
    branch: input.repo ? input.branch : null,
    changedCount: input.repo ? input.changedEntries : null,
    folderCardCount: input.folderCardCount > 0 ? input.folderCardCount : null,
  };
}

export function decideChangesFooter(input: {
  repo: boolean;
  branch: string;
  insertions: number;
  deletions: number;
  changedFiles: number;
}) {
  return {
    branch: input.repo ? input.branch : null,
    insertions: input.repo ? input.insertions : null,
    deletions: input.repo ? input.deletions : null,
    changedFiles: input.repo ? input.changedFiles : null,
    uncommitted: input.repo && input.changedFiles > 0,
  };
}

export function decideStickyFooter(updatedAt: number | null | undefined, now: number): string | null {
  if (updatedAt == null) return null;
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "editada há menos de 1 min";
  if (minutes < 60) return `editada há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `editada há ${hours} h`;
  return `editada há ${Math.floor(hours / 24)} d`;
}

export function decideChatFooter(input: {
  streaming: boolean;
  elapsedMs: number;
  lastTurn: { durationMs: number; inputTokens: number; outputTokens: number } | null;
}) {
  if (input.streaming) return { durationMs: input.elapsedMs, inputTokens: null, outputTokens: null };
  return input.lastTurn
    ? {
        durationMs: input.lastTurn.durationMs,
        inputTokens: input.lastTurn.inputTokens,
        outputTokens: input.lastTurn.outputTokens,
      }
    : { durationMs: null, inputTokens: null, outputTokens: null };
}

export function decideMediaFooter(input: {
  kind: "image" | "pdf";
  imageSize: { width: number; height: number } | null;
  zoom: number;
  page: number;
  pageCount: number;
}) {
  return input.kind === "pdf"
    ? { imageDimensions: null, zoomPercent: null, pageLabel: input.pageCount > 0 ? `${input.page}/${input.pageCount}` : null }
    : {
        imageDimensions: input.imageSize ? `${input.imageSize.width} × ${input.imageSize.height}` : null,
        zoomPercent: Math.round(input.zoom * 100),
        pageLabel: null,
      };
}

export type TaskFooterItem = {
  phase: string;
  cardAlive: boolean;
  blockedQuestion: unknown | null;
  requestedStatus: unknown | null;
  review: string | null;
  cards: Array<{ role: string }>;
  updatedAt: number;
};

export function decideTaskFooter(tasks: TaskFooterItem[], now: number) {
  const working = tasks.filter((task) => task.phase === "running" && task.cardAlive).length;
  const review = tasks.filter((task) => task.phase === "awaiting_review" || task.phase === "changes_requested").length;
  const needsHuman = tasks.filter((task) =>
    task.blockedQuestion !== null || task.requestedStatus !== null ||
    (task.phase === "awaiting_review" && task.review === "wanted" && !task.cards.some((card) => card.role === "reviewer")),
  ).length;
  const latest = tasks.reduce<number | null>((at, task) => at === null || task.updatedAt > at ? task.updatedAt : at, null);
  return {
    working,
    review,
    needsHuman,
    latestAge: latest === null ? null : formatPulseAge(latest, now),
  };
}

function formatPulseAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}

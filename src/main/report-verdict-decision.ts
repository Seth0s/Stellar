/**
 * DESIGN-BACKLOG.md §2.1 decisão 9 — `verdict` is a first-class field on
 * the `report` request (`req.verdict` → `reports.verdict`), not a key
 * inside the free-form payload. MCP already sends it that way. acbridge
 * `report <json>` has one argument, so a CLI caller who writes
 * `{ "verdict": "aprovado" }` is naming the typed field the only way
 * the CLI can. This lift is that mapping: take the formal value off the
 * payload (so it is not stored twice) and put it on the request.
 *
 * Only `"aprovado"` / `"reprovado"` promote. Any other `verdict` in the
 * JSON (`"ship"`, `null`, a number) stays in the payload — it is not
 * the typed column, and stealing it would change reports that already
 * use the key as free prose (fillReportTaskId tests lock `"ship"`).
 *
 * An explicit `req.verdict` wins over an embedded one. The embedded
 * formal value is still stripped so the two channels cannot disagree
 * in `report_json`.
 */

export type FormalVerdict = "aprovado" | "reprovado";

export function isFormalVerdict(value: unknown): value is FormalVerdict {
  return value === "aprovado" || value === "reprovado";
}

export function promoteReportVerdict(
  report: unknown,
  explicit?: unknown,
): { report: unknown; verdict: FormalVerdict | undefined } {
  const fromExplicit = isFormalVerdict(explicit) ? explicit : undefined;
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { report, verdict: fromExplicit };
  }

  const embedded = Object.prototype.hasOwnProperty.call(report, "verdict")
    ? (report as { verdict: unknown }).verdict
    : undefined;
  const fromPayload = isFormalVerdict(embedded) ? embedded : undefined;
  const verdict = fromExplicit ?? fromPayload;

  if (fromPayload === undefined) return { report, verdict };

  const rest = { ...(report as Record<string, unknown>) };
  delete rest.verdict;
  return { report: rest, verdict };
}

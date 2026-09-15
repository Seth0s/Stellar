import { describe, it, expect } from "vitest";
import {
  decideReportAcceptance,
  describeRetryableFailureRefusal,
  describeStructuralReportError,
  decodeReportArgument,
  describeNonObjectReportError,
  describeMissingReportField,
  errorFromReportPayload,
  stashLastRefusedReport,
  lastRefusedReasonFromResultJson,
  clearLastRefusedStash,
  describeExitWithoutAcceptedReport,
  LAST_REFUSED_REPORT_KEY,
} from "../../src/main/report-retry-decision";
import { failureKindFromResultJson } from "../../src/main/failure-kind-decision";

const running = { status: "running", retry_count: 0, max_retries: 2 };

describe("decideReportAcceptance — structural", () => {
  it("names requesterId when the caller id is missing", () => {
    const d = decideReportAcceptance({ requesterId: "", report: { ok: true }, linkedTask: running, defaultMaxRetries: 2 });
    expect(d).toEqual({
      action: "structural",
      field: "requesterId",
      error: describeStructuralReportError("requesterId"),
    });
    expect(d.action === "structural" && d.error).toContain("requesterId");
  });

  it("names report when the payload is missing", () => {
    const d = decideReportAcceptance({
      requesterId: "card-1",
      report: undefined,
      linkedTask: running,
      defaultMaxRetries: 2,
    });
    expect(d).toEqual({ action: "structural", field: "report", error: "missing report" });
  });

  it("names ok / retryable when the type is wrong", () => {
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: "false" },
        linkedTask: running,
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "structural", field: "ok", error: "report.ok must be a boolean" });
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: false, retryable: "no" },
        linkedTask: running,
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "structural", field: "retryable", error: "report.retryable must be a boolean" });
  });
});

describe("JSON-encoded report envelope (the 2026-09-15 MCP bug)", () => {
  it("decodeReportArgument decodes only a JSON object string", () => {
    expect(decodeReportArgument('{"ok":true}')).toEqual({ ok: true });
    expect(decodeReportArgument('  {"ok": true, "files": []}  ')).toEqual({ ok: true, files: [] });
    // Anything that is not a JSON object stays exactly as it was.
    expect(decodeReportArgument('plain string')).toBe("plain string");
    expect(decodeReportArgument('{"ok":true')).toBe('{"ok":true'); // malformed
    expect(decodeReportArgument('["ok",true]')).toBe('["ok",true]'); // array
    expect(decodeReportArgument("42")).toBe("42");
    const obj = { ok: true };
    expect(decodeReportArgument(obj)).toBe(obj); // non-string is untouched, identity
  });

  it("accepts a JSON-string {ok:true} against a reportSchema instead of lying about ok", () => {
    const linked = { ...running, reportSchema: ["ok", "files"] };
    // Before the fix this returned field "ok" / "report.ok must be a boolean".
    expect(
      decideReportAcceptance({ requesterId: "c", report: '{"ok":true}', linkedTask: linked, defaultMaxRetries: 2 }),
    ).toEqual({ action: "structural", field: "files", error: describeMissingReportField("files") });
    expect(
      decideReportAcceptance({ requesterId: "c", report: '{"ok":true}', linkedTask: { ...running, reportSchema: ["ok"] }, defaultMaxRetries: 2 }),
    ).toEqual({ action: "accept" });
  });

  it("a genuinely non-object payload names the envelope, never a key it contains", () => {
    const linked = { ...running, reportSchema: ["ok", "files"] };
    const d = decideReportAcceptance({ requesterId: "c", report: "done!", linkedTask: linked, defaultMaxRetries: 2 });
    expect(d).toEqual({ action: "structural", field: "report", error: describeNonObjectReportError("done!", ["ok", "files"]) });
    expect(d.action === "structural" && d.error).toContain("received a string");
    expect(d.action === "structural" && d.error).toContain("Required keys: ok, files");
    expect(d.action === "structural" && d.error).not.toContain("report.ok must be a boolean");

    expect(
      describeNonObjectReportError([1, 2], ["ok"]),
    ).toContain("received an array");
  });

  it("still names ok for a real object whose ok is not a boolean", () => {
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: "true" },
        linkedTask: { ...running, reportSchema: ["ok", "files"] },
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "structural", field: "ok", error: "report.ok must be a boolean" });
  });

  it("says ok is MISSING when the object simply omits it (not 'must be a boolean')", () => {
    // Live repro 2026-09-15: a payload {files, evidence} against a schema
    // starting with "ok" was answered "report.ok must be a boolean" — the
    // same lie, from the schema-missing path sharing the type message.
    const d = decideReportAcceptance({
      requesterId: "c",
      report: { files: [], evidence: "x" },
      linkedTask: { ...running, reportSchema: ["ok", "files", "evidence"] },
      defaultMaxRetries: 2,
    });
    expect(d).toEqual({ action: "structural", field: "ok", error: describeMissingReportField("ok") });
    expect(d.action === "structural" && d.error).toContain("missing ok");
    expect(d.action === "structural" && d.error).not.toContain("must be a boolean");
  });
});

describe("decideReportAcceptance — declared failure", () => {
  it("refuses a retryable failure while budget remains and states the acceptance rule", () => {
    const d = decideReportAcceptance({
      requesterId: "c",
      report: { ok: false, error: "tests failed" },
      linkedTask: running,
      defaultMaxRetries: 2,
    });
    expect(d.action).toBe("refuse_retryable");
    if (d.action !== "refuse_retryable") return;
    expect(d.retryCount).toBe(1);
    expect(d.retriesRemaining).toBe(1);
    expect(d.error).toBe(describeRetryableFailureRefusal(1));
    expect(d.error).toContain("ok: true");
    expect(d.error).toContain("retryable: false");
    expect(d.error).toContain("Attempts remaining: 1");
    expect(d.error.toLowerCase()).not.toContain("fix");
    expect(d.error.toLowerCase()).not.toContain("corrija");
  });

  it("accepts a declared failure when the budget is exhausted", () => {
    const d = decideReportAcceptance({
      requesterId: "c",
      report: { ok: false },
      linkedTask: { status: "running", retry_count: 2, max_retries: 2 },
      defaultMaxRetries: 2,
    });
    expect(d).toEqual({ action: "accept_failure", terminal: false });
  });

  it("accepts a terminal failure on the first call without spending a retry", () => {
    const d = decideReportAcceptance({
      requesterId: "c",
      report: { ok: false, retryable: false, error: "no credits" },
      linkedTask: running,
      defaultMaxRetries: 2,
    });
    expect(d).toEqual({ action: "accept_failure", terminal: true });
  });

  it("does not refuse when there is no running linked task", () => {
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: false },
        linkedTask: undefined,
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "accept_failure", terminal: false });
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: false },
        linkedTask: { status: "done", retry_count: 0, max_retries: 2 },
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "accept_failure", terminal: false });
  });

  it("accepts success and reports that are not a declared failure", () => {
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: true, result: "done" },
        linkedTask: running,
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "accept" });
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { hypothesisConfirmed: false },
        linkedTask: running,
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "accept" });
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: "plain string",
        linkedTask: running,
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "accept" });
  });

  it("names a missing reportSchema field on a non-failure report", () => {
    const linked = { ...running, reportSchema: ["separation", "files"] };
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: true, separation: "x" },
        linkedTask: linked,
        defaultMaxRetries: 2,
      }),
    ).toEqual({
      action: "structural",
      field: "files",
      error: describeMissingReportField("files"),
    });
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: true, separation: "x", files: [] },
        linkedTask: linked,
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "accept" });
  });

  it("does not enforce reportSchema on a declared failure", () => {
    expect(
      decideReportAcceptance({
        requesterId: "c",
        report: { ok: false, retryable: false, error: "blocked" },
        linkedTask: { ...running, reportSchema: ["separation"] },
        defaultMaxRetries: 2,
      }),
    ).toEqual({ action: "accept_failure", terminal: true });
  });
});

describe("errorFromReportPayload", () => {
  it("reads a string error or falls back", () => {
    expect(errorFromReportPayload({ ok: false, error: "no credits" })).toBe("no credits");
    expect(errorFromReportPayload({ ok: false })).toBe("agent reported a failure");
  });
});

describe("last-refused stash — not a status", () => {
  it("stores the payload without writing failureKind", () => {
    const json = stashLastRefusedReport(null, { ok: false, error: "não consegui X porque Y" });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed[LAST_REFUSED_REPORT_KEY]).toEqual({ ok: false, error: "não consegui X porque Y" });
    expect(parsed.failureKind).toBeUndefined();
    expect(failureKindFromResultJson(json)).toBeNull();
    expect(lastRefusedReasonFromResultJson(json)).toBe("não consegui X porque Y");
  });

  it("clear drops the stash and keeps sibling keys", () => {
    const json = stashLastRefusedReport(JSON.stringify({ note: "keep" }), { ok: false, error: "old" });
    expect(JSON.parse(clearLastRefusedStash(json)!)).toEqual({ note: "keep" });
    expect(clearLastRefusedStash(stashLastRefusedReport(null, { ok: false }))).toBeNull();
  });
});

describe("describeExitWithoutAcceptedReport", () => {
  it("keeps the old sentence when there is no stash", () => {
    expect(describeExitWithoutAcceptedReport(1, null)).toBe("process exited (code 1) without ever calling report");
  });

  it("names both the exit and the last refused reason when there is a stash", () => {
    expect(describeExitWithoutAcceptedReport(129, "não consegui X porque Y")).toBe(
      "process exited (code 129) after a refused report; last declared failure: não consegui X porque Y",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  derivePrototypeAsk,
  prototypeApprovalFromResultJson,
  safePrototypePath,
  stampPrototypeApprovalJson,
} from "../../src/main/prototype-ask-decision";

/**
 * The Fila's prototype-to-approve card is driven by an explicit report, not
 * by review=wanted. The three cards the owner saw were tasks that only lacked a
 * reviewer; none of them declared a prototype, so none of them may show up here.
 */

const TASK = "a550a7ae-aaaa-4000-8000-000000000015";
const OTHER = "d73e9001-aaaa-4000-8000-000000000002";

const ask = (at: number, over: Record<string, unknown> = {}) => ({
  at,
  body: {
    estado: "parcial",
    taskId: TASK,
    prototype: { path: "fila.dc.html", approval: "requested" },
    ...over,
  },
});

describe("derivePrototypeAsk", () => {
  it("a parcial report that names the file and asks for approval is an ask", () => {
    expect(
      derivePrototypeAsk({ taskId: TASK, phase: "running", reports: [ask(100)], approval: null }),
    ).toEqual({
      path: "fila.dc.html",
      askedAt: 100,
    });
  });

  it("estado omitted counts as parcial (the repo convention)", () => {
    const row = ask(100);
    delete (row.body as Record<string, unknown>).estado;
    expect(
      derivePrototypeAsk({ taskId: TASK, phase: "running", reports: [row], approval: null })
        ?.askedAt,
    ).toBe(100);
  });

  it("a task that only needs a reviewer is NOT an ask, whatever its review flag", () => {
    // No report declares a prototype: nothing to approve.
    expect(
      derivePrototypeAsk({ taskId: TASK, phase: "ready", reports: [], approval: null }),
    ).toBeNull();
    expect(
      derivePrototypeAsk({
        taskId: TASK,
        phase: "awaiting_review",
        reports: [{ at: 5, body: { estado: "parcial", taskId: TASK, decisaoTomada: "x" } }],
        approval: null,
      }),
    ).toBeNull();
  });

  it("only reports that declare THIS task count", () => {
    expect(
      derivePrototypeAsk({ taskId: OTHER, phase: "running", reports: [ask(100)], approval: null }),
    ).toBeNull();
    const noTask = ask(100);
    delete (noTask.body as Record<string, unknown>).taskId;
    expect(
      derivePrototypeAsk({ taskId: TASK, phase: "running", reports: [noTask], approval: null }),
    ).toBeNull();
  });

  it("the newest declaration decides: a later report that no longer asks clears it", () => {
    const withdrawn = ask(200, { prototype: { path: "fila.dc.html", approval: "approved" } });
    expect(
      derivePrototypeAsk({
        taskId: TASK,
        phase: "running",
        reports: [ask(100), withdrawn],
        approval: null,
      }),
    ).toBeNull();
  });

  it("a newer ask replaces the older one (askedAt moves, so a dismissal does not stick to it)", () => {
    const next = ask(300, { prototype: { path: "fila-v2.dc.html", approval: "requested" } });
    expect(
      derivePrototypeAsk({
        taskId: TASK,
        phase: "running",
        reports: [ask(100), next],
        approval: null,
      }),
    ).toEqual({
      path: "fila-v2.dc.html",
      askedAt: 300,
    });
  });

  it("a final report is never an ask, and a later concluding report ends it", () => {
    expect(
      derivePrototypeAsk({
        taskId: TASK,
        phase: "running",
        reports: [ask(100, { estado: "final", ok: true })],
        approval: null,
      }),
    ).toBeNull();
    const concluded = { at: 200, body: { estado: "final", ok: true, taskId: TASK } };
    expect(
      derivePrototypeAsk({
        taskId: TASK,
        phase: "running",
        reports: [ask(100), concluded],
        approval: null,
      }),
    ).toBeNull();
  });

  it("a task that already ended has no ask", () => {
    for (const phase of ["done", "failed", "superseded"]) {
      expect(
        derivePrototypeAsk({ taskId: TASK, phase, reports: [ask(100)], approval: null }),
      ).toBeNull();
    }
  });

  it("the owner's approval answers exactly that ask, not a newer one", () => {
    const approval = { path: "fila.dc.html", askedAt: 100, approvedAt: 150 };
    expect(
      derivePrototypeAsk({ taskId: TASK, phase: "running", reports: [ask(100)], approval }),
    ).toBeNull();
    const next = ask(300);
    expect(
      derivePrototypeAsk({ taskId: TASK, phase: "running", reports: [ask(100), next], approval })
        ?.askedAt,
    ).toBe(300);
  });

  it("an unusable path is not an ask", () => {
    for (const path of [
      "",
      "../x.html",
      "/etc/x.html",
      "a/../../x.html",
      "x.txt",
      "http://x/y.html",
      "a\\b.html",
    ]) {
      const row = ask(100, { prototype: { path, approval: "requested" } });
      expect(
        derivePrototypeAsk({ taskId: TASK, phase: "running", reports: [row], approval: null }),
      ).toBeNull();
    }
  });
});

describe("safePrototypePath", () => {
  it("accepts a relative html file and drops a leading prototypes/", () => {
    expect(safePrototypePath("fila.dc.html")).toBe("fila.dc.html");
    expect(safePrototypePath("  sub/dir/fila.html ")).toBe("sub/dir/fila.html");
    expect(safePrototypePath("prototypes/fila.dc.html")).toBe("fila.dc.html");
  });
  it("refuses everything that could leave the prototypes directory", () => {
    for (const bad of [
      undefined,
      null,
      3,
      "",
      "~/x.html",
      "./x.html",
      "a//b.html",
      "a/\u0000b.html",
      "x".repeat(300) + ".html",
    ]) {
      expect(safePrototypePath(bad as unknown)).toBeNull();
    }
  });
});

describe("the stored approval", () => {
  it("round-trips through result_json and keeps the other keys", () => {
    const json = stampPrototypeApprovalJson(JSON.stringify({ gateRun: { ok: true } }), {
      path: "fila.dc.html",
      askedAt: 100,
      approvedAt: 150,
    });
    expect(JSON.parse(json).gateRun).toEqual({ ok: true });
    expect(prototypeApprovalFromResultJson(json)).toEqual({
      path: "fila.dc.html",
      askedAt: 100,
      approvedAt: 150,
    });
  });
  it("is null when absent or malformed", () => {
    expect(prototypeApprovalFromResultJson(null)).toBeNull();
    expect(prototypeApprovalFromResultJson("{}")).toBeNull();
    expect(
      prototypeApprovalFromResultJson(
        '{"prototypeApproval":{"path":"../x.html","askedAt":1,"approvedAt":2}}',
      ),
    ).toBeNull();
    expect(prototypeApprovalFromResultJson('{"prototypeApproval":"x"}')).toBeNull();
  });
});

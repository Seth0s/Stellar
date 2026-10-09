import { describe, it, expect } from "vitest";
import {
  decideReportTaskLink,
  declaredTaskIdFromReportBody,
} from "../../src/main/report-task-link-decision";

/**
 * Attribution of a `report` to a task.
 *
 * Declared taskId/`task` wins when the card has OR HAD a link to that task.
 * Live-only matching is the bug: after the live link moved, a report naming
 * the previous task was stamped under the new one.
 */

describe("declaredTaskIdFromReportBody — taskId and task", () => {
  it("reads taskId", () => {
    expect(declaredTaskIdFromReportBody({ ok: true, taskId: "aaa" })).toBe("aaa");
  });

  it("reads task as an alias when taskId is absent", () => {
    expect(declaredTaskIdFromReportBody({ ok: true, task: "bbb-full-id" })).toBe("bbb-full-id");
  });

  it("when task and taskId conflict, prefers task (agent field; taskId may be a wrong server stamp)", () => {
    expect(
      declaredTaskIdFromReportBody({
        ok: true,
        task: "49de95ce-declared",
        taskId: "ba297d23-wrong-stamp",
      }),
    ).toBe("49de95ce-declared");
  });

  it("ignores empty / non-string", () => {
    expect(declaredTaskIdFromReportBody({ taskId: "  " })).toBeUndefined();
    expect(declaredTaskIdFromReportBody({ task: 12 })).toBeUndefined();
    expect(declaredTaskIdFromReportBody("x")).toBeUndefined();
  });
});

describe("decideReportTaskLink — has or had a link", () => {
  it("declared A with live B and history A → resolve A (the required red case on HEAD)", () => {
    const link = decideReportTaskLink({
      declaredTaskId: "task-A",
      principalTaskIds: [],
      linkTaskIds: ["task-B"],
      historyLinkTaskIds: ["task-A", "task-B"],
    });
    expect(link).toEqual({ action: "resolve", taskId: "task-A", source: "declared" });
  });

  it("declared A with live B and NO history of A → refuse, naming candidates", () => {
    const link = decideReportTaskLink({
      declaredTaskId: "task-A",
      principalTaskIds: [],
      linkTaskIds: ["task-B"],
      historyLinkTaskIds: ["task-B"],
    });
    expect(link.action).toBe("declared-not-linked");
    if (link.action !== "declared-not-linked") return;
    expect(link.declared).toBe("task-A");
    expect(link.candidates).toContain("task-B");
    expect(link.candidates).not.toContain("task-A");
  });

  it("undeclared keeps live-only behavior (history must not resolve or widen)", () => {
    const sole = decideReportTaskLink({
      principalTaskIds: [],
      linkTaskIds: ["task-B"],
      historyLinkTaskIds: ["task-A", "task-B"],
    });
    expect(sole).toEqual({ action: "resolve", taskId: "task-B", source: "link" });

    const ambiguous = decideReportTaskLink({
      principalTaskIds: [],
      linkTaskIds: ["task-B", "task-C"],
      historyLinkTaskIds: ["task-A", "task-B", "task-C"],
    });
    expect(ambiguous.action).toBe("ambiguous");
    if (ambiguous.action !== "ambiguous") return;
    expect(ambiguous.candidates).toEqual(["task-B", "task-C"]);
  });
});

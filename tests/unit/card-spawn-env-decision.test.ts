import { describe, it, expect } from "vitest";
import {
  decideCardIdentityEnv,
  fillReportTaskId,
  resolveDeclaredTaskId,
} from "../../src/main/card-spawn-env-decision";

describe("resolveDeclaredTaskId", () => {
  it("explicit wins over primary and links", () => {
    expect(
      resolveDeclaredTaskId({
        explicit: "  spawn-task  ",
        primaryTaskIds: ["primary"],
        linkTaskIds: ["link"],
      }),
    ).toBe("spawn-task");
  });

  it("empty / whitespace explicit is absent — does not invent", () => {
    expect(resolveDeclaredTaskId({ explicit: "" })).toBeUndefined();
    expect(resolveDeclaredTaskId({ explicit: "   " })).toBeUndefined();
    expect(resolveDeclaredTaskId({ explicit: null })).toBeUndefined();
    expect(resolveDeclaredTaskId({})).toBeUndefined();
  });

  it("unique primary is a fact when explicit is absent", () => {
    expect(resolveDeclaredTaskId({ primaryTaskIds: ["impl-task"], linkTaskIds: ["impl-task", "review-task"] })).toBe(
      "impl-task",
    );
  });

  it("several primaries: omit, do not pick", () => {
    expect(resolveDeclaredTaskId({ primaryTaskIds: ["a", "b"] })).toBeUndefined();
  });

  it("unique link when there is no primary", () => {
    expect(resolveDeclaredTaskId({ linkTaskIds: ["only"] })).toBe("only");
  });

  it("several links and no unique primary: omit", () => {
    expect(resolveDeclaredTaskId({ linkTaskIds: ["a", "b"] })).toBeUndefined();
  });
});

describe("decideCardIdentityEnv", () => {
  it("cwd is always the card's official workspace", () => {
    expect(decideCardIdentityEnv({ cwd: "/repo" })).toEqual({ AGENT_CANVAS_CWD: "/repo" });
  });

  it("taskId only when declared — spawn without a task stays first-class", () => {
    expect(decideCardIdentityEnv({ cwd: "/repo", taskId: undefined })).toEqual({ AGENT_CANVAS_CWD: "/repo" });
    expect(decideCardIdentityEnv({ cwd: "/repo", taskId: "" })).toEqual({ AGENT_CANVAS_CWD: "/repo" });
    expect(decideCardIdentityEnv({ cwd: "/repo", taskId: "   " })).toEqual({ AGENT_CANVAS_CWD: "/repo" });
    expect(Object.prototype.hasOwnProperty.call(decideCardIdentityEnv({ cwd: "/repo" }), "AGENT_CANVAS_TASK_ID")).toBe(
      false,
    );
  });

  it("declared taskId becomes AGENT_CANVAS_TASK_ID, trimmed", () => {
    expect(decideCardIdentityEnv({ cwd: "/repo", taskId: "  d5453f98-31d8-407a-bbde-634812137732  " })).toEqual({
      AGENT_CANVAS_CWD: "/repo",
      AGENT_CANVAS_TASK_ID: "d5453f98-31d8-407a-bbde-634812137732",
    });
  });
});

describe("fillReportTaskId", () => {
  it("stamps a missing taskId onto a plain object", () => {
    expect(fillReportTaskId({ ok: true, verdict: "ship" }, "t-1")).toEqual({
      ok: true,
      verdict: "ship",
      taskId: "t-1",
    });
  });

  it("does not overwrite a caller-supplied taskId", () => {
    expect(fillReportTaskId({ ok: true, taskId: "already" }, "other")).toEqual({ ok: true, taskId: "already" });
  });

  it("does not invent when there is no declared id", () => {
    expect(fillReportTaskId({ ok: true }, undefined)).toEqual({ ok: true });
    expect(fillReportTaskId({ ok: true }, "")).toEqual({ ok: true });
  });

  it("leaves arrays and primitives untouched", () => {
    expect(fillReportTaskId(["ok"], "t-1")).toEqual(["ok"]);
    expect(fillReportTaskId("done", "t-1")).toBe("done");
    expect(fillReportTaskId(null, "t-1")).toBeNull();
  });
});

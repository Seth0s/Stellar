import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BROWSER_RUN_DEFAULT_TIMEOUT_MS,
  BROWSER_RUN_MAX_STEPS,
  BROWSER_RUN_MAX_TIMEOUT_MS,
  describeBrowserRunTimeout,
  extractAfterState,
  normalizeBrowserRun,
  normalizeBrowserRunTimeout,
  stepToBusFields,
} from "../../src/main/browser-run-decision";

describe("normalizeBrowserRunTimeout", () => {
  it("falls back to the documented default", () => {
    expect(normalizeBrowserRunTimeout(undefined)).toBe(BROWSER_RUN_DEFAULT_TIMEOUT_MS);
    expect(BROWSER_RUN_DEFAULT_TIMEOUT_MS).toBe(120_000);
  });

  it("clamps to the documented ceiling", () => {
    expect(normalizeBrowserRunTimeout(999_999)).toBe(BROWSER_RUN_MAX_TIMEOUT_MS);
  });
});

describe("normalizeBrowserRun — batch shape", () => {
  it("refuses a missing or empty steps array", () => {
    expect(normalizeBrowserRun({ steps: null }).ok).toBe(false);
    expect(normalizeBrowserRun({ steps: [] }).ok).toBe(false);
  });

  it("refuses more steps than the documented limit", () => {
    const steps = Array.from({ length: BROWSER_RUN_MAX_STEPS + 1 }, () => ({ action: "snapshot" }));
    const res = normalizeBrowserRun({ steps });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(String(BROWSER_RUN_MAX_STEPS));
  });

  it("refuses an unknown action before anything runs", () => {
    const res = normalizeBrowserRun({ steps: [{ action: "hover" }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/click\|type\|wait_for/);
  });

  it("refuses a click without a target", () => {
    const res = normalizeBrowserRun({ steps: [{ action: "click" }] });
    expect(res.ok).toBe(false);
  });

  it("accepts a mixed valid plan with stopOnError default true and finalSnapshot default false", () => {
    const res = normalizeBrowserRun({
      steps: [
        { action: "navigate", url: "/login" },
        { action: "type", text: "a@b.c", selector: "#email" },
        { action: "click", selector: "button[type=submit]" },
        { action: "wait_for", text: "Dashboard" },
        { action: "eval", js: "return document.title" },
        { action: "snapshot" },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.steps).toHaveLength(6);
    expect(res.plan.stopOnError).toBe(true);
    expect(res.plan.finalSnapshot).toBe(false);
    expect(res.plan.timeoutMs).toBe(BROWSER_RUN_DEFAULT_TIMEOUT_MS);
  });

  it("honours stopOnError:false and finalSnapshot:true", () => {
    const res = normalizeBrowserRun({
      steps: [{ action: "snapshot" }],
      stopOnError: false,
      finalSnapshot: true,
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.stopOnError).toBe(false);
    expect(res.plan.finalSnapshot).toBe(true);
    expect(res.plan.timeoutMs).toBe(5_000);
  });
});

describe("stepToBusFields — maps onto existing browser_* cmds", () => {
  it("maps each action to the matching bus cmd", () => {
    expect(stepToBusFields({ action: "click", selector: "#a" }).cmd).toBe("browser_click");
    expect(stepToBusFields({ action: "type", text: "x" }).cmd).toBe("browser_type");
    expect(stepToBusFields({ action: "wait_for", text: "hi" }).cmd).toBe("browser_wait_for");
    expect(stepToBusFields({ action: "navigate", url: "/x" }).cmd).toBe("browser_navigate");
    expect(stepToBusFields({ action: "snapshot" }).cmd).toBe("browser_snapshot");
    expect(stepToBusFields({ action: "eval", js: "1" }).cmd).toBe("browser_eval");
  });
});

describe("describeBrowserRunTimeout + extractAfterState", () => {
  it("names timeoutMs and the defaults", () => {
    const text = describeBrowserRunTimeout(12_000);
    expect(text).toContain("12000ms");
    expect(text).toContain("timeoutMs");
    expect(text).toContain(String(BROWSER_RUN_DEFAULT_TIMEOUT_MS));
  });

  it("reads url/title from a snapshot-shaped result", () => {
    expect(extractAfterState({ ok: true, url: "http://x/", title: "T" })).toEqual({
      url: "http://x/",
      title: "T",
    });
  });

  it("reads url/title from a JSON-stringified eval probe", () => {
    expect(extractAfterState({ ok: true, result: JSON.stringify({ url: "http://y/", title: "Y" }) })).toEqual({
      url: "http://y/",
      title: "Y",
    });
  });
});

describe("wiring — bus and MCP expose browser_run", () => {
  it("message-bus knows the cmd", () => {
    const bus = readFileSync(fileURLToPath(new URL("../../src/main/message-bus.ts", import.meta.url)), "utf8");
    expect(bus).toContain('cmd: "browser_run"');
    expect(bus).toContain("normalizeBrowserRun");
    expect(bus).toContain("browser_run");
  });

  it("mcp-server registers the tool with step limit and timeout in the description", () => {
    const mcp = readFileSync(fileURLToPath(new URL("../../src/main/mcp-server.ts", import.meta.url)), "utf8");
    expect(mcp).toContain('"browser_run"');
    expect(mcp).toContain(String(BROWSER_RUN_MAX_STEPS));
    expect(mcp).toContain(String(BROWSER_RUN_DEFAULT_TIMEOUT_MS));
  });
});

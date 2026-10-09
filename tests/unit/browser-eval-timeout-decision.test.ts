import { describe, expect, it } from "vitest";
import {
  EVAL_TIMEOUT_DEFAULT_MS,
  EVAL_TIMEOUT_MAX_MS,
  EVAL_TIMEOUT_MIN_MS,
  awaitExpressionSource,
  chooseEvalScriptForm,
  describeEvalThrown,
  describeEvalTimeout,
  normalizeEvalTimeout,
  unwrapEvalRaw,
} from "../../src/main/browser-eval-timeout-decision";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Run the page-side envelope in a fresh VM (literal body — no in-page new Function). */
async function runEnvelope(script: string): Promise<unknown> {
  const sandbox = { setTimeout, clearTimeout, Error, Promise, Object, String, Number, Boolean, Array, JSON, Math };
  return vm.runInNewContext(awaitExpressionSource(script), sandbox, { timeout: 5_000 });
}

/**
 * browser_eval wait limit and page-side envelope.
 * Covers Zone.js thenables, own timeout, top-level return/await, and real thrown errors.
 */
describe("normalizeEvalTimeout — how long to wait", () => {
  it("absent or invalid falls back to the 30s default", () => {
    expect(normalizeEvalTimeout(undefined)).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(normalizeEvalTimeout(null)).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(normalizeEvalTimeout("3000")).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(normalizeEvalTimeout(Number.NaN)).toBe(EVAL_TIMEOUT_DEFAULT_MS);
    expect(EVAL_TIMEOUT_DEFAULT_MS).toBe(30_000);
  });

  it("honours the caller's value inside the allowed range", () => {
    expect(normalizeEvalTimeout(3000)).toBe(3000);
    expect(normalizeEvalTimeout(100)).toBe(EVAL_TIMEOUT_MIN_MS);
    expect(normalizeEvalTimeout(250)).toBe(250);
  });

  it("caps at the max so the call fails before the MCP idle timeout", () => {
    expect(normalizeEvalTimeout(999_999)).toBe(EVAL_TIMEOUT_MAX_MS);
    expect(EVAL_TIMEOUT_MAX_MS).toBeLessThan(300_000);
  });
});

describe("describeEvalTimeout — the message half of the fix", () => {
  const texto = describeEvalTimeout({ waitedMs: 3000, timeoutMs: 3000 });

  it("states how long it waited, in ms and in seconds", () => {
    expect(texto).toContain("3000ms");
    expect(texto).toContain("3.0s");
  });

  it("states that the script KEPT RUNNING and that the result was discarded", () => {
    expect(texto).toContain("KEPT RUNNING");
    expect(texto).toContain("discarded");
  });

  it("names the timeoutMs parameter and the ceiling", () => {
    expect(texto).toContain("timeoutMs");
    expect(texto).toContain(String(EVAL_TIMEOUT_MAX_MS));
  });

  it("warns that an expression that never settles will always hit this limit", () => {
    expect(texto).toContain("never");
  });
});

describe("chooseEvalScriptForm — decide in MAIN (not under page CSP)", () => {
  it("picks expression for a bare value", () => {
    expect(chooseEvalScriptForm("1 + 1")).toEqual({ form: "expression" });
    expect(chooseEvalScriptForm("document.title")).toEqual({ form: "expression" });
    expect(chooseEvalScriptForm("Promise.resolve(1)")).toEqual({ form: "expression" });
  });

  it("keeps expression form when the script ends in a line comment", () => {
    expect(chooseEvalScriptForm("1+1 // soma")).toEqual({ form: "expression" });
  });

  it("picks statements when top-level return makes expression illegal", () => {
    expect(chooseEvalScriptForm("return document.title")).toEqual({ form: "statements" });
    expect(chooseEvalScriptForm("return 1 + 1")).toEqual({ form: "statements" });
  });

  it("picks statements for await-then-return (portal-style body)", () => {
    expect(chooseEvalScriptForm("await Promise.resolve(1); return 2")).toEqual({ form: "statements" });
  });

  it("only SyntaxError falls through — invalid source is reported, not silently swapped", () => {
    const bad = chooseEvalScriptForm("return ;;;@@@");
    expect(bad.form).toBe("invalid");
    if (bad.form !== "invalid") return;
    expect(bad.error.message.length).toBeGreaterThan(0);
  });
});

describe("awaitExpressionSource — literal inject, no in-page eval", () => {
  it("wraps so top-level return is legal (statements form)", () => {
    const src = awaitExpressionSource("return document.title");
    expect(src).toMatch(/async\s*\(/);
    expect(src).toContain("return document.title");
    expect(src).not.toMatch(/const valor = \(\s*return /);
  });

  it("keeps bare expressions working (expression form: return (\\nexpr\\n))", () => {
    const src = awaitExpressionSource("1 + 1");
    expect(src).toContain("return (\n1 + 1\n);");
    expect(src).toMatch(/async/);
  });

  it("awaits thenables by `.then`, not by Promise identity (Zone.js)", () => {
    const src = awaitExpressionSource("Promise.resolve(1)");
    expect(src).toContain('typeof valor.then === "function"');
    expect(src).toContain("await valor");
  });

  it("embeds the caller script as a literal (no page-side string re-parse)", () => {
    const expr = "(() => ({ a: `t${1}`, b: \"x\" }))()";
    expect(awaitExpressionSource(expr)).toContain(expr);
  });

  it("never emits eval or new Function into the page source", () => {
    for (const script of ["1 + 1", "return 1", "await Promise.resolve(2)", "throw new Error('x')"]) {
      const src = awaitExpressionSource(script);
      expect(src).not.toMatch(/\bnew Function\b/);
      expect(src).not.toMatch(/\beval\s*\(/);
    }
  });

  it("catches throws inside the page and returns message, stack, and line", () => {
    const src = awaitExpressionSource("throw new Error('boom')");
    expect(src).toMatch(/message/);
    expect(src).toMatch(/stack/);
    expect(src).toMatch(/line/);
    expect(src).toMatch(/__stellar_browser_eval/);
  });

  it("the registry uses the envelope and the own timeout on the browser_eval path", () => {
    const registry = readFileSync(fileURLToPath(new URL("../../src/main/browser-registry.ts", import.meta.url)), "utf8");
    expect(registry).toContain("awaitExpressionSource(js)");
    expect(registry).toContain("normalizeEvalTimeout(timeoutMsInput)");
    expect(registry).toContain("describeEvalTimeout({");
    expect(registry).toContain("unwrapEvalRaw");
  });
});

describe("envelope execution — the three acceptance cases", () => {
  it("top-level return yields the value (async function body)", async () => {
    const raw = await runEnvelope("return 40 + 2");
    expect(unwrapEvalRaw(raw)).toEqual({ kind: "value", value: 42 });
  });

  it("top-level await settles before returning", async () => {
    const raw = await runEnvelope(
      "const v = await new Promise((r) => setTimeout(() => r('late'), 30)); return v;",
    );
    expect(unwrapEvalRaw(raw)).toEqual({ kind: "value", value: "late" });
  });

  it("a bare expression still works without return", async () => {
    const raw = await runEnvelope("1 + 1");
    expect(unwrapEvalRaw(raw)).toEqual({ kind: "value", value: 2 });
  });

  it("a trailing line comment does not swallow ); — still yields 2", async () => {
    const raw = await runEnvelope("1+1 // soma");
    expect(unwrapEvalRaw(raw)).toEqual({ kind: "value", value: 2 });
  });

  it("a throw returns message, stack, and line — not Electron's opaque string", async () => {
    const raw = await runEnvelope("throw new Error('stellar-eval-boom')");
    const unwrapped = unwrapEvalRaw(raw);
    expect(unwrapped.kind).toBe("thrown");
    if (unwrapped.kind !== "thrown") return;
    expect(unwrapped.error.message).toBe("stellar-eval-boom");
    expect(unwrapped.error.stack).toMatch(/stellar-eval-boom/);
    expect(unwrapped.error.line).toBeTypeOf("number");
    const text = describeEvalThrown(unwrapped.error);
    expect(text).toContain("stellar-eval-boom");
    expect(text).toMatch(/line \d+/);
    expect(text).not.toMatch(/Script failed to execute/i);
  });
});

describe("unwrapEvalRaw + describeEvalThrown — real exception surface", () => {
  it("unwraps a successful envelope to the value", () => {
    expect(unwrapEvalRaw({ __stellar_browser_eval_ok: true, value: 42 })).toEqual({
      kind: "value",
      value: 42,
    });
  });

  it("unwraps a thrown envelope to message/stack/line", () => {
    const err = {
      message: "boom",
      stack: "Error: boom\n    at <anonymous>:2:9",
      line: 1,
    };
    expect(
      unwrapEvalRaw({
        __stellar_browser_eval_err: true,
        message: err.message,
        stack: err.stack,
        line: err.line,
      }),
    ).toEqual({ kind: "thrown", error: err });
  });

  it("treats a bare value (no envelope) as the result — defensive for older paths", () => {
    expect(unwrapEvalRaw(7)).toEqual({ kind: "value", value: 7 });
  });

  it("describeEvalThrown names message, stack, and line", () => {
    const text = describeEvalThrown({
      message: "boom",
      stack: "Error: boom\n    at <anonymous>:2:9",
      line: 2,
    });
    expect(text).toContain("boom");
    expect(text).toContain("line 2");
    expect(text).toContain("Error: boom");
    expect(text).not.toMatch(/Script failed to execute/i);
  });
});

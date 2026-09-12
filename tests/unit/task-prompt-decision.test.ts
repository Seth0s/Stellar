import { describe, it, expect } from "vitest";
import {
  applyTaskPromptWrite,
  formatTaskPromptAddition,
  parseTaskPrompt,
  TASK_PROMPT_ADDITION_MARKER,
} from "../../src/task-prompt-decision";

describe("task-prompt-decision", () => {
  const at = Date.parse("2026-09-12T13:24:00.000Z");

  it("append on an existing original keeps the statement and marks the addition", () => {
    const applied = applyTaskPromptWrite({
      existing: "why this task exists",
      incoming: "reviewers: also check i18n",
      mode: "append",
      at,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.changed).toBe(true);
    expect(applied.prompt.startsWith("why this task exists")).toBe(true);
    expect(applied.prompt).toContain(TASK_PROMPT_ADDITION_MARKER);
    expect(applied.prompt).toContain("2026-09-12T13:24:00.000Z");
    expect(applied.prompt).toContain("reviewers: also check i18n");
    expect(applied.prompt).toBe(
      formatTaskPromptAddition("why this task exists", "reviewers: also check i18n", at),
    );

    const parsed = parseTaskPrompt(applied.prompt);
    expect(parsed.original).toBe("why this task exists");
    expect(parsed.additions).toEqual([{ at, text: "reviewers: also check i18n" }]);
  });

  it("append on a null/blank prompt establishes the original — no marker", () => {
    const applied = applyTaskPromptWrite({
      existing: null,
      incoming: "first briefing",
      mode: "append",
      at,
    });
    expect(applied).toEqual({ ok: true, prompt: "first briefing", changed: true });
    expect(parseTaskPrompt(applied.ok ? applied.prompt : "").additions).toEqual([]);
  });

  it("replace overwrites the whole briefing only when asked", () => {
    const applied = applyTaskPromptWrite({
      existing: "old\n\n---\n[stellar:added 2026-09-11T00:00:00.000Z]\nnote",
      incoming: "rewritten by the owner",
      mode: "replace",
      at,
    });
    expect(applied).toEqual({ ok: true, prompt: "rewritten by the owner", changed: true });
    expect(parseTaskPrompt("rewritten by the owner")).toEqual({
      original: "rewritten by the owner",
      additions: [],
    });
  });

  it("replace that matches the stored text is a no-op", () => {
    const applied = applyTaskPromptWrite({
      existing: "same",
      incoming: "same",
      mode: "replace",
      at,
    });
    expect(applied).toEqual({ ok: true, prompt: "same", changed: false });
  });

  it("refuses whitespace-only incoming — would erase why the task exists on replace, and add noise on append", () => {
    expect(applyTaskPromptWrite({ existing: "keep", incoming: "  \n", mode: "append", at })).toEqual({
      ok: false,
      error: "empty prompt",
    });
    expect(applyTaskPromptWrite({ existing: "keep", incoming: "", mode: "replace", at })).toEqual({
      ok: false,
      error: "empty prompt",
    });
  });

  it("two appends stay parseable as original + ordered additions", () => {
    const first = applyTaskPromptWrite({
      existing: "original",
      incoming: "first note",
      mode: "append",
      at,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const later = at + 60_000;
    const second = applyTaskPromptWrite({
      existing: first.prompt,
      incoming: "second note",
      mode: "append",
      at: later,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(parseTaskPrompt(second.prompt)).toEqual({
      original: "original",
      additions: [
        { at, text: "first note" },
        { at: later, text: "second note" },
      ],
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  actionStatesEqual,
  decideLocator,
  describeUnchangedAction,
  stableHandleKey,
  type ActionTargetState,
} from "../../src/main/browser-locator-decision";

describe("decideLocator", () => {
  it("prefers ref over role/text/selector", () => {
    expect(
      decideLocator({ ref: "e3", role: "button", name: "Save", text: "Save", selector: "#x" }),
    ).toMatchObject({ kind: "ref", ref: "e3" });
  });

  it("resolves role+name (getByRole)", () => {
    expect(decideLocator({ role: "button", name: "Novo evento" })).toEqual({
      kind: "role",
      role: "button",
      name: "Novo evento",
      describe: 'role="button" name="Novo evento"',
    });
  });

  it("resolves role alone", () => {
    const d = decideLocator({ role: "textbox" });
    expect(d.kind).toBe("role");
    if (d.kind === "role") expect(d.name).toBeNull();
  });

  it("resolves visible text (getByText)", () => {
    expect(decideLocator({ text: "Novo evento" })).toMatchObject({
      kind: "text",
      text: "Novo evento",
    });
  });

  it("falls back to CSS selector", () => {
    expect(decideLocator({ selector: "#save" })).toMatchObject({ kind: "css", selector: "#save" });
  });

  it("refuses when nothing is given, naming the alternatives", () => {
    const d = decideLocator({});
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") {
      expect(d.error).toContain("role");
      expect(d.error).toContain("text");
      expect(d.error).toContain("ref");
    }
  });
});

describe("stableHandleKey + post-action state", () => {
  it("stableHandleKey is case-insensitive on role/name/tag", () => {
    expect(stableHandleKey({ role: "Button", name: "Save", tag: "BUTTON" })).toBe(
      stableHandleKey({ role: "button", name: "save", tag: "button" }),
    );
  });

  it("actionStatesEqual detects a no-op", () => {
    const a: ActionTargetState = {
      value: "10:00",
      checked: null,
      ariaInvalid: null,
      ariaExpanded: "false",
      ariaSelected: null,
      text: "10:00",
    };
    expect(actionStatesEqual(a, { ...a })).toBe(true);
    expect(actionStatesEqual(a, { ...a, ariaExpanded: "true" })).toBe(false);
    expect(actionStatesEqual(a, { ...a, ariaSelected: "true" })).toBe(false);
  });

  it("describeUnchangedAction names before/after", () => {
    const before: ActionTargetState = {
      value: "",
      checked: false,
      ariaInvalid: null,
      ariaExpanded: null,
      ariaSelected: null,
      text: "off",
    };
    const after = { ...before };
    const msg = describeUnchangedAction("click", before, after);
    expect(msg).toContain("did not change");
    expect(msg).toContain("browser_click");
  });
});

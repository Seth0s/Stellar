import { describe, expect, it } from "vitest";
import {
  STELLAR_PATHS_MIME,
  classifyDropSurfaceFromAttrs,
  decideFileDropDestination,
  decideTerminalDropHighlight,
  escapePathForWarning,
  formatPathsForTerminalInput,
  hasDropFilePayload,
  joinProjectPath,
  parseStellarPathsPayload,
  pathHasShellUnsafeControls,
  quoteShellArg,
} from "../../src/renderer/src/terminal-drop-decision";

describe("quoteShellArg — single quotes, refuse controls", () => {
  it("wraps with single quotes so ! $ ` stay literal", () => {
    expect(quoteShellArg("/tmp/plain.png")).toBe("'/tmp/plain.png'");
    expect(quoteShellArg("/tmp/my file.png")).toBe("'/tmp/my file.png'");
    expect(quoteShellArg("a!b")).toBe("'a!b'");
    expect(quoteShellArg("$(x)")).toBe("'$(x)'");
    expect(quoteShellArg("`x`")).toBe("'`x`'");
    expect(quoteShellArg("it's")).toBe(`'it'\\''s'`);
  });

  it("refuses paths with control characters (never quote them for the PTY)", () => {
    expect(quoteShellArg("x\nrm -rf ~")).toBeNull();
    expect(quoteShellArg("a\tb")).toBeNull();
    expect(quoteShellArg("a\rb")).toBeNull();
    expect(quoteShellArg(`a${String.fromCharCode(0)}b`)).toBeNull();
    expect(quoteShellArg(`a${String.fromCharCode(0x7f)}b`)).toBeNull();
    expect(pathHasShellUnsafeControls("x\nrm")).toBe(true);
    expect(pathHasShellUnsafeControls("/tmp/ok.png")).toBe(false);
  });
});

describe("formatPathsForTerminalInput", () => {
  it("joins safe paths and lists refused ones escaped for the warning", () => {
    expect(formatPathsForTerminalInput([])).toEqual({ typed: "", refused: [] });
    expect(formatPathsForTerminalInput(["/a.png", "/b c.png"])).toEqual({
      typed: "'/a.png' '/b c.png' ",
      refused: [],
    });
    const mixed = formatPathsForTerminalInput(["/ok.png", "x\nrm -rf ~"]);
    expect(mixed.typed).toBe("'/ok.png' ");
    expect(mixed.refused).toEqual([escapePathForWarning("x\nrm -rf ~")]);
    expect(mixed.refused[0]).toContain("\\n");
  });
});

describe("joinProjectPath", () => {
  it("joins root + relative, passes absolute through", () => {
    expect(joinProjectPath("/home/me/proj", "src/a.png")).toBe("/home/me/proj/src/a.png");
    expect(joinProjectPath("/home/me/proj/", "/abs/x.png")).toBe("/abs/x.png");
  });
});

describe("decideFileDropDestination", () => {
  it("routes live terminal → terminal, dead terminal → ignore, empty → canvas", () => {
    expect(decideFileDropDestination({ kind: "terminal", live: true })).toBe("terminal");
    expect(decideFileDropDestination({ kind: "terminal", live: false })).toBe("ignore");
    expect(decideFileDropDestination({ kind: "canvas" })).toBe("canvas");
    expect(decideFileDropDestination({ kind: "other-card" })).toBe("ignore");
  });
});

describe("decideTerminalDropHighlight / hasDropFilePayload", () => {
  it("highlights only a live terminal with a file payload", () => {
    expect(decideTerminalDropHighlight({ live: true, hasFilePayload: true })).toBe(true);
    expect(decideTerminalDropHighlight({ live: false, hasFilePayload: true })).toBe(false);
    expect(decideTerminalDropHighlight({ live: true, hasFilePayload: false })).toBe(false);
  });

  it("recognizes Files and the in-app paths MIME", () => {
    expect(hasDropFilePayload(["Files"])).toBe(true);
    expect(hasDropFilePayload([STELLAR_PATHS_MIME])).toBe(true);
    expect(hasDropFilePayload(["text/plain"])).toBe(false);
  });
});

describe("parseStellarPathsPayload", () => {
  it("accepts a JSON string array and rejects junk", () => {
    expect(parseStellarPathsPayload(JSON.stringify(["/a", "/b"]))).toEqual(["/a", "/b"]);
    expect(parseStellarPathsPayload("not-json")).toEqual([]);
    expect(parseStellarPathsPayload(JSON.stringify([1, "/x"]))).toEqual(["/x"]);
  });
});

describe("classifyDropSurfaceFromAttrs", () => {
  it("maps kind + card id + live set to a surface", () => {
    const live = new Set(["t-live"]);
    expect(classifyDropSurfaceFromAttrs(null, "", live)).toEqual({ kind: "canvas" });
    expect(classifyDropSurfaceFromAttrs("terminal", "t-live", live)).toEqual({
      kind: "terminal",
      live: true,
    });
    expect(classifyDropSurfaceFromAttrs("terminal", "t-dead", live)).toEqual({
      kind: "terminal",
      live: false,
    });
    expect(classifyDropSurfaceFromAttrs("sticky", "s1", live)).toEqual({ kind: "other-card" });
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBoardContext,
  readBoardContext,
  seedBoardContext,
  writeBoardContext,
} from "../../src/main/board-context";

/**
 * The board declares its gates' extra tool directories in the same per-board
 * file as the rules (`board-context/<id>.json`). Parsing is tolerant: only
 * trimmed, non-empty strings are kept, duplicates drop, and an absent field
 * leaves the context exactly as before (no empty key appears).
 */

describe("board context: gateToolPaths", () => {
  it("reads the declared directories, trimmed and de-duplicated", () => {
    const parsed = parseBoardContext({
      rules: [],
      traps: [],
      gateToolPaths: ["  /opt/tools/lint ", "/opt/tools/lint", "/home/u/ws/scripts", 7, ""],
    });
    expect(parsed.gateToolPaths).toEqual(["/opt/tools/lint", "/home/u/ws/scripts"]);
  });

  it("omits the key when the board declares none", () => {
    expect(parseBoardContext({ rules: [], traps: [] })).toEqual({ rules: [], traps: [] });
    expect(parseBoardContext({ rules: [], traps: [], gateToolPaths: "nope" })).toEqual({
      rules: [],
      traps: [],
    });
  });

  it("survives a write/read round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-ctx-tools-"));
    try {
      writeBoardContext(dir, "board-tools", {
        rules: [],
        traps: [],
        gateToolPaths: ["/opt/tools/lint"],
      });
      expect(readBoardContext(dir, "board-tools").gateToolPaths).toEqual(["/opt/tools/lint"]);
      // A board that declares none still reads without the key.
      writeBoardContext(dir, "board-plain", { rules: [], traps: [] });
      expect(readBoardContext(dir, "board-plain")).toEqual({ rules: [], traps: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeds the key from the data file when present", () => {
    expect(seedBoardContext({ rules: [{ text: "r" }], gateToolPaths: ["/opt/tools"] }).gateToolPaths).toEqual([
      "/opt/tools",
    ]);
    expect(seedBoardContext({ rules: [{ text: "r" }] }).gateToolPaths).toBeUndefined();
  });
});

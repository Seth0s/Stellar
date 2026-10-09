import { describe, expect, it } from "vitest";
import {
  CODE_FOLDER_COLORS,
  folderColorAtDepth,
  folderFillAtDepth,
} from "../../src/renderer/src/code-folder-color-decision";

describe("folderColorAtDepth", () => {
  it("cycles the four prototype colors", () => {
    expect(folderColorAtDepth(0)).toBe(CODE_FOLDER_COLORS[0]);
    expect(folderColorAtDepth(1)).toBe(CODE_FOLDER_COLORS[1]);
    expect(folderColorAtDepth(2)).toBe(CODE_FOLDER_COLORS[2]);
    expect(folderColorAtDepth(3)).toBe(CODE_FOLDER_COLORS[3]);
    expect(folderColorAtDepth(4)).toBe(CODE_FOLDER_COLORS[0]);
  });

  it("fill appends 33 alpha to the stroke", () => {
    expect(folderFillAtDepth(0)).toBe(`${CODE_FOLDER_COLORS[0]}33`);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAIL_CREATE_ORDER } from "../../src/renderer/src/cards/registry";
import {
  PICK_MEDIA_EXTENSIONS,
  resolvePickedMediaFile,
  SPAWN_MEDIA_EXT_TO_TYPE,
} from "../../src/main/spawn-media-decision";

describe("rail media pick", () => {
  it("keeps media out of RAIL_CREATE_ORDER (one-click would birth an empty shell)", () => {
    expect(RAIL_CREATE_ORDER.includes("media" as (typeof RAIL_CREATE_ORDER)[number])).toBe(false);
    expect(RAIL_CREATE_ORDER).not.toContain("media");
  });

  it("PICK_MEDIA_EXTENSIONS matches SPAWN_MEDIA_EXT_TO_TYPE / MediaCard set only", () => {
    expect(PICK_MEDIA_EXTENSIONS.sort()).toEqual(
      ["png", "jpg", "jpeg", "gif", "webp", "pdf"].sort(),
    );
    for (const ext of PICK_MEDIA_EXTENSIONS) {
      expect(SPAWN_MEDIA_EXT_TO_TYPE[`.${ext}`]).toBeDefined();
    }
    expect(Object.keys(SPAWN_MEDIA_EXT_TO_TYPE).map((e) => e.slice(1)).sort()).toEqual(
      [...PICK_MEDIA_EXTENSIONS].sort(),
    );
  });

  it("resolvePickedMediaFile accepts a real png and refuses unsupported types", () => {
    const dir = mkdtempSync(join(tmpdir(), "stellar-rail-media-"));
    try {
      const png = join(dir, "shot.png");
      writeFileSync(png, "x");
      expect(resolvePickedMediaFile(png)).toEqual({
        ok: true,
        path: png,
        mediaType: "image",
      });

      const txt = join(dir, "notes.txt");
      writeFileSync(txt, "nope");
      const refused = resolvePickedMediaFile(txt);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toMatch(/unsupported media type/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideSpawnMediaPath,
  describeAcceptedSpawnMedia,
} from "../../src/main/spawn-media-decision";

describe("decideSpawnMediaPath", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined as unknown as string;
  });

  function seed(name: string, body = "x"): string {
    dir = dir ?? mkdtempSync(join(tmpdir(), "stellar-spawn-media-"));
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  }

  it("accepts absolute png/jpeg/gif/webp/pdf", () => {
    for (const [name, mediaType] of [
      ["a.png", "image"],
      ["a.jpg", "image"],
      ["a.jpeg", "image"],
      ["a.gif", "image"],
      ["a.webp", "image"],
      ["a.pdf", "pdf"],
    ] as const) {
      const path = seed(name);
      const d = decideSpawnMediaPath({ path, cwd: null });
      expect(d).toEqual({ action: "accept", resolvedPath: path, mediaType });
    }
  });

  it("resolves relative path against cwd", () => {
    const path = seed("rel.png");
    const d = decideSpawnMediaPath({ path: "rel.png", cwd: dir });
    expect(d).toEqual({ action: "accept", resolvedPath: path, mediaType: "image" });
  });

  it("refuses relative path without cwd", () => {
    const d = decideSpawnMediaPath({ path: "x.png", cwd: null });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.error).toMatch(/absolute path/i);
  });

  it("refuses missing path with teaching message", () => {
    const d = decideSpawnMediaPath({ path: undefined, cwd: "/tmp" });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.error).toContain('kind "media" requires path');
      expect(d.error).toContain(describeAcceptedSpawnMedia());
    }
  });

  it("refuses unsupported extension naming accepted set", () => {
    const path = seed("notes.docx");
    const d = decideSpawnMediaPath({ path, cwd: null });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.error).toContain(".docx");
      expect(d.error).toContain(describeAcceptedSpawnMedia());
    }
  });

  it("refuses ENOENT", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-media-"));
    const d = decideSpawnMediaPath({ path: join(dir, "gone.png"), cwd: null });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.error).toMatch(/file not found/);
  });

  it("refuses a directory", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-media-"));
    const sub = join(dir, "folder.png");
    mkdirSync(sub);
    const d = decideSpawnMediaPath({ path: sub, cwd: null });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") expect(d.error).toMatch(/not a regular file/);
  });

  it("refuses unreadable file when chmod strips read", () => {
    if (process.getuid?.() === 0) return; // root bypasses mode bits
    const path = seed("secret.png");
    chmodSync(path, 0o000);
    try {
      const d = decideSpawnMediaPath({ path, cwd: null });
      expect(d.action).toBe("refuse");
      if (d.action === "refuse") expect(d.error).toMatch(/not readable|could not access/);
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

/**
 * work-home-profile.ts — preferências por perfil e raízes das ferramentas
 * (A3b sobre A3c). HOME falso.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultWorkHomePrefs,
  readWorkHomePrefs,
  resolveWorkHomeToolRoots,
  workHomePrefsPath,
  writeWorkHomePrefs,
} from "../../src/main/work-home-profile";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stellar-work-home-profile-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("prefs", () => {
  it("lê default quando ausente/corrompido e descarta ferramenta desconhecida", () => {
    expect(readWorkHomePrefs(dir)).toEqual(defaultWorkHomePrefs());
    writeFileSync(workHomePrefsPath(dir), "{ nao json");
    expect(readWorkHomePrefs(dir)).toEqual(defaultWorkHomePrefs());
    writeFileSync(workHomePrefsPath(dir), JSON.stringify({ enabledTools: ["claude", "nope"], workFolders: ["/a", "", 7] }));
    const prefs = readWorkHomePrefs(dir);
    expect(prefs.enabledTools).toEqual(["claude"]);
    expect(prefs.workFolders).toEqual(["/a"]);
  });

  it("round-trip da escrita atômica", () => {
    const prefs = { ...defaultWorkHomePrefs(), workFolders: ["/w"], lastRevision: 3, lastSyncAt: 42 };
    writeWorkHomePrefs(dir, prefs);
    expect(readWorkHomePrefs(dir)).toEqual(prefs);
  });
});

describe("resolveWorkHomeToolRoots", () => {
  const providers = [
    { id: "claude", supportsConfigHome: true },
    { id: "codex", supportsConfigHome: true },
    { id: "cursor", supportsConfigHome: false },
    { id: "antigravity", supportsConfigHome: false },
  ];

  it("perfil system usa as pastas do sistema", () => {
    expect(resolveWorkHomeToolRoots({ homeDir: "/h", profileDir: "/p", homeMode: "system", providers })).toEqual({
      claude: "/h/.claude",
      codex: "/h/.codex",
      cursor: "/h/.cursor",
      gemini: "/h/.gemini",
    });
  });

  it("perfil isolated aponta ferramentas suportadas para a pasta do perfil; o resto fica no sistema", () => {
    expect(resolveWorkHomeToolRoots({ homeDir: "/h", profileDir: "/p", homeMode: "isolated", providers })).toEqual({
      claude: join("/p", "homes", "claude"),
      codex: join("/p", "homes", "codex"),
      cursor: "/h/.cursor",
      gemini: "/h/.gemini",
    });
  });
});

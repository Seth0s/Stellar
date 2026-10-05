/**
 * profile-home-copy.ts — "copiar do sistema" para um perfil isolado (adendo
 * A3c). HOME FALSO; nunca as pastas reais das CLIs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCopyFromSystem, previewCopyFromSystem, systemHomeRoots } from "../../src/main/profile-home-copy";

let base: string;
let home: string;
let profileDir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stellar-home-copy-"));
  home = join(base, "home");
  profileDir = join(base, "profiles", "p1");
  mkdirSync(home, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("systemHomeRoots", () => {
  it("mapeia as ferramentas sob o HOME dado", () => {
    expect(systemHomeRoots("/h")).toEqual({
      claude: "/h/.claude",
      codex: "/h/.codex",
      cursor: "/h/.cursor",
      gemini: "/h/.gemini",
    });
  });
});

describe("previewCopyFromSystem / applyCopyFromSystem", () => {
  it("copia skill e settings do sistema para a pasta do perfil; nunca credencial nem memória", () => {
    const claude = join(home, ".claude");
    write(claude, "skills/graphify/SKILL.md", "skill do sistema");
    write(claude, "CLAUDE.md", "regras");
    write(claude, "settings.json", JSON.stringify({ model: "opus", env: { TOKEN: "FAKE_SECRET" } }));
    write(claude, ".credentials.json", '{"claudeAiOauth":{"token":"FAKE_SECRET"}}');
    write(claude, join("projects", "-home-u-proj", "memory", "notes.md"), "memória que NÃO viaja");

    const preview = previewCopyFromSystem({ providerId: "claude", profileDir, homeDir: home });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // Só a raiz da ferramenta: memória de projeto fica de fora.
    expect(preview.plan.items.map((i) => i.path).sort()).toEqual([
      "{claude}/CLAUDE.md",
      "{claude}/settings.json",
      "{claude}/skills/graphify/SKILL.md",
    ]);
    expect(preview.destination).toBe(join(profileDir, "homes", "claude"));

    const result = applyCopyFromSystem({ preview, backupRoot: join(base, "backups"), now: 1_700_000_000_000 });
    expect(result.written).toHaveLength(3);
    const dest = preview.destination;
    expect(readFileSync(join(dest, "skills/graphify/SKILL.md"), "utf-8")).toBe("skill do sistema");
    expect(readFileSync(join(dest, "settings.json"), "utf-8")).not.toContain("FAKE_SECRET");
    expect(readFileSync(join(dest, "settings.json"), "utf-8")).toContain("opus");
    // Memória não foi copiada.
    expect(preview.plan.items.some((i) => i.path.includes("project:"))).toBe(false);
  });

  it("provider sem pasta de sistema é recusado (nada oferecido)", () => {
    expect(previewCopyFromSystem({ providerId: "bash", profileDir, homeDir: home })).toEqual({
      ok: false,
      reason: "unsupported-provider",
    });
  });

  it("antigravity usa a tabela do gemini", () => {
    const gemini = join(home, ".gemini");
    write(gemini, "skills/x/SKILL.md", "skill gemini");
    const preview = previewCopyFromSystem({ providerId: "antigravity", profileDir, homeDir: home });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.tool).toBe("gemini");
    expect(preview.source).toBe(gemini);
  });
});

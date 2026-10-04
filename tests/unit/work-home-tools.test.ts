/**
 * work-home-tools.ts — tabela de allowlist e filtros de settings (A3a, §5.1).
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_SETTINGS_BEHAVIOR_KEYS,
  CODEX_CONFIG_BEHAVIOR_KEYS,
  WORK_HOME_TOOL_SPECS,
  filterJsonSettings,
  filterTomlSettings,
  isDenied,
} from "../../src/main/work-home-tools";
import { WORK_HOME_TOOLS } from "../../src/main/work-home-manifest";

describe("WORK_HOME_TOOL_SPECS — tabela declarada, uma por ferramenta", () => {
  it("toda ferramenta tem spec com regra", () => {
    for (const tool of WORK_HOME_TOOLS) {
      const spec = WORK_HOME_TOOL_SPECS[tool];
      expect(spec.tool).toBe(tool);
      expect(spec.rules.length).toBeGreaterThan(0);
    }
  });

  it("claude declara as raízes do §5.1 (CLAUDE.md, skills, agents, commands, memória, settings)", () => {
    const ids = WORK_HOME_TOOL_SPECS.claude.rules.map((r) => r.id);
    expect(ids).toEqual([
      "claude-md",
      "claude-skills",
      "claude-agents",
      "claude-commands",
      "claude-project-memory",
      "claude-settings",
    ]);
  });

  it("codex declara AGENTS.md, skills e config filtrado; cursor/gemini as suas", () => {
    expect(WORK_HOME_TOOL_SPECS.codex.rules.map((r) => r.id)).toEqual([
      "codex-agents",
      "codex-skills",
      "codex-config",
    ]);
    expect(WORK_HOME_TOOL_SPECS.cursor.rules.map((r) => r.id)).toContain("cursor-rules");
    expect(WORK_HOME_TOOL_SPECS.gemini.rules.map((r) => r.id)).toContain("gemini-skills");
    expect(WORK_HOME_TOOL_SPECS.stellar.rules[0].kind).toBe("stellar-bundle");
  });
});

describe("isDenied — a segunda barreira", () => {
  it("claude barra credencial, sessão, histórico e cache", () => {
    const spec = WORK_HOME_TOOL_SPECS.claude;
    expect(isDenied(spec, ".credentials.json")).toBe(true);
    expect(isDenied(spec, ".credentials.json")).toBe(true);
    expect(isDenied(spec, "projects/x/abc.jsonl")).toBe(true);
    expect(isDenied(spec, "history.jsonl")).toBe(true);
    expect(isDenied(spec, "cache/x")).toBe(true);
    expect(isDenied(spec, "skills/bom/SKILL.md")).toBe(false);
    expect(isDenied(spec, "CLAUDE.md")).toBe(false);
  });

  it("codex barra auth/sessões; gemini barra creds/state/builtin", () => {
    expect(isDenied(WORK_HOME_TOOL_SPECS.codex, "auth.json")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.codex, "sessions/x")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.gemini, "oauth_creds.json")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.gemini, "state.json")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.gemini, "antigravity-cli/builtin/skills/x")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.gemini, "skills/x/SKILL.md")).toBe(false);
  });

  it("cursor barra chats/projects/mcp", () => {
    expect(isDenied(WORK_HOME_TOOL_SPECS.cursor, "chats/x")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.cursor, "projects/x")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.cursor, "mcp.json")).toBe(true);
    expect(isDenied(WORK_HOME_TOOL_SPECS.cursor, "agents/x.md")).toBe(false);
  });
});

describe("filterJsonSettings", () => {
  const content = JSON.stringify({ model: "opus", env: { SECRET: "s3cr3t" }, hooks: { a: 1 }, extra: true });

  it("mantém só as chaves de comportamento declaradas", () => {
    const out = filterJsonSettings(content, CLAUDE_SETTINGS_BEHAVIOR_KEYS);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed).toEqual({ model: "opus", hooks: { a: 1 } });
    expect(out).not.toContain("s3cr3t");
  });

  it("não é JSON-objeto → null (nunca 'inclui tudo')", () => {
    expect(filterJsonSettings("não é json", CLAUDE_SETTINGS_BEHAVIOR_KEYS)).toBeNull();
    expect(filterJsonSettings("[1,2]", CLAUDE_SETTINGS_BEHAVIOR_KEYS)).toBeNull();
  });

  it("nenhuma chave declarada presente → null (arquivo não entra)", () => {
    expect(filterJsonSettings(JSON.stringify({ env: {} }), CLAUDE_SETTINGS_BEHAVIOR_KEYS)).toBeNull();
  });
});

describe("filterTomlSettings", () => {
  const toml = [
    'model = "gpt-5"',
    'aprovacao = "x"',
    "",
    "[profiles.pessoal]",
    'model = "o3"',
    "",
    "[auth]",
    'token = "segredo"',
    "",
    '[projects."/home/u/p"]',
    "trust = true",
    "",
  ].join("\n");

  it("mantém chaves/tabelas top-level declaradas e descarta o resto", () => {
    const out = filterTomlSettings(toml, CODEX_CONFIG_BEHAVIOR_KEYS);
    expect(out).not.toBeNull();
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain("[profiles.pessoal]");
    expect(out).toContain("[projects.");
    expect(out).not.toContain("aprovacao");
    expect(out).not.toContain("[auth]");
    expect(out).not.toContain("segredo");
  });

  it("nada declarado → null", () => {
    expect(filterTomlSettings("[auth]\ntoken='x'\n", CODEX_CONFIG_BEHAVIOR_KEYS)).toBeNull();
  });
});

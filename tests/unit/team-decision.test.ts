/**
 * team-decision.ts — the pure team decision layer. No network, no disk: roles
 * and permissions, invite target, team prefix, base filter (memory out), deep
 * link, and reading the backend replies.
 */
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/main/work-home-manifest";
import { planWorkHomeApply, resolveWorkHomeTarget } from "../../src/main/work-home-apply-decision";
import {
  accountRoleIn,
  applyTeamPrefix,
  canChangeTeamRole,
  canManageTeam,
  canPublishTeamHouse,
  canRemoveTeamMember,
  classifyInviteTarget,
  parseDeepLink,
  parseTeamDetail,
  parseTeamInvite,
  parseTeamListView,
  preferLocalForTeamConfig,
  prefixTeamManifest,
  teamFilePrefix,
  teamSafeManifest,
  type TeamRole,
} from "../../src/main/team-decision";

describe("papéis e permissões (espelho do backend)", () => {
  it("admin gerencia, member não", () => {
    expect(canManageTeam("owner")).toBe(true);
    expect(canManageTeam("admin")).toBe(true);
    expect(canManageTeam("member")).toBe(false);
    expect(canPublishTeamHouse("member")).toBe(false);
    expect(canPublishTeamHouse("admin")).toBe(true);
  });

  it("admin só mexe em member e nunca concede owner", () => {
    expect(canChangeTeamRole("admin", "member", "admin")).toBe(true);
    expect(canChangeTeamRole("admin", "member", "owner")).toBe(false);
    expect(canChangeTeamRole("admin", "admin", "member")).toBe(false);
    expect(canChangeTeamRole("admin", "owner", "member")).toBe(false);
    expect(canChangeTeamRole("member", "member", "admin")).toBe(false);
  });

  it("owner mexe em todos", () => {
    expect(canChangeTeamRole("owner", "admin", "member")).toBe(true);
    expect(canChangeTeamRole("owner", "member", "owner")).toBe(true);
  });

  it("remover: qualquer um sai; admin só remove member", () => {
    expect(canRemoveTeamMember("member", "owner", true)).toBe(true);
    expect(canRemoveTeamMember("admin", "member", false)).toBe(true);
    expect(canRemoveTeamMember("admin", "admin", false)).toBe(false);
    expect(canRemoveTeamMember("member", "member", false)).toBe(false);
  });

  it("papel da conta no detalhe", () => {
    const detail = parseTeamDetail({
      team: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme", slug: "acme" },
      members: [
        { account_id: "11111111-1111-4111-8111-111111111111", role: "owner", joined_at: "2026-10-05T00:00:00Z" },
        { account_id: "22222222-2222-4222-8222-222222222222", role: "member", joined_at: null },
      ],
    });
    expect(detail).not.toBeNull();
    expect(accountRoleIn(detail!, "22222222-2222-4222-8222-222222222222")).toBe<TeamRole>("member");
    expect(accountRoleIn(detail!, "33333333-3333-4333-8333-333333333333")).toBeNull();
  });
});

describe("alvo do convite", () => {
  it("e-mail, login GitHub e inválidos", () => {
    expect(classifyInviteTarget("membro@example.com")).toBe("email");
    expect(classifyInviteTarget("seth0s")).toBe("github");
    expect(classifyInviteTarget("sem-arroba-nem-login valido")).toBe("invalid");
    expect(classifyInviteTarget("-comeca-com-hifen")).toBe("invalid");
    expect(classifyInviteTarget("a@b")).toBe("invalid");
    expect(classifyInviteTarget("  ")).toBe("invalid");
  });
});

describe("prefixo do time (§5.6)", () => {
  it("skill do time ganha prefixo no ITEM, não no contêiner", () => {
    expect(applyTeamPrefix("{claude}/skills/foo/SKILL.md", "acme")).toBe("{claude}/skills/team-acme-foo/SKILL.md");
    expect(applyTeamPrefix("{claude}/agents/reviewer.md", "acme")).toBe("{claude}/agents/team-acme-reviewer.md");
  });

  it("arquivo de regra na raiz ganha prefixo no nome", () => {
    expect(applyTeamPrefix("{claude}/CLAUDE.md", "acme")).toBe("{claude}/team-acme-CLAUDE.md");
    expect(applyTeamPrefix("{codex}/AGENTS.md", "acme")).toBe("{codex}/team-acme-AGENTS.md");
  });

  it("config (settings) NÃO é prefixada — o nome é funcional; membro fica por cima", () => {
    expect(applyTeamPrefix("{claude}/settings.json", "acme")).toBe("{claude}/settings.json");
    expect(applyTeamPrefix("{codex}/config.toml", "acme")).toBe("{codex}/config.toml");
  });

  it("prefixTeamManifest aplica em todas as entradas", () => {
    const manifest = buildManifest([
      { tool: "claude", path: "{claude}/skills/foo/SKILL.md", sha256: "a".repeat(64), size: 1, mode: 0o644 },
      { tool: "claude", path: "{claude}/CLAUDE.md", sha256: "b".repeat(64), size: 1, mode: 0o644 },
    ]);
    const prefixed = prefixTeamManifest(manifest, "acme");
    expect(prefixed.entries.map((e) => e.path)).toEqual([
      "{claude}/skills/team-acme-foo/SKILL.md",
      "{claude}/team-acme-CLAUDE.md",
    ]);
    expect(teamFilePrefix("acme")).toBe("team-acme-");
  });
});

describe("base do time: memória e provider ficam FORA (§5.6)", () => {
  it("teamSafeManifest tira memória/sessão/histórico e o bundle stellar", () => {
    const manifest = buildManifest([
      { tool: "claude", path: "{claude}/skills/foo/SKILL.md", sha256: "a".repeat(64), size: 1, mode: 0o644 },
      { tool: "claude", path: "{project:github.com/o/r}/memory/nota.md", sha256: "b".repeat(64), size: 1, mode: 0o644 },
      { tool: "claude", path: "{claude}/projects/-home-u/memory/x.md", sha256: "c".repeat(64), size: 1, mode: 0o644 },
      { tool: "stellar", path: "{stellar}/provider-bundle.json", sha256: "d".repeat(64), size: 1, mode: 0o644 },
      { tool: "codex", path: "{codex}/sessions/s.jsonl", sha256: "e".repeat(64), size: 1, mode: 0o644 },
    ]);
    const safe = teamSafeManifest(manifest);
    expect(safe.manifest.entries.map((e) => e.path)).toEqual(["{claude}/skills/foo/SKILL.md"]);
    expect(safe.dropped).toContain("{project:github.com/o/r}/memory/nota.md");
    expect(safe.dropped).toContain("{stellar}/provider-bundle.json");
  });

  it("config do membro fica por cima: conflito de settings vira keep-local", () => {
    const manifest = buildManifest([
      { tool: "claude", path: "{claude}/settings.json", sha256: "a".repeat(64), size: 1, mode: 0o644 },
    ]);
    const plan = planWorkHomeApply({
      incoming: { manifest, blobs: new Map() },
      base: buildManifest([]),
      toolRoots: { claude: "/tmp/claude" },
      homeDir: "/tmp/home",
      projectClones: [],
      // local DIFERENTE do remoto, sem base → conflito
      shaOf: () => "f".repeat(64),
    });
    const adjusted = preferLocalForTeamConfig(plan);
    expect(adjusted.items[0].action).toBe("keep-local");
  });
});

describe("deep link stellar://invite", () => {
  it("lê o token das duas formas", () => {
    expect(parseDeepLink("stellar://invite?token=abc123")).toEqual({ kind: "invite", token: "abc123" });
    expect(parseDeepLink("stellar:invite?token=abc123")).toEqual({ kind: "invite", token: "abc123" });
  });

  it("recusa outro host, outro esquema e token vazio", () => {
    expect(parseDeepLink("stellar://other?token=abc")).toBeNull();
    expect(parseDeepLink("https://invite?token=abc")).toBeNull();
    expect(parseDeepLink("stellar://invite?token=")).toBeNull();
    expect(parseDeepLink("stellar://invite")).toBeNull();
    expect(parseDeepLink("não é url")).toBeNull();
  });
});

describe("path safety — the app refuses escapes itself", () => {
  const ctx = { toolRoots: { claude: "/root/.claude" }, homeDir: "/home/u", projectClones: [] };

  it("resolves a normal path", () => {
    expect(resolveWorkHomeTarget("{claude}/skills/foo/SKILL.md", ctx)).toEqual({
      kind: "resolved",
      absPath: "/root/.claude/skills/foo/SKILL.md",
    });
  });

  it("refuses traversal segments after the marker", () => {
    expect(resolveWorkHomeTarget("{claude}/../../.bashrc", ctx)).toEqual({ kind: "pending", reason: "unsafe-path" });
    expect(resolveWorkHomeTarget("{claude}/skills/../x", ctx)).toEqual({ kind: "pending", reason: "unsafe-path" });
    expect(resolveWorkHomeTarget("{claude}/ok/..", ctx)).toEqual({ kind: "pending", reason: "unsafe-path" });
    expect(resolveWorkHomeTarget("{home}/../.ssh/id_rsa", ctx)).toEqual({ kind: "pending", reason: "unsafe-path" });
  });

  it("refuses absolute, empty and backslash segments", () => {
    expect(resolveWorkHomeTarget("{claude}//etc/passwd", ctx)).toEqual({ kind: "pending", reason: "unsafe-path" });
    expect(resolveWorkHomeTarget("{claude}/a\\..\\b", ctx)).toEqual({ kind: "pending", reason: "unsafe-path" });
  });

  it("a TEAM path stays refused even after the prefix", () => {
    const teamPath = applyTeamPrefix("{claude}/../../.bashrc", "acme");
    expect(teamPath.startsWith("{claude}/..")).toBe(true);
    expect(resolveWorkHomeTarget(teamPath, ctx)).toEqual({ kind: "pending", reason: "unsafe-path" });
  });
});

describe("leitura do backend", () => {
  it("parseTeamListView lê times, perfis e identidades", () => {
    const view = parseTeamListView({
      account: { id: "11111111-1111-4111-8111-111111111111", display_name: "Lucas" },
      identities: [{ kind: "github", subject: "42", login: "seth" }],
      profiles: [{ id: "33333333-3333-4333-8333-333333333333", kind: "team", team_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme" }],
      teams: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme", slug: "acme" }],
    });
    expect(view?.accountId).toBe("11111111-1111-4111-8111-111111111111");
    expect(view?.teams[0]).toEqual({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme", slug: "acme" });
    expect(view?.profiles[0].teamId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(view?.identitySubjects).toEqual(["42", "seth"]);
  });

  it("parseTeamInvite valida id/tool/papel", () => {
    const invite = parseTeamInvite({
      id: "44444444-4444-4444-8444-444444444444",
      team_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: "membro@example.com",
      role: "member",
    });
    expect(invite?.target).toBe("membro@example.com");
    expect(parseTeamInvite({ id: "x", team_id: "y", target: "z", role: "member" })).toBeNull();
  });
});

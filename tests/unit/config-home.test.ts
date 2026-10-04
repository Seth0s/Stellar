/**
 * config-home (A3c/P5) — a decisão de pastas de CLI por perfil, e as
 * DECLARAÇÕES reais do catálogo (claude/codex nativos; opencode/cline no JSON).
 * Trava: env vs flag vs não-suporte, e o "pessoal em system não injeta nada".
 */
import { describe, it, expect } from "vitest";
import {
  isProviderHomeMode,
  parseConfigHomeDecl,
  planConfigHome,
  providerHomeDir,
  workHomeToolForProvider,
} from "../../src/main/config-home-decision";
import { providerById } from "../../src/main/providers";
import { shippedProviderSpecs } from "../../src/main/providers-dynamic";

const PROFILE_DIR = "/root/profiles/abc";

describe("parseConfigHomeDecl", () => {
  it("aceita env OU flag; ausente é null (não inventa suporte)", () => {
    expect(parseConfigHomeDecl(undefined)).toEqual({ ok: true, decl: null });
    expect(parseConfigHomeDecl({ env: "CLAUDE_CONFIG_DIR" })).toEqual({ ok: true, decl: { env: "CLAUDE_CONFIG_DIR" } });
    expect(parseConfigHomeDecl({ flag: "--config" })).toEqual({ ok: true, decl: { flag: "--config" } });
  });

  it("recusa os dois juntos, vazio e nome de env inválido", () => {
    expect(parseConfigHomeDecl({ env: "A", flag: "--b" }).ok).toBe(false);
    expect(parseConfigHomeDecl({}).ok).toBe(false);
    expect(parseConfigHomeDecl({ env: "1BAD" }).ok).toBe(false);
    expect(parseConfigHomeDecl("CLAUDE_CONFIG_DIR").ok).toBe(false);
  });
});

describe("planConfigHome", () => {
  it("perfil system não injeta NADA", () => {
    expect(planConfigHome({ providerId: "claude", homeMode: "system", profileDir: PROFILE_DIR, declaration: { env: "CLAUDE_CONFIG_DIR" } })).toEqual({
      kind: "system",
    });
  });

  it("isolated + env: aponta a variável para a pasta do perfil", () => {
    const plan = planConfigHome({
      providerId: "claude",
      homeMode: "isolated",
      profileDir: PROFILE_DIR,
      declaration: { env: "CLAUDE_CONFIG_DIR" },
    });
    expect(plan).toEqual({
      kind: "isolated",
      homeDir: "/root/profiles/abc/homes/claude",
      env: { CLAUDE_CONFIG_DIR: "/root/profiles/abc/homes/claude" },
      argv: [],
    });
  });

  it("isolated + flag: devolve o argv com a pasta do perfil", () => {
    const plan = planConfigHome({ providerId: "cline", homeMode: "isolated", profileDir: PROFILE_DIR, declaration: { flag: "--config" } });
    expect(plan).toEqual({
      kind: "isolated",
      homeDir: "/root/profiles/abc/homes/cline",
      env: {},
      argv: ["--config", "/root/profiles/abc/homes/cline"],
    });
  });

  it("isolated SEM suporte declarado: unsupported (o card avisa)", () => {
    expect(planConfigHome({ providerId: "cursor", homeMode: "isolated", profileDir: PROFILE_DIR, declaration: null })).toEqual({
      kind: "unsupported",
      providerId: "cursor",
    });
  });

  it("providerHomeDir é profiles/<id>/homes/<tool>", () => {
    expect(providerHomeDir(PROFILE_DIR, "opencode")).toBe("/root/profiles/abc/homes/opencode");
  });
});

describe("workHomeToolForProvider", () => {
  it("antigravity usa a tabela 'gemini' da A3a; sem tabela devolve null", () => {
    expect(workHomeToolForProvider("antigravity")).toBe("gemini");
    expect(workHomeToolForProvider("claude")).toBe("claude");
    expect(workHomeToolForProvider("commandcode")).toBeNull();
    expect(workHomeToolForProvider("bash")).toBeNull();
  });
});

describe("declarações REAIS do catálogo (medição → dado)", () => {
  it("nativos: claude=CLAUDE_CONFIG_DIR, codex=CODEX_HOME; cursor/antigravity NÃO declaram", () => {
    expect(providerById("claude")?.configHome).toEqual({ env: "CLAUDE_CONFIG_DIR" });
    expect(providerById("codex")?.configHome).toEqual({ env: "CODEX_HOME" });
    expect(providerById("cursor")?.configHome).toBeUndefined();
    expect(providerById("antigravity")?.configHome).toBeUndefined();
  });

  it("embutidos: opencode=OPENCODE_CONFIG_DIR, cline=--config, commandcode NÃO declara", () => {
    const specs = new Map(shippedProviderSpecs().map((s) => [s.id, s]));
    expect(specs.get("opencode")?.configHome).toEqual({ env: "OPENCODE_CONFIG_DIR" });
    expect(specs.get("cline")?.configHome).toEqual({ flag: "--config" });
    expect(specs.get("commandcode")?.configHome).toBeUndefined();
  });

  it("o spec do cline aceita o flag --config no spawn (argv extra)", () => {
    const cline = shippedProviderSpecs().find((s) => s.id === "cline");
    const plan = planConfigHome({ providerId: "cline", homeMode: "isolated", profileDir: PROFILE_DIR, declaration: cline?.configHome ?? null });
    expect(plan.kind === "isolated" && plan.argv[0]).toBe("--config");
  });
});

describe("isProviderHomeMode", () => {
  it("só system/isolated", () => {
    expect(isProviderHomeMode("system")).toBe(true);
    expect(isProviderHomeMode("isolated")).toBe(true);
    expect(isProviderHomeMode("house")).toBe(false);
  });
});

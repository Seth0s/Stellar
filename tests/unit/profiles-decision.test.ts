/**
 * profiles-decision.ts — a DECISÃO pura (BACKEND_V1.md §3/§7.1). Sem I/O.
 * Trava: parsing tolerante-de-ausência, matriz do gate de bootstrap,
 * seleção de perfil (inclusive --profile desconhecido com fallback AVISADO),
 * parse da flag e a receita de args do relaunch.
 */
import { describe, it, expect } from "vitest";
import {
  buildRelaunchArgs,
  createProfileEntry,
  decideProfileOpenable,
  decideProfilesBootstrap,
  describeProfilesBootstrapAbort,
  inspectProfilesRegistry,
  isValidProfileName,
  parseProfileArg,
  parseProfilesRegistry,
  resolveProfileSelection,
  validateNewProfile,
  validateRenameProfile,
  type ProfilesBootstrapSnapshot,
  type ProfilesRegistry,
} from "../../src/main/profiles-decision";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

function registry(partial: Partial<ProfilesRegistry> = {}): ProfilesRegistry {
  return {
    schemaVersion: 1,
    defaultProfileId: ID1,
    profiles: [{ id: ID1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" }],
    ...partial,
  };
}

function snap(partial: Partial<ProfilesBootstrapSnapshot> = {}): ProfilesBootstrapSnapshot {
  return { registry: "absent", inProgress: false, profilesDirHasEntries: false, rootHasProfileData: false, ...partial };
}

describe("parseProfilesRegistry", () => {
  it("aceita um registro íntegro", () => {
    expect(parseProfilesRegistry(registry())).toEqual(registry());
  });

  it("descarta entradas inválidas e mantém as boas (nunca conserta)", () => {
    const raw = {
      schemaVersion: 1,
      defaultProfileId: ID1,
      profiles: [
        { id: "não-é-uuid", name: "X", kind: "personal", createdAt: 1 },
        { id: ID1, name: "Pessoal", kind: "personal", createdAt: 1 },
        { id: ID2, name: "", kind: "team", createdAt: 1 },
        { id: ID2, name: "Empresa", kind: "guilda", createdAt: 1 },
      ],
    };
    const parsed = parseProfilesRegistry(raw);
    expect(parsed?.profiles).toEqual([{ id: ID1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" }]);
  });

  it("defaultProfileId que não aponta para um perfil vira null (ausência declarada)", () => {
    const parsed = parseProfilesRegistry(registry({ defaultProfileId: ID2 }));
    expect(parsed?.defaultProfileId).toBeNull();
  });

  it("recusa sem nenhum perfil utilizável", () => {
    expect(parseProfilesRegistry({ schemaVersion: 1, defaultProfileId: ID1, profiles: [] })).toBeNull();
  });

  it("recusa schemaVersion futura — o caller trata como future", () => {
    expect(parseProfilesRegistry({ ...registry(), schemaVersion: 2 })).toBeNull();
  });
});

describe("inspectProfilesRegistry", () => {
  it("ausente vs malformado vs futuro vs válido", () => {
    expect(inspectProfilesRegistry(null).kind).toBe("absent");
    expect(inspectProfilesRegistry("{").kind).toBe("malformed");
    expect(inspectProfilesRegistry("[]").kind).toBe("malformed");
    expect(inspectProfilesRegistry(JSON.stringify({ profiles: [] })).kind).toBe("malformed");
    expect(inspectProfilesRegistry(JSON.stringify({ ...registry(), schemaVersion: 0 })).kind).toBe("malformed");
    const future = inspectProfilesRegistry(JSON.stringify({ ...registry(), schemaVersion: 2 }));
    expect(future).toEqual({ kind: "future", version: 2 });
    expect(inspectProfilesRegistry(JSON.stringify(registry())).kind).toBe("valid");
  });
});

describe("decideProfilesBootstrap (matriz pura)", () => {
  it("registro válido → ready (nada a migrar)", () => {
    expect(decideProfilesBootstrap(snap({ registry: "valid" }))).toEqual({ action: "ready" });
  });

  it("registro de versão futura → abort (nunca reescrever)", () => {
    expect(decideProfilesBootstrap(snap({ registry: "future" }))).toEqual({ action: "abort", reason: "registry-future" });
  });

  it("corrompido COM perfis em disco → abort (não adivinha nomes)", () => {
    expect(decideProfilesBootstrap(snap({ registry: "malformed", profilesDirHasEntries: true }))).toEqual({
      action: "abort",
      reason: "registry-malformed",
    });
  });

  it("corrompido SEM perfis em disco → migrate recuperando", () => {
    expect(decideProfilesBootstrap(snap({ registry: "malformed" }))).toEqual({
      action: "migrate",
      reason: "recover-malformed",
    });
  });

  it("ausente + marcador em andamento → migrate retomando", () => {
    expect(decideProfilesBootstrap(snap({ inProgress: true }))).toEqual({
      action: "migrate",
      reason: "resume-interrupted",
    });
  });

  it("ausente do zero (raiz com ou sem dados) → migrate do primeiro boot", () => {
    expect(decideProfilesBootstrap(snap())).toEqual({ action: "migrate", reason: "first-boot" });
    expect(decideProfilesBootstrap(snap({ rootHasProfileData: true }))).toEqual({
      action: "migrate",
      reason: "first-boot",
    });
  });
});

describe("resolveProfileSelection", () => {
  const reg = registry({
    defaultProfileId: ID1,
    profiles: [
      { id: ID1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" },
      { id: ID2, name: "Empresa", kind: "team", createdAt: 2, homeMode: "isolated" },
    ],
  });

  it("sem flag usa o padrão", () => {
    expect(resolveProfileSelection(reg, null)).toEqual({ ok: true, profileId: ID1, usedFallback: false });
  });

  it("flag existente abre o pedido", () => {
    expect(resolveProfileSelection(reg, ID2)).toEqual({ ok: true, profileId: ID2, usedFallback: false });
  });

  it("flag desconhecida NÃO vira sucesso silencioso: cai no padrão e DIZ que caiu", () => {
    expect(resolveProfileSelection(reg, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual({
      ok: true,
      profileId: ID1,
      usedFallback: true,
      reason: "unknown-profile",
    });
  });

  it("sem padrão declarado cai no primeiro e DIZ que caiu", () => {
    const noDefault = registry({ defaultProfileId: null });
    expect(resolveProfileSelection(noDefault, null)).toEqual({
      ok: true,
      profileId: ID1,
      usedFallback: true,
      reason: "no-default",
    });
  });

  it("registro sem perfis é recusa", () => {
    expect(resolveProfileSelection(registry({ profiles: [] }), null)).toEqual({ ok: false, reason: "empty-registry" });
  });
});

describe("parseProfileArg", () => {
  it("lê as duas formas", () => {
    expect(parseProfileArg(["--profile=" + ID1])).toBe(ID1);
    expect(parseProfileArg(["--profile", ID2])).toBe(ID2);
  });

  it("a ÚLTIMA ocorrência vence (relaunch pode empilhar a flag)", () => {
    expect(parseProfileArg(["--profile=" + ID1, "--other", "--profile=" + ID2])).toBe(ID2);
  });

  it("valor vazio ou ausente é ausência", () => {
    expect(parseProfileArg(["--profile="])).toBeNull();
    expect(parseProfileArg(["--profile"])).toBeNull();
    expect(parseProfileArg(["--foo", "bar"])).toBeNull();
  });
});

describe("buildRelaunchArgs", () => {
  it("remove flags antigas (as duas formas) e anexa uma canônica", () => {
    expect(buildRelaunchArgs([".", "--profile=" + ID1, "--x", "--profile", ID2, "keep"], ID2)).toEqual([
      ".",
      "--x",
      "keep",
      "--profile=" + ID2,
    ]);
  });

  it("sem flag anterior, só anexa", () => {
    expect(buildRelaunchArgs(["."], ID1)).toEqual([".", "--profile=" + ID1]);
  });
});

describe("validações de nome", () => {
  it("nome vazio/longo é inválido", () => {
    expect(isValidProfileName("  ")).toBe(false);
    expect(isValidProfileName("a".repeat(61))).toBe(false);
    expect(isValidProfileName("Empresa")).toBe(true);
  });

  it("criar recusa duplicado (case-insensitive) e valida o limite", () => {
    const reg = registry();
    expect(validateNewProfile(reg, "Empresa")).toEqual({ ok: true, name: "Empresa" });
    expect(validateNewProfile(reg, " pessoal ")).toEqual({ ok: false, reason: "duplicate-name" });
    expect(validateNewProfile(reg, "")).toEqual({ ok: false, reason: "invalid-name" });
  });

  it("renomear mantém o id e recusa colisão com OUTRO perfil", () => {
    const reg = registry({
      profiles: [
        { id: ID1, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" },
        { id: ID2, name: "Empresa", kind: "team", createdAt: 2, homeMode: "isolated" },
      ],
    });
    expect(validateRenameProfile(reg, ID2, "Empresa LTDA")).toEqual({ ok: true, name: "Empresa LTDA" });
    expect(validateRenameProfile(reg, ID2, "pessoal")).toEqual({ ok: false, reason: "duplicate-name" });
    expect(validateRenameProfile(reg, ID2, "Empresa")).toEqual({ ok: true, name: "Empresa" });
    expect(validateRenameProfile(reg, ID1, "  ")).toEqual({ ok: false, reason: "invalid-name" });
    expect(validateRenameProfile(reg, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "X")).toEqual({
      ok: false,
      reason: "unknown-profile",
    });
  });
});

describe("createProfileEntry / decideProfileOpenable", () => {
  it("normaliza o nome e copia kind/createdAt", () => {
    expect(createProfileEntry(ID1, "  Empresa  ", "team", 10)).toEqual({
      id: ID1,
      name: "Empresa",
      kind: "team",
      createdAt: 10,
      homeMode: "isolated",
    });
  });

  it("A3c/P5: homeMode padrão por tipo — pessoal=system, time=isolated", () => {
    expect(createProfileEntry(ID1, "Pessoal", "personal", 1).homeMode).toBe("system");
    expect(createProfileEntry(ID2, "Empresa", "team", 1).homeMode).toBe("isolated");
    expect(createProfileEntry(ID2, "Empresa", "team", 1, "system").homeMode).toBe("system");
  });

  it("diretório ausente NÃO é abrível (a UI não oferece vazio)", () => {
    expect(decideProfileOpenable(true)).toEqual({ ok: true });
    expect(decideProfileOpenable(false)).toEqual({ ok: false, reason: "missing-directory" });
  });
});

describe("describeProfilesBootstrapAbort", () => {
  it("nomeia o arquivo e orienta o que fazer (recusa útil)", () => {
    const msg = describeProfilesBootstrapAbort("registry-malformed", {
      baseDir: "/home/u/.config/stellar",
      registryPath: "/home/u/.config/stellar/profiles.json",
      quarantinePath: "/home/u/.config/stellar/profiles.corrupt-1.json",
    });
    expect(msg).toContain("/home/u/.config/stellar/profiles.json");
    expect(msg).toContain("/home/u/.config/stellar/profiles/");
    expect(msg).toContain("/home/u/.config/stellar/profiles.corrupt-1.json");
  });

  it("futuro avisa que reescrever seria downgrade destrutivo", () => {
    const msg = describeProfilesBootstrapAbort("registry-future", {
      baseDir: "/b",
      registryPath: "/b/profiles.json",
    });
    expect(msg).toMatch(/MAIS NOVA/);
    expect(msg).toMatch(/downgrade/);
  });
});

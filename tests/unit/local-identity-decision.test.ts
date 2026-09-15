/**
 * local-identity-decision.ts — a decisão pura de identidade local.
 * STELLAR_TEAM.md §6 decisão 4: id real no modo local desde o dia 1.
 *
 * Cobre a matriz arquivo×espelho e as duas regras que não podem ser
 * quebradas: id OPACO (randomUUID-shape; nada de hostname/path/e-mail)
 * e tratamento honesto de arquivo inválido/truncado/versão futura.
 */
import { describe, expect, it } from "vitest";
import {
  decideLocalIdentity,
  inspectIdentityFile,
  isOpaqueId,
  LOCAL_IDENTITY_SCHEMA_VERSION,
  parseLocalIdentity,
  type LocalIdentity,
} from "../../src/main/local-identity-decision";

const USER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = 1_700_000_000_000;

function file(identity: Partial<LocalIdentity> & Record<string, unknown> = {}, version = LOCAL_IDENTITY_SCHEMA_VERSION): string {
  return JSON.stringify({
    schema_version: version,
    user_id: USER,
    install_id: INSTALL,
    created_at: NOW,
    ...identity,
  });
}

function mirror(identity: Partial<LocalIdentity> = {}): LocalIdentity {
  return { user_id: USER, install_id: INSTALL, created_at: NOW, ...identity };
}

/** Gerador determinístico: dois "UUIDs" distintos em sequência. */
function fakeGenerator(): () => string {
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ];
  let i = 0;
  return () => ids[i++ % ids.length];
}

function decide(raw: string | null, dbMirror: unknown = null) {
  return decideLocalIdentity({ raw, dbMirror, generateId: fakeGenerator(), now: NOW });
}

describe("isOpaqueId — regra b: nada que não seja UUID canônico", () => {
  it("aceita UUID canônico (qualquer caixa, qualquer versão)", () => {
    expect(isOpaqueId(USER)).toBe(true);
    expect(isOpaqueId("0F0F0F0F-0F0F-1F0F-9F0F-0F0F0F0F0F0F")).toBe(true);
  });

  it("recusa tudo que revelaria a máquina ou a pessoa", () => {
    for (const bad of [
      "lucas-workstation", // hostname
      "/home/lucas/.config/stellar", // path
      "lucas@example.com", // e-mail
      "00:1A:2B:3C:4D:5E", // MAC
      "WD-WCC4E1234567", // serial de disco
      "",
      "11111111-1111-4111-8111-11111111111G", // hex inválido
      "11111111-1111-4111-8111-11111111111", // curto
      "1111111111114111811111111111111 1", // sem hífens
      42,
      null,
      undefined,
      { user_id: USER },
    ]) {
      expect(isOpaqueId(bad), String(bad)).toBe(false);
    }
  });
});

describe("parseLocalIdentity — valida arquivo e espelho do banco", () => {
  it("aceita registro completo com ids opacos distintos", () => {
    expect(parseLocalIdentity(mirror())).toEqual(mirror());
  });

  it("recusa user_id === install_id (os dois eixos são coisas diferentes)", () => {
    expect(parseLocalIdentity({ user_id: USER, install_id: USER, created_at: NOW })).toBeNull();
  });

  it("recusa garbage de banco: NULL, string, array, ids não-opacos, created_at ruim", () => {
    expect(parseLocalIdentity(null)).toBeNull();
    expect(parseLocalIdentity("uuid")).toBeNull();
    expect(parseLocalIdentity([USER, INSTALL])).toBeNull();
    expect(parseLocalIdentity({ user_id: "hostname", install_id: INSTALL, created_at: NOW })).toBeNull();
    expect(parseLocalIdentity({ user_id: USER, install_id: INSTALL, created_at: -1 })).toBeNull();
    expect(parseLocalIdentity({ user_id: USER, install_id: INSTALL, created_at: NaN })).toBeNull();
    expect(parseLocalIdentity({ user_id: USER, install_id: INSTALL })).toBeNull();
  });
});

describe("inspectIdentityFile", () => {
  it("null = ausente", () => {
    expect(inspectIdentityFile(null)).toEqual({ kind: "absent" });
    expect(inspectIdentityFile(undefined)).toEqual({ kind: "absent" });
  });

  it("JSON truncado / não-objeto / sem schema_version = malformed", () => {
    expect(inspectIdentityFile('{"schema_version":1,"user_id"').kind).toBe("malformed");
    expect(inspectIdentityFile("[1,2]").kind).toBe("malformed");
    expect(inspectIdentityFile(JSON.stringify({ user_id: USER, install_id: INSTALL, created_at: NOW })).kind).toBe("malformed");
    expect(inspectIdentityFile(JSON.stringify({ schema_version: "1", user_id: USER, install_id: INSTALL, created_at: NOW })).kind).toBe(
      "malformed",
    );
  });

  it("versão atual com ids válidos = valid", () => {
    const finding = inspectIdentityFile(file());
    expect(finding).toEqual({ kind: "valid", identity: mirror() });
  });

  it("versão futura com ids legíveis = future com identity (created_at ilegível vira 0)", () => {
    const finding = inspectIdentityFile(file({}, LOCAL_IDENTITY_SCHEMA_VERSION + 1));
    expect(finding.kind).toBe("future");
    if (finding.kind === "future") {
      expect(finding.version).toBe(LOCAL_IDENTITY_SCHEMA_VERSION + 1);
      expect(finding.identity).toEqual(mirror());
    }
    const noCreatedAt = inspectIdentityFile(
      JSON.stringify({ schema_version: 99, user_id: USER, install_id: INSTALL, campo_novo: "x" }),
    );
    expect(noCreatedAt.kind).toBe("future");
    if (noCreatedAt.kind === "future") {
      expect(noCreatedAt.identity).toEqual({ user_id: USER, install_id: INSTALL, created_at: 0 });
    }
  });

  it("versão futura sem ids legíveis = future sem identity", () => {
    const finding = inspectIdentityFile(JSON.stringify({ schema_version: 99, user_id: "outra-coisa" }));
    expect(finding).toEqual({ kind: "future", version: 99, identity: null });
  });

  it("schema_version menor que a primeira versão = malformed (corrupção, não legado)", () => {
    expect(inspectIdentityFile(file({}, 0)).kind).toBe("malformed");
  });

  it("ids iguais ou não-opacos na versão atual = malformed", () => {
    expect(inspectIdentityFile(file({ install_id: USER })).kind).toBe("malformed");
    expect(inspectIdentityFile(file({ user_id: "meu-notebook" })).kind).toBe("malformed");
  });
});

describe("decideLocalIdentity — matriz arquivo×espelho", () => {
  it("primeiro run: nada em disco nem no banco — nasce fresh, escreve os dois, sem quarantena", () => {
    const d = decide(null, null);
    expect(d.origin).toBe("fresh");
    expect(d.writeFile).toBe(true);
    expect(d.writeMirror).toBe(true);
    expect(d.quarantine).toBe(false);
    expect(isOpaqueId(d.identity.user_id)).toBe(true);
    expect(isOpaqueId(d.identity.install_id)).toBe(true);
    expect(d.identity.user_id).not.toBe(d.identity.install_id);
    expect(d.identity.created_at).toBe(NOW);
  });

  it("arquivo válido + espelho igual: usa e não escreve nada", () => {
    const d = decide(file(), mirror());
    expect(d.origin).toBe("file");
    expect(d.identity).toEqual(mirror());
    expect(d.writeFile).toBe(false);
    expect(d.writeMirror).toBe(false);
    expect(d.quarantine).toBe(false);
  });

  it("arquivo válido + espelho divergente: ARQUIVO vence (fonte), espelho é reparado", () => {
    const d = decide(file(), mirror({ user_id: OTHER }));
    expect(d.origin).toBe("file");
    expect(d.identity.user_id).toBe(USER);
    expect(d.writeFile).toBe(false);
    expect(d.writeMirror).toBe(true);
  });

  it("arquivo válido + espelho ausente: repara espelho", () => {
    const d = decide(file(), null);
    expect(d.origin).toBe("file");
    expect(d.writeMirror).toBe(true);
    expect(d.writeFile).toBe(false);
  });

  it("arquivo truncado + espelho intacto: RESTAURA do espelho, quarantena e reescreve o arquivo", () => {
    const d = decide('{"schema_version":1,"user_i', mirror());
    expect(d.origin).toBe("mirror");
    expect(d.identity).toEqual(mirror());
    expect(d.quarantine).toBe(true);
    expect(d.writeFile).toBe(true);
    expect(d.writeMirror).toBe(false);
  });

  it("arquivo truncado + sem espelho: quarantena e nasce novo (não propaga garbage)", () => {
    const d = decide("não é json", null);
    expect(d.origin).toBe("fresh");
    expect(d.quarantine).toBe(true);
    expect(d.writeFile).toBe(true);
    expect(d.writeMirror).toBe(true);
  });

  it("arquivo ausente + espelho intacto: restaura do espelho e recria o arquivo, sem quarantena", () => {
    const d = decide(null, mirror());
    expect(d.origin).toBe("mirror");
    expect(d.identity).toEqual(mirror());
    expect(d.quarantine).toBe(false);
    expect(d.writeFile).toBe(true);
    expect(d.writeMirror).toBe(false);
  });

  it("versão futura com ids legíveis: usa read-only e NUNCA reescreve o arquivo", () => {
    const d = decide(file({}, LOCAL_IDENTITY_SCHEMA_VERSION + 1), mirror());
    expect(d.origin).toBe("future-file");
    expect(d.identity).toEqual(mirror());
    expect(d.writeFile).toBe(false);
    expect(d.quarantine).toBe(false);
  });

  it("versão futura sem ids: quarantena + fresh (bytes preservados, não sobrescritos)", () => {
    const d = decide(JSON.stringify({ schema_version: 99 }), null);
    expect(d.origin).toBe("fresh");
    expect(d.quarantine).toBe(true);
    expect(d.writeFile).toBe(true);
  });

  it("espelho corrompido (garbage de banco) é tratado como ausente", () => {
    const d = decide(null, { user_id: "hostname-do-dono", install_id: INSTALL, created_at: NOW });
    expect(d.origin).toBe("fresh");
  });

  it("generateId não-opaco LANÇA — gerador quebrado não pode cunhar id identificável", () => {
    expect(() =>
      decideLocalIdentity({ raw: null, dbMirror: null, generateId: () => "meu-pc.local", now: NOW }),
    ).toThrow(/anonimato/);
  });

  it("toda saída carrega reason legível (diagnóstico, não silêncio)", () => {
    for (const d of [decide(null), decide(file(), mirror()), decide("x", mirror()), decide(null, mirror())]) {
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * local-identity — o canônico de MÁQUINA (BACKEND_V1.md §3, item 5).
 * Trava: perfis diferentes adotam os MESMOS `user_id`/`install_id`, o
 * primeiro run ESTABELECE a canônica, e ela nunca é sobrescrita por um arquivo
 * de perfil válido. Sem diretório de máquina configurado (testes antigos), o
 * comportamento é o de antes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalIdentityFilePath, identityFilePath, resolveLocalIdentity, setMachineIdentityDir } from "../../src/main/local-identity";

function fakeGenerator(): () => string {
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ];
  let i = 0;
  return () => ids[i++ % ids.length];
}

function readId(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(identityFilePath(dir), "utf-8")) as Record<string, unknown>;
}

describe("identidade canônica da máquina", () => {
  let base: string;
  let profileA: string;
  let profileB: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "stellar-id-canon-"));
    profileA = join(base, "profileA");
    profileB = join(base, "profileB");
    mkdirSync(profileA, { recursive: true });
    mkdirSync(profileB, { recursive: true });
  });
  afterEach(() => {
    setMachineIdentityDir(null);
    rmSync(base, { recursive: true, force: true });
  });

  it("primeiro run: nasce em A, grava o arquivo de A E a canônica", () => {
    setMachineIdentityDir(base);
    const a = resolveLocalIdentity(profileA, { now: 1, generateId: fakeGenerator() });
    expect(a.decision.origin).toBe("fresh");
    expect(a.fileWritten).toBe(true);
    expect(a.canonicalWritten).toBe(true);
    expect(existsSync(canonicalIdentityFilePath(base))).toBe(true);
  });

  it("A e B adotam os MESMOS ids; o 2º perfil cai na canônica", () => {
    setMachineIdentityDir(base);
    const a = resolveLocalIdentity(profileA, { now: 1, generateId: fakeGenerator() });
    const b = resolveLocalIdentity(profileB, { now: 2, generateId: fakeGenerator() });
    expect(b.decision.origin).toBe("canonical");
    expect(b.canonicalWritten).toBe(false);
    expect(b.identity.user_id).toBe(a.identity.user_id);
    expect(b.identity.install_id).toBe(a.identity.install_id);
    // E o arquivo do perfil B materializa a identidade canônica (§3).
    expect(readId(profileB).user_id).toBe(a.identity.user_id);
  });

  it("a canônica nunca é sobrescrita; arquivo de perfil válido vence o espelho", () => {
    setMachineIdentityDir(base);
    const a = resolveLocalIdentity(profileA, { now: 1, generateId: fakeGenerator() });
    const canonicalBefore = readFileSync(canonicalIdentityFilePath(base), "utf-8");
    const again = resolveLocalIdentity(profileA, { now: 2, generateId: fakeGenerator() });
    expect(again.decision.origin).toBe("file");
    expect(again.fileWritten).toBe(false);
    expect(again.canonicalWritten).toBe(false);
    expect(readFileSync(canonicalIdentityFilePath(base), "utf-8")).toBe(canonicalBefore);
    expect(again.identity.user_id).toBe(a.identity.user_id);
  });

  it("arquivo de perfil corrompido: quarantena PRESERVA os bytes e adota a canônica", () => {
    setMachineIdentityDir(base);
    const a = resolveLocalIdentity(profileA, { now: 1, generateId: fakeGenerator() });
    writeFileSync(identityFilePath(profileB), '{"schema_version":1,"user_i');
    const b = resolveLocalIdentity(profileB, { now: 2, generateId: fakeGenerator() });
    expect(b.decision.origin).toBe("canonical");
    expect(b.quarantinePath).not.toBeNull();
    expect(readFileSync(b.quarantinePath!, "utf-8")).toBe('{"schema_version":1,"user_i');
    expect(b.identity.user_id).toBe(a.identity.user_id);
  });

  it("sem diretório de máquina, o comportamento antigo continua (fresh sem canônica)", () => {
    setMachineIdentityDir(null);
    const a = resolveLocalIdentity(profileA, { now: 1, generateId: fakeGenerator() });
    expect(a.decision.origin).toBe("fresh");
    expect(a.canonicalPath).toBeNull();
    expect(a.canonicalWritten).toBe(false);
    expect(existsSync(canonicalIdentityFilePath(base))).toBe(false);
  });
});

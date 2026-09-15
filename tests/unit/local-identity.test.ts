/**
 * local-identity.ts — a casca com I/O (arquivo em userData).
 * Verifica: nascimento no primeiro run, estabilidade entre runs,
 * restauração a partir do espelho do banco, quarantena que PRESERVA
 * bytes, versão futura nunca reescrita e escrita atômica (sem .tmp
 * remanescente).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identityFilePath, resolveLocalIdentity } from "../../src/main/local-identity";
import {
  isOpaqueId,
  LOCAL_IDENTITY_FILENAME,
  LOCAL_IDENTITY_SCHEMA_VERSION,
  type LocalIdentity,
} from "../../src/main/local-identity-decision";

const NOW = 1_700_000_000_000;
const MIRROR: LocalIdentity = {
  user_id: "11111111-1111-4111-8111-111111111111",
  install_id: "22222222-2222-4222-8222-222222222222",
  created_at: NOW,
};

function fakeGenerator(): () => string {
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ];
  let i = 0;
  return () => ids[i++ % ids.length];
}

function readIdentityFile(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(identityFilePath(dir), "utf-8")) as Record<string, unknown>;
}

describe("resolveLocalIdentity (casca I/O)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function tmp(): string {
    dir = mkdtempSync(join(tmpdir(), "stellar-local-id-"));
    return dir;
  }

  it("primeiro run: cria o arquivo com schema_version e ids opacos distintos", () => {
    const d = tmp();
    const r = resolveLocalIdentity(d, { now: NOW, generateId: fakeGenerator() });
    expect(r.decision.origin).toBe("fresh");
    expect(r.fileWritten).toBe(true);
    expect(r.quarantinePath).toBeNull();
    const onDisk = readIdentityFile(d);
    expect(onDisk.schema_version).toBe(LOCAL_IDENTITY_SCHEMA_VERSION);
    expect(onDisk.user_id).toBe(r.identity.user_id);
    expect(onDisk.install_id).toBe(r.identity.install_id);
    expect(isOpaqueId(onDisk.user_id)).toBe(true);
    expect(onDisk.user_id).not.toBe(onDisk.install_id);
  });

  it("segundo run: MESMA identidade, decisão não reescreve o arquivo", () => {
    const d = tmp();
    const first = resolveLocalIdentity(d, { now: NOW, generateId: fakeGenerator() });
    const second = resolveLocalIdentity(d, { now: NOW + 1000, generateId: fakeGenerator() });
    expect(second.decision.origin).toBe("file");
    expect(second.identity).toEqual(first.identity);
    expect(second.fileWritten).toBe(false);
    // created_at não é timestamp de acesso — continua o do nascimento.
    expect(readIdentityFile(d).created_at).toBe(first.identity.created_at);
  });

  it("arquivo corrompido + espelho do banco: restaura, quarantena PRESERVA os bytes e reescreve", () => {
    const d = tmp();
    writeFileSync(identityFilePath(d), '{"schema_version":1,"user_i');
    const r = resolveLocalIdentity(d, { dbMirror: MIRROR, now: NOW, generateId: fakeGenerator() });
    expect(r.decision.origin).toBe("mirror");
    expect(r.identity).toEqual(MIRROR);
    expect(r.quarantinePath).not.toBeNull();
    expect(existsSync(r.quarantinePath!)).toBe(true);
    // Os bytes suspeitos sobreviveram na quarantena, não foram destruídos.
    expect(readFileSync(r.quarantinePath!, "utf-8")).toBe('{"schema_version":1,"user_i');
    // O arquivo no lugar é o bom de novo.
    expect(readIdentityFile(d).user_id).toBe(MIRROR.user_id);
    expect(r.fileWritten).toBe(true);
  });

  it("arquivo corrompido + sem espelho: quarantena + identidade nova", () => {
    const d = tmp();
    writeFileSync(identityFilePath(d), "garbage");
    const r = resolveLocalIdentity(d, { now: NOW, generateId: fakeGenerator() });
    expect(r.decision.origin).toBe("fresh");
    expect(r.quarantinePath).not.toBeNull();
    expect(readFileSync(r.quarantinePath!, "utf-8")).toBe("garbage");
    expect(readIdentityFile(d).user_id).toBe(r.identity.user_id);
  });

  it("arquivo ausente + espelho: recria o arquivo com a identidade do espelho, sem quarantena", () => {
    const d = tmp();
    const r = resolveLocalIdentity(d, { dbMirror: MIRROR, now: NOW, generateId: fakeGenerator() });
    expect(r.decision.origin).toBe("mirror");
    expect(r.quarantinePath).toBeNull();
    expect(r.fileWritten).toBe(true);
    expect(readIdentityFile(d)).toMatchObject({ user_id: MIRROR.user_id, install_id: MIRROR.install_id });
  });

  it("arquivo de versão futura: nunca reescrito, nenhum byte tocado", () => {
    const d = tmp();
    const future = JSON.stringify({
      schema_version: LOCAL_IDENTITY_SCHEMA_VERSION + 1,
      user_id: MIRROR.user_id,
      install_id: MIRROR.install_id,
      created_at: NOW,
      campo_do_futuro: { que: "este código não conhece" },
    });
    writeFileSync(identityFilePath(d), future);
    const r = resolveLocalIdentity(d, { now: NOW, generateId: fakeGenerator() });
    expect(r.decision.origin).toBe("future-file");
    expect(r.identity.user_id).toBe(MIRROR.user_id);
    expect(r.fileWritten).toBe(false);
    expect(readFileSync(identityFilePath(d), "utf-8")).toBe(future);
  });

  it("escrita atômica: nunca sobra .tmp ao lado do arquivo", () => {
    const d = tmp();
    resolveLocalIdentity(d, { now: NOW, generateId: fakeGenerator() });
    expect(existsSync(`${identityFilePath(d)}.tmp`)).toBe(false);
    expect(existsSync(join(d, LOCAL_IDENTITY_FILENAME))).toBe(true);
  });

  it("generateId padrão (sem injeção) produz randomUUID real — v4 opaco", () => {
    const d = tmp();
    const r = resolveLocalIdentity(d);
    expect(r.identity.user_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(r.identity.install_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

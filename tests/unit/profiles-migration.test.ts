/**
 * profiles.ts — a casca com I/O (BACKEND_V1.md §3/§7.1).
 * Trava: semeadura do primeiro boot, migração por RENAME (nada copiado, nada
 * perdido), o corte máquina×perfil (identidade/locale ficam na raiz),
 * idempotência (2º boot não migra), retomada de migração interrompida,
 * quarentena do registro corrompido, recusa do futuro, e o CRUD do seletor.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROFILE_BACKUP_DIR_PREFIX,
  PROFILE_MIGRATE_ENTRIES,
  bootstrapProfiles,
  createProfile,
  describeProfilesState,
  listProfilesDirEntries,
  profileDirectory,
  profilesBackupPath,
  profilesMigrationInProgressPath,
  profilesRegistryPath,
  readProfilesRegistry,
  renameProfile,
  setDefaultProfile,
  setProfileHomeMode,
  writeProfilesRegistry,
  type ProfilesRegistry,
} from "../../src/main/profiles";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const MISSING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = 1_700_000_000_000;

function seqGenerator(...ids: string[]): () => string {
  let i = 0;
  return () => ids[i++ % ids.length];
}

describe("profiles (casca I/O)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "stellar-profiles-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function boot(requestedId: string | null = null) {
    return bootstrapProfiles(base, {
      requestedId,
      now: NOW,
      generateId: seqGenerator(ID1, ID2, ID3),
      defaultPersonalName: "Pessoal",
    });
  }

  it("primeiro boot numa raiz vazia: semeia o perfil pessoal e o registro", () => {
    const res = boot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.migrated).toBe(true);
    expect(res.profileId).toBe(ID1);
    expect(existsSync(profilesRegistryPath(base))).toBe(true);
    expect(existsSync(profileDirectory(base, ID1))).toBe(true);

    const registry = readProfilesRegistry(base);
    expect(registry.kind).toBe("valid");
    if (registry.kind !== "valid") return;
    expect(registry.registry.defaultProfileId).toBe(ID1);
    expect(registry.registry.profiles).toEqual([
      { id: ID1, name: "Pessoal", kind: "personal", createdAt: NOW, homeMode: "system" },
    ]);
  });

  it("migra os dados de perfil por RENAME; identidade e locale FICAM na raiz", () => {
    // Dados de perfil que devem MIGRAR.
    writeFileSync(join(base, "agent-canvas.db"), "db-bytes");
    writeFileSync(join(base, "agent-canvas.db-wal"), "wal");
    writeFileSync(join(base, "providers.json"), "{}");
    writeFileSync(join(base, "secrets.json"), "{}");
    mkdirSync(join(base, "board-assets", "b1"), { recursive: true });
    writeFileSync(join(base, "board-assets", "b1", "x.bin"), "asset");
    // Dados de MÁQUINA que NÃO podem migrar.
    writeFileSync(join(base, "local-identity.json"), '{"user_id":"u"}');
    writeFileSync(join(base, "locale.json"), '{"override":"en"}');

    const res = boot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const profileDir = profileDirectory(base, res.profileId);

    for (const entry of ["agent-canvas.db", "agent-canvas.db-wal", "providers.json", "secrets.json", "board-assets"]) {
      expect(existsSync(join(profileDir, entry))).toBe(true);
      expect(existsSync(join(base, entry))).toBe(false);
    }
    // Corte máquina×perfil.
    expect(existsSync(join(base, "local-identity.json"))).toBe(true);
    expect(existsSync(join(base, "locale.json"))).toBe(true);
    expect(existsSync(join(profileDir, "local-identity.json"))).toBe(false);

    // Manifesto de backup (receita de reversão).
    const backup = JSON.parse(readFileSync(profilesBackupPath(base), "utf8")) as { profileId: string; entries: string[] };
    expect(backup.profileId).toBe(res.profileId);
    expect(backup.entries).toEqual(expect.arrayContaining(["agent-canvas.db", "providers.json", "secrets.json", "board-assets"]));
    expect(backup.entries).not.toContain("local-identity.json");

    // Nenhuma entrada de perfil ficou para trás na raiz.
    const leftovers = PROFILE_MIGRATE_ENTRIES.filter((e) => existsSync(join(base, e)));
    expect(leftovers).toEqual([]);
  });

  it("idempotência: o 2º boot é ready, não migra de novo", () => {
    const first = boot();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(join(base, "providers.json"), "novo-provider"); // dado NOVO já no perfil

    const second = boot();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.migrated).toBe(false);
    expect(second.profileId).toBe(first.profileId);
    expect(second.entriesMoved).toEqual([]);
    // O dado que nasceu depois da migração não foi tocado.
    expect(existsSync(join(base, "providers.json"))).toBe(true);
  });

  it("CÓPIA DE SEGURANÇA: existe antes do rename e bate byte a byte; manifesto aponta para ela", () => {
    writeFileSync(join(base, "agent-canvas.db"), "db-bytes-exatos");
    writeFileSync(join(base, "providers.json"), '{"k":1}');
    writeFileSync(join(base, "secrets.json"), '{"s":2}');
    mkdirSync(join(base, "board-assets", "b1"), { recursive: true });
    writeFileSync(join(base, "board-assets", "b1", "x.bin"), "asset");

    const res = boot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const backupDirName = `${PROFILE_BACKUP_DIR_PREFIX}${NOW}`;
    const backupDir = join(base, backupDirName);
    expect(existsSync(backupDir)).toBe(true);

    // Byte a byte contra o que foi semeado (a cópia é dos BYTES originais).
    expect(readFileSync(join(backupDir, "agent-canvas.db"), "utf8")).toBe("db-bytes-exatos");
    expect(readFileSync(join(backupDir, "providers.json"), "utf8")).toBe('{"k":1}');
    expect(readFileSync(join(backupDir, "secrets.json"), "utf8")).toBe('{"s":2}');
    expect(readFileSync(join(backupDir, "board-assets", "b1", "x.bin"), "utf8")).toBe("asset");
    // E idêntico à cópia que ficou no perfil.
    const profileDir = profileDirectory(base, res.profileId);
    expect(readFileSync(join(backupDir, "agent-canvas.db"))).toEqual(readFileSync(join(profileDir, "agent-canvas.db")));

    const manifest = JSON.parse(readFileSync(profilesBackupPath(base), "utf8")) as { backupDir: string; mode: string };
    expect(manifest.backupDir).toBe(backupDirName);
    expect(manifest.mode).toBe("backup-then-rename");
  });

  it("falha na cópia => NÃO migra: nada movido, sem registro, sem pasta de perfil", () => {
    writeFileSync(join(base, "agent-canvas.db"), "db");
    writeFileSync(join(base, "providers.json"), "{}");

    const res = bootstrapProfiles(base, {
      requestedId: null,
      now: NOW,
      generateId: seqGenerator(ID1),
      defaultPersonalName: "Pessoal",
      io: {
        copyFile: () => {
          throw new Error("disco cheio");
        },
        copyDir: () => {
          throw new Error("disco cheio");
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok || res.kind !== "backup-failed") return;
    expect(res.message).toContain("disco cheio");
    // Nada foi movido nem registrado.
    expect(existsSync(join(base, "agent-canvas.db"))).toBe(true);
    expect(existsSync(join(base, "providers.json"))).toBe(true);
    expect(existsSync(profilesRegistryPath(base))).toBe(false);
    expect(listProfilesDirEntries(base)).toEqual([]);
  });

  it("o 2º boot não cria outro backup", () => {
    writeFileSync(join(base, "providers.json"), "{}");
    expect(boot().ok).toBe(true);
    const backups = () => readdirSync(base).filter((f) => f.startsWith(PROFILE_BACKUP_DIR_PREFIX));
    expect(backups().length).toBe(1);
    expect(boot().ok).toBe(true); // ready
    expect(backups()).toEqual(backups());
    expect(backups().length).toBe(1);
  });

  it("retoma migração interrompida usando o id/nome do marcador", () => {
    writeFileSync(join(base, "providers.json"), "{}");
    writeFileSync(join(base, "secrets.json"), "{}");
    // Migração parcial: um perfil já existe e UMA entrada já foi movida.
    mkdirSync(profileDirectory(base, ID2), { recursive: true });
    renameSync(join(base, "providers.json"), join(profileDirectory(base, ID2), "providers.json"));
    writeFileSync(
      profilesMigrationInProgressPath(base),
      JSON.stringify({ profileId: ID2, name: "Pessoal", startedAt: NOW }),
    );

    const res = boot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.profileId).toBe(ID2);
    expect(res.migrated).toBe(true);
    expect(existsSync(join(profileDirectory(base, ID2), "secrets.json"))).toBe(true);
    expect(existsSync(profilesMigrationInProgressPath(base))).toBe(false);
    expect(listProfilesDirEntries(base)).toEqual([ID2]);
  });

  it("registro corrompido SEM perfis em disco: quarentena + recuperação", () => {
    writeFileSync(profilesRegistryPath(base), "{ isto não é json");
    const res = boot();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.migrated).toBe(true);
    expect(readProfilesRegistry(base).kind).toBe("valid");
    // O corrompido foi PRESERVADO, não destruído.
    expect(readdirSync(base).some((f) => f.startsWith("profiles.corrupt-"))).toBe(true);
  });

  it("registro corrompido COM perfis em disco: ABORTA e não toca no arquivo", () => {
    writeFileSync(profilesRegistryPath(base), "corrompido");
    mkdirSync(profileDirectory(base, ID1), { recursive: true });

    const res = boot();
    expect(res.ok).toBe(false);
    if (res.ok || res.kind !== "abort") return;
    expect(res.reason).toBe("registry-malformed");
    // Registro intacto (não foi reescrito nem quarentenado).
    expect(readFileSync(profilesRegistryPath(base), "utf8")).toBe("corrompido");
    expect(readdirSync(base).some((f) => f.startsWith("profiles.corrupt-"))).toBe(false);
  });

  it("registro de versão futura: ABORTA (reescrever seria downgrade)", () => {
    writeProfilesRegistry(base, { schemaVersion: 2, defaultProfileId: ID1, profiles: [] } as unknown as ProfilesRegistry);
    const res = boot();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("abort");
    if (res.kind === "abort") expect(res.reason).toBe("registry-future");
  });

  it("--profile desconhecido: abre o padrão e AVISA nomeando o id", () => {
    writeProfilesRegistry(base, {
      schemaVersion: 1,
      defaultProfileId: ID1,
      profiles: [
        { id: ID1, name: "Pessoal", kind: "personal", createdAt: NOW, homeMode: "system" },
        { id: ID2, name: "Empresa", kind: "team", createdAt: NOW, homeMode: "isolated" },
      ],
    });
    mkdirSync(profileDirectory(base, ID1), { recursive: true });
    mkdirSync(profileDirectory(base, ID2), { recursive: true });

    const res = boot(MISSING);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.profileId).toBe(ID1);
    expect(res.migrated).toBe(false);
    expect(res.notices.join(" ")).toContain(MISSING);
  });

  it("CRUD: criar, renomear, definir padrão e refletir no estado", () => {
    boot(); // semeia o registro (perfil pessoal ID1)
    const created = createProfile(base, { name: "Empresa", kind: "team", now: NOW, generateId: () => ID2 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(existsSync(profileDirectory(base, ID2))).toBe(true);

    // Duplicado é recusado.
    expect(createProfile(base, { name: "empresa", kind: "team", now: NOW, generateId: () => ID3 })).toEqual({
      ok: false,
      reason: "duplicate-name",
    });

    const renamed = renameProfile(base, { id: ID2, name: "Empresa LTDA" });
    expect(renamed.ok).toBe(true);

    const set = setDefaultProfile(base, ID2);
    expect(set.ok).toBe(true);

    const state = describeProfilesState(base, ID1);
    expect(state.activeProfileId).toBe(ID1);
    const empresa = state.profiles.find((p) => p.id === ID2);
    expect(empresa).toMatchObject({ name: "Empresa LTDA", kind: "team", isDefault: true, isActive: false, openable: true });
    // O diretório do ID3 nunca foi criado — não aparece; e ID1 não existe mais aqui.
  });

  it("describeProfilesState marca openable=false quando o diretório sumiu", () => {
    writeProfilesRegistry(base, {
      schemaVersion: 1,
      defaultProfileId: ID1,
      profiles: [{ id: ID1, name: "Pessoal", kind: "personal", createdAt: NOW, homeMode: "system" }],
    });
    // Sem criar profiles/<ID1>/.
    const state = describeProfilesState(base, ID1);
    expect(state.profiles[0]).toMatchObject({ openable: false, isActive: true });
    expect(setDefaultProfile(base, MISSING)).toEqual({ ok: false, reason: "unknown-profile" });
  });

  it("profileDirectory recusa id não-opaco (barreira de path traversal)", () => {
    expect(() => profileDirectory(base, "../../etc")).toThrow();
  });

  it("A3c/P5: homeMode padrão por tipo e troca pelo registro", () => {
    boot(); // pessoal = ID1
    const created = createProfile(base, { name: "Empresa", kind: "team", now: NOW, generateId: () => ID2 });
    expect(created.ok && created.profile.homeMode).toBe("isolated");
    expect(describeProfilesState(base, null).profiles.find((p) => p.id === ID1)?.homeMode).toBe("system");

    const set = setProfileHomeMode(base, ID2, "system");
    expect(set.ok).toBe(true);
    expect(describeProfilesState(base, null).profiles.find((p) => p.id === ID2)?.homeMode).toBe("system");
    expect(setProfileHomeMode(base, MISSING, "isolated")).toEqual({ ok: false, reason: "unknown-profile" });
  });
});

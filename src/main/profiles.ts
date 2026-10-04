/**
 * Perfis locais — a casca com I/O (BACKEND_V1.md §3 / §7.1).
 *
 * Este módulo é o ÚNICO lugar que toca o disco do registro de perfis e a
 * migração da raiz para o perfil pessoal. A decisão (pura, testável) mora em
 * `profiles-decision.ts`; aqui só há efeito colateral, com a postura do repo:
 * escrita atômica (tmp + rename), nada é apagado sem preservar, e renomear
 * (nunca copiar) evita duplicar um banco grande e mantém cada passo atômico.
 *
 * O QUE É DA MÁQUINA (fica na RAIZ do userData, fora de qualquer perfil):
 *  - `profiles.json`              — o registro (este arquivo).
 *  - `profiles/`                  — um subdiretório por perfil.
 *  - `local-identity.json`        — `user_id` + `install_id`, iguais em todos
 *    os perfis (§3, item 5). Uma cópia por perfil é semeada/manida pela casca
 *    de identidade (`local-identity.ts`), que sempre cai neste canônico.
 *  - `locale.json`                — idioma do humano (não é dado de board).
 *  - `.profiles-migration-in-progress` / `profiles-migration.backup.json`.
 *
 * O QUE É DO PERFIL (vai para `profiles/<id>/`):
 *  `agent-canvas.db(+wal+shm)`, `providers.json` + `providers.schema.json`,
 *  `secrets.json`, `board-assets/`, `remote-devices.json`,
 *  `spawn-profiles.json`, `update-prefs.json`, `local-identity.json` e o
 *  `sessionData` (caches/cookies/localStorage do Chromium — isolamento do §3).
 *
 * A MIGRAÇÃO não copia: RENOMEIA cada entrada da raiz para dentro do perfil,
 * uma a uma (atômico por entrada). Um crash no meio deixa o marcador
 * `.profiles-migration-in-progress` e o próximo boot RETOMA movendo só o que
 * falta — nenhuma entrada é perdida nem duplicada. O
 * `profiles-migration.backup.json` grava o que foi movido (a receita de
 * reversão). O registro é escrito POR ÚLTIMO: um boot posterior que o veja
 * válido considera a migração concluída.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOpaqueId } from "./local-identity-decision";
import { isProviderHomeMode, type ProviderHomeMode } from "./config-home-decision";
import {
  createProfileEntry,
  defaultHomeModeForKind,
  describeProfilesBootstrapAbort,
  describeUnknownProfile,
  decideProfilesBootstrap,
  inspectProfilesRegistry,
  isValidProfileName,
  normalizeProfileName,
  parseProfilesRegistry,
  resolveProfileSelection,
  validateNewProfile,
  validateRenameProfile,
  PROFILES_DIR_NAME,
  PROFILES_MIGRATION_BACKUP_FILENAME,
  PROFILES_MIGRATION_IN_PROGRESS,
  PROFILES_REGISTRY_FILENAME,
  PROFILES_REGISTRY_QUARANTINE_PREFIX,
  PROFILES_REGISTRY_SCHEMA_VERSION,
  type NewProfileRejection,
  type ProfileEntry,
  type ProfileKind,
  type ProfilesBootstrapDecision,
  type ProfilesRegistry,
} from "./profiles-decision";

export { PROFILES_REGISTRY_FILENAME, PROFILES_DIR_NAME, type ProfileEntry, type ProfileKind, type ProfilesRegistry };

/** Entradas da RAIZ que pertencem a um perfil e migram para `profiles/<id>/`.
 *  `local-identity.json` e `locale.json` NÃO estão aqui: são da máquina. */
export const PROFILE_MIGRATE_ENTRIES = [
  "agent-canvas.db",
  "agent-canvas.db-wal",
  "agent-canvas.db-shm",
  "providers.json",
  "providers.schema.json",
  "secrets.json",
  "remote-devices.json",
  "spawn-profiles.json",
  "update-prefs.json",
  "board-assets",
] as const;

/**
 * Entradas copiadas para a pasta de backup ANTES de qualquer rename — só o
 * que carrega DADO DO USUÁRIO. `providers.schema.json` (reescrito a cada boot)
 * e `update-prefs.json` (preferência trivial, regenerável) ficam de fora: não
 * são dado a preservar. O patch `agent-canvas.db` + `-wal` + `-shm` é copiado
 * como unidade.
 */
export const PROFILE_BACKUP_ENTRIES = [
  "agent-canvas.db",
  "agent-canvas.db-wal",
  "agent-canvas.db-shm",
  "providers.json",
  "secrets.json",
  "spawn-profiles.json",
  "remote-devices.json",
  "board-assets",
] as const;

/** Prefixo da pasta de backup, na raiz (nunca apagada automaticamente). */
export const PROFILE_BACKUP_DIR_PREFIX = "profiles-migration-backup-";

/** Seams de I/O injetáveis (teste de falha de cópia); em produção, fs real. */
export type ProfileMigrationIo = {
  copyFile: (src: string, dest: string) => void;
  copyDir: (src: string, dest: string) => void;
};

export function profilesRegistryPath(baseUserDataDir: string): string {
  return join(baseUserDataDir, PROFILES_REGISTRY_FILENAME);
}

export function profilesRootDir(baseUserDataDir: string): string {
  return join(baseUserDataDir, PROFILES_DIR_NAME);
}

/**
 * Caminho do diretório de UM perfil. Recusa um id não-opaco: o id vem do
 * registro (já validado), mas derivar caminho de string arbitrária é a classe
 * de bug que permite `../` — aqui a barreira é explícita.
 */
export function profileDirectory(baseUserDataDir: string, profileId: string): string {
  if (!isOpaqueId(profileId)) {
    throw new Error(`profileDirectory: id não-opaco recusado (${JSON.stringify(profileId)})`);
  }
  return join(profilesRootDir(baseUserDataDir), profileId);
}

export function profilesMigrationInProgressPath(baseUserDataDir: string): string {
  return join(baseUserDataDir, PROFILES_MIGRATION_IN_PROGRESS);
}

export function profilesBackupPath(baseUserDataDir: string): string {
  return join(baseUserDataDir, PROFILES_MIGRATION_BACKUP_FILENAME);
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Existe mas não deu para ler: string vazia cai em malformed na decisão,
    // que pede quarentena/aborto — nunca "ausente" por engano.
    return "";
  }
}

export type RegistryReadResult =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  | { kind: "future"; version: number }
  | { kind: "valid"; registry: ProfilesRegistry };

export function readProfilesRegistry(baseUserDataDir: string): RegistryReadResult {
  return inspectProfilesRegistry(readIfExists(profilesRegistryPath(baseUserDataDir)));
}

export function writeProfilesRegistry(baseUserDataDir: string, registry: ProfilesRegistry): void {
  const path = profilesRegistryPath(baseUserDataDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Nomes dos subdiretórios em `profiles/`, ordenados. */
export function listProfilesDirEntries(baseUserDataDir: string): string[] {
  const dir = profilesRootDir(baseUserDataDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function quarantineRegistry(baseUserDataDir: string, now: number): string | null {
  const path = profilesRegistryPath(baseUserDataDir);
  if (!existsSync(path)) return null;
  const quarantinePath = join(baseUserDataDir, `${PROFILES_REGISTRY_QUARANTINE_PREFIX}${now}.json`);
  renameSync(path, quarantinePath);
  return quarantinePath;
}

export function profilesBackupDir(baseUserDataDir: string, name: string): string {
  return join(baseUserDataDir, name);
}

type MigrationMarker = { profileId: string | null; name: string | null; startedAt: number; backupDir: string | null };

function readMigrationMarker(baseUserDataDir: string): MigrationMarker | null {
  const raw = readIfExists(profilesMigrationInProgressPath(baseUserDataDir));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      profileId: isOpaqueId(parsed.profileId) ? parsed.profileId : null,
      name: isValidProfileName(parsed.name) ? normalizeProfileName(parsed.name) : null,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      backupDir: typeof parsed.backupDir === "string" && parsed.backupDir.startsWith(PROFILE_BACKUP_DIR_PREFIX) ? parsed.backupDir : null,
    };
  } catch {
    return null;
  }
}

function writeMigrationMarker(baseUserDataDir: string, marker: MigrationMarker): void {
  const path = profilesMigrationInProgressPath(baseUserDataDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Cópia de SEGURANÇA (os bytes, não só a receita) para
 * `<raiz>/profiles-migration-backup-<ts>/`. Roda ANTES do primeiro rename e é
 * o que o contrato chama de "cópia de segurança". A fonte de cada entrada é a
 * RAIZ e, numa RETOMADA, o próprio perfil (a entrada já movida) — o backup
 * fica completo independentemente de onde a migração parou.
 *
 * COPIAR O BANCO AQUI É SEGURO: este passo é o bootstrap pré-ready, antes de
 * `openStore` — nenhum processo abriu a base, então copiar `.db` + `-wal` +
 * `-shm` como arquivos (sem checkpoint) preserva o estado exato. Não chamar
 * `better-sqlite3` aqui.
 *
 * Lança em falha (disco cheio/permissão); o chamador decide NÃO migrar. A
 * pasta é criada com `recursive` e sobrescreve um backup parcial, então uma
 * retomada reusa a mesma pasta em vez de acumular backups.
 */
function copyUserDataBackup(baseUserDataDir: string, profileDestDir: string, backupDir: string, io: ProfileMigrationIo): string[] {
  mkdirSync(backupDir, { recursive: true });
  const copied: string[] = [];
  for (const entry of PROFILE_BACKUP_ENTRIES) {
    const atRoot = join(baseUserDataDir, entry);
    const inProfile = join(profileDestDir, entry);
    const src = existsSync(atRoot) ? atRoot : existsSync(inProfile) ? inProfile : null;
    if (src === null) continue;
    const dest = join(backupDir, entry);
    if (entry === "board-assets") io.copyDir(src, dest);
    else io.copyFile(src, dest);
    copied.push(entry);
  }
  return copied;
}

/**
 * BACKUP (cópia dos bytes) + MOVE das entradas de perfil da raiz para
 * `profiles/<id>/`, nesta ordem: marcador → backup → rename por entrada
 * (atômico, idempotente) → manifesto → registro. Se o BACKUP falha, NÃO
 * migra: devolve `backup-failed` para o boot abrir no layout antigo.
 */
function migrateRootIntoProfile(
  baseUserDataDir: string,
  target: { id: string; name: string; backupDir: string },
  now: number,
  reason: ProfilesBootstrapDecision & { action: "migrate" },
  io: ProfileMigrationIo,
): { ok: true; registry: ProfilesRegistry; entriesMoved: string[] } | { ok: false; kind: "backup-failed"; message: string } {
  const destDir = profileDirectory(baseUserDataDir, target.id);

  // Marcador ANTES de mover/copiar qualquer byte: um crash aqui faz o próximo
  // boot retomar reusando id/nome E a MESMA pasta de backup (não cria outra).
  writeMigrationMarker(baseUserDataDir, {
    profileId: target.id,
    name: target.name,
    startedAt: now,
    backupDir: target.backupDir,
  });

  // (1) CÓPIA DE SEGURANÇA antes do primeiro rename. Falhou => NÃO migra.
  const backupDir = profilesBackupDir(baseUserDataDir, target.backupDir);
  let backupEntries: string[];
  try {
    backupEntries = copyUserDataBackup(baseUserDataDir, destDir, backupDir, io);
  } catch (e) {
    const message =
      `[stellar] cópia de segurança falhou (${e instanceof Error ? e.message : String(e)}) em ${backupDir} — ` +
      `migração de perfis NÃO foi feita; abrindo no layout ANTERIOR. Nada foi perdido, e o backup parcial ` +
      `(se houver) fica onde está — não é apagado. Libere espaço/corrija a permissão e reabra para migrar.`;
    return { ok: false, kind: "backup-failed", message };
  }

  // (2) MOVE — rename atômico por entrada. O diretório do perfil só nasce
  // agora: uma falha de backup acima não deixa pasta de perfil vazia.
  mkdirSync(destDir, { recursive: true });
  const movedNow: string[] = [];
  for (const entry of PROFILE_MIGRATE_ENTRIES) {
    const src = join(baseUserDataDir, entry);
    const dest = join(destDir, entry);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) continue; // retomada: já foi movido
    renameSync(src, dest);
    movedNow.push(entry);
  }

  const inProfile = PROFILE_MIGRATE_ENTRIES.filter((entry) => existsSync(join(destDir, entry)));
  const manifest = {
    from: baseUserDataDir,
    profileId: target.id,
    name: target.name,
    at: now,
    reason: reason.reason,
    mode: "backup-then-rename",
    /** Pasta com a CÓPIA DOS BYTES dos dados do usuário (reversão completa). */
    backupDir: target.backupDir,
    backupEntries,
    /** Entradas que ficaram no perfil. */
    entries: [...inProfile],
  };
  const manifestPath = profilesBackupPath(baseUserDataDir);
  const manifestTmp = `${manifestPath}.tmp`;
  writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(manifestTmp, manifestPath);

  const registry: ProfilesRegistry = {
    schemaVersion: PROFILES_REGISTRY_SCHEMA_VERSION,
    defaultProfileId: target.id,
    profiles: [createProfileEntry(target.id, target.name, "personal", now)],
  };
  writeProfilesRegistry(baseUserDataDir, registry);
  rmSync(profilesMigrationInProgressPath(baseUserDataDir), { force: true });
  return { ok: true, registry, entriesMoved: [...inProfile] };
}

/** Escolhe o alvo da retomada: id/nome/backup do marcador, senão o único
 *  perfil em disco, senão um novo. Nunca inventa um nome — usa o padrão. */
function resolveResumeTarget(
  baseUserDataDir: string,
  marker: MigrationMarker | null,
  generateId: () => string,
  defaultPersonalName: string,
  now: number,
): { id: string; name: string; backupDir: string } {
  const freshBackupDir = `${PROFILE_BACKUP_DIR_PREFIX}${now}`;
  if (marker?.profileId) {
    return { id: marker.profileId, name: marker.name ?? defaultPersonalName, backupDir: marker.backupDir ?? freshBackupDir };
  }
  const dirs = listProfilesDirEntries(baseUserDataDir);
  if (dirs.length === 1 && isOpaqueId(dirs[0])) {
    return { id: dirs[0], name: defaultPersonalName, backupDir: marker?.backupDir ?? freshBackupDir };
  }
  return { id: generateId(), name: defaultPersonalName, backupDir: freshBackupDir };
}

export type ProfilesBootstrapResult =
  | {
      ok: true;
      migrated: boolean;
      registry: ProfilesRegistry;
      profileId: string;
      profileDir: string;
      entriesMoved: string[];
      /** Avisos honestos para o stderr (id pedido desconhecido, objetivo). */
      notices: string[];
    }
  | { ok: false; kind: "abort"; reason: "registry-malformed" | "registry-future"; message: string }
  | { ok: false; kind: "backup-failed"; message: string }
  | { ok: false; kind: "error"; message: string };

/**
 * O passo de boot dos perfis. SÍNCRONO de propósito: `app.setPath` de
 * `userData`/`sessionData` só tem efeito antes do evento `ready`, então isto
 * roda no topo do módulo (antes de `whenReady`). Devolve o diretório do perfil
 * a abrir; o chamador faz `app.setPath`. `io` é injetável só para o teste de
 * falha de cópia (em produção usa o fs real).
 */
export function bootstrapProfiles(
  baseUserDataDir: string,
  opts: {
    requestedId: string | null;
    now: number;
    generateId: () => string;
    defaultPersonalName: string;
    io?: ProfileMigrationIo;
  },
): ProfilesBootstrapResult {
  const io: ProfileMigrationIo = opts.io ?? {
    copyFile: (src, dest) => copyFileSync(src, dest),
    // `force: true` de propósito: uma retomada sobrescreve o backup parcial
    // (mesma pasta) em vez de falhar ou acumular pastas de backup.
    copyDir: (src, dest) => cpSync(src, dest, { recursive: true, force: true }),
  };
  const registryPath = profilesRegistryPath(baseUserDataDir);
  const notices: string[] = [];

  try {
    const finding = readProfilesRegistry(baseUserDataDir);
    const decision = decideProfilesBootstrap({
      registry: finding.kind,
      inProgress: existsSync(profilesMigrationInProgressPath(baseUserDataDir)),
      profilesDirHasEntries: listProfilesDirEntries(baseUserDataDir).length > 0,
      rootHasProfileData: PROFILE_MIGRATE_ENTRIES.some((entry) => existsSync(join(baseUserDataDir, entry))),
    });

    if (decision.action === "abort") {
      return {
        ok: false,
        kind: "abort",
        reason: decision.reason,
        message: describeProfilesBootstrapAbort(decision.reason, { baseDir: baseUserDataDir, registryPath, quarantinePath: null }),
      };
    }

    let registry: ProfilesRegistry;
    let migrated = false;
    let entriesMoved: string[] = [];

    if (decision.action === "ready") {
      if (finding.kind !== "valid") {
        // Inalcançável pela decisão (ready só vem de valid); guarda de tipo.
        return { ok: false, kind: "error", message: `estado inconsistente: ready com registro ${finding.kind}` };
      }
      registry = finding.registry;
      // Crash entre escrever o registro e apagar o marcador deixa lixo.
      rmSync(profilesMigrationInProgressPath(baseUserDataDir), { force: true });
    } else {
      if (finding.kind === "malformed") quarantineRegistry(baseUserDataDir, opts.now);
      const marker = readMigrationMarker(baseUserDataDir);
      const target = resolveResumeTarget(baseUserDataDir, marker, opts.generateId, opts.defaultPersonalName, opts.now);
      if (!isOpaqueId(target.id)) {
        return { ok: false, kind: "error", message: "generateId devolveu id não-opaco — recusado" };
      }
      const done = migrateRootIntoProfile(baseUserDataDir, target, opts.now, decision, io);
      if (!done.ok) return done; // backup-failed: o boot abre no layout antigo
      registry = done.registry;
      migrated = true;
      entriesMoved = done.entriesMoved;
    }

    const selection = resolveProfileSelection(registry, opts.requestedId);
    if (!selection.ok) {
      return { ok: false, kind: "error", message: "registro sem nenhum perfil utilizável" };
    }

    const opened = registry.profiles.find((p) => p.id === selection.profileId);
    if (opened && selection.usedFallback && selection.reason === "unknown-profile" && opts.requestedId) {
      notices.push(describeUnknownProfile(opts.requestedId, opened.name));
    }
    if (opened && selection.usedFallback && selection.reason === "no-default") {
      notices.push(`[stellar] profiles.json não declara padrão — abrindo "${opened.name}".`);
    }

    const profileDir = profileDirectory(baseUserDataDir, selection.profileId);
    mkdirSync(profileDir, { recursive: true });
    return { ok: true, migrated, registry, profileId: selection.profileId, profileDir, entriesMoved, notices };
  } catch (err) {
    return { ok: false, kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export type ProfileView = {
  id: string;
  name: string;
  kind: ProfileKind;
  createdAt: number;
  /** A3c/P5 — casa das CLIs deste perfil (`system` ou `isolated`). */
  homeMode: ProviderHomeMode;
  isDefault: boolean;
  isActive: boolean;
  /** O diretório existe? A UI não oferece "trocar" para um perfil sumido. */
  openable: boolean;
};

export type ProfilesState = {
  registryPath: string;
  activeProfileId: string | null;
  profiles: ProfileView[];
};

/**
 * Estado para o seletor da Home. Registro ausente/corrompido não vira lista
 * vazia silenciosa: `registry` fica `null` e a UI diz que não deu para ler.
 */
export function describeProfilesState(baseUserDataDir: string, activeProfileId: string | null): ProfilesState {
  const finding = readProfilesRegistry(baseUserDataDir);
  if (finding.kind !== "valid") {
    return { registryPath: profilesRegistryPath(baseUserDataDir), activeProfileId, profiles: [] };
  }
  const registry = finding.registry;
  return {
    registryPath: profilesRegistryPath(baseUserDataDir),
    activeProfileId,
    profiles: registry.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      createdAt: p.createdAt,
      homeMode: p.homeMode,
      isDefault: registry.defaultProfileId === p.id,
      isActive: activeProfileId === p.id,
      openable: existsSync(profileDirectory(baseUserDataDir, p.id)),
    })),
  };
}

export type CreateProfileResult =
  | { ok: true; registry: ProfilesRegistry; profile: ProfileEntry }
  | { ok: false; reason: NewProfileRejection | "no-registry" | "generate-failed" };

export function createProfile(
  baseUserDataDir: string,
  opts: { name: string; kind: ProfileKind; now: number; generateId: () => string; homeMode?: ProviderHomeMode },
): CreateProfileResult {
  const finding = readProfilesRegistry(baseUserDataDir);
  if (finding.kind !== "valid") return { ok: false, reason: "no-registry" };
  const validation = validateNewProfile(finding.registry, opts.name);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const id = opts.generateId();
  if (!isOpaqueId(id)) return { ok: false, reason: "generate-failed" };

  mkdirSync(profileDirectory(baseUserDataDir, id), { recursive: true });
  const homeMode = isProviderHomeMode(opts.homeMode) ? opts.homeMode : defaultHomeModeForKind(opts.kind);
  const profile = createProfileEntry(id, validation.name, opts.kind, opts.now, homeMode);
  const registry: ProfilesRegistry = {
    ...finding.registry,
    profiles: [...finding.registry.profiles, profile],
  };
  writeProfilesRegistry(baseUserDataDir, registry);
  return { ok: true, registry, profile };
}

export type SetHomeModeResult = { ok: true; registry: ProfilesRegistry } | { ok: false; reason: "unknown-profile" | "no-registry" };

/** A3c/P5 — troca o modo de casa (`system`/`isolated`) de um perfil. */
export function setProfileHomeMode(baseUserDataDir: string, id: string, mode: ProviderHomeMode): SetHomeModeResult {
  const finding = readProfilesRegistry(baseUserDataDir);
  if (finding.kind !== "valid") return { ok: false, reason: "no-registry" };
  if (!finding.registry.profiles.some((p) => p.id === id)) return { ok: false, reason: "unknown-profile" };
  const registry: ProfilesRegistry = {
    ...finding.registry,
    profiles: finding.registry.profiles.map((p) => (p.id === id ? { ...p, homeMode: mode } : p)),
  };
  writeProfilesRegistry(baseUserDataDir, registry);
  return { ok: true, registry };
}

export type RenameProfileResult =
  | { ok: true; registry: ProfilesRegistry; profile: ProfileEntry }
  | { ok: false; reason: "invalid-name" | "duplicate-name" | "unknown-profile" | "no-registry" };

export function renameProfile(
  baseUserDataDir: string,
  opts: { id: string; name: string },
): RenameProfileResult {
  const finding = readProfilesRegistry(baseUserDataDir);
  if (finding.kind !== "valid") return { ok: false, reason: "no-registry" };
  const validation = validateRenameProfile(finding.registry, opts.id, opts.name);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const registry: ProfilesRegistry = {
    ...finding.registry,
    profiles: finding.registry.profiles.map((p) => (p.id === opts.id ? { ...p, name: validation.name } : p)),
  };
  writeProfilesRegistry(baseUserDataDir, registry);
  return { ok: true, registry, profile: registry.profiles.find((p) => p.id === opts.id)! };
}

export function setDefaultProfile(baseUserDataDir: string, id: string): { ok: boolean; reason?: "unknown-profile" | "no-registry" } {
  const finding = readProfilesRegistry(baseUserDataDir);
  if (finding.kind !== "valid") return { ok: false, reason: "no-registry" };
  if (!finding.registry.profiles.some((p) => p.id === id)) return { ok: false, reason: "unknown-profile" };
  writeProfilesRegistry(baseUserDataDir, { ...finding.registry, defaultProfileId: id });
  return { ok: true };
}

/** Reexport para testes da casca — evita depender do módulo puro no teste de I/O. */
export const __parseProfilesRegistry = parseProfilesRegistry;

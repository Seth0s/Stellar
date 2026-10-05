/**
 * Perfis locais (BACKEND_V1.md §3 / §7.1) — a DECISÃO, sem I/O.
 *
 * Um PERFIL é um diretório próprio dentro do `userData` que guarda o estado
 * por pessoa (banco de boards/cards, providers, secrets, board-assets…). O que
 * é da MÁQUINA — o registro de perfis, a identidade (`user_id`/`install_id`),
 * o idioma do app e as próprias pastas — fica na RAIZ do `userData`, fora de
 * qualquer perfil. A divisão completa está em `profiles.ts` (a casca com I/O).
 *
 * Este módulo é PURO (sem fs, sem Date.now implícito): recebe o que foi
 * encontrado em disco e o que o processo foi lançado a pedir, e diz o que
 * fazer. A casca com I/O é `profiles.ts`. Mesma divisão de
 * `local-identity-decision.ts` / `local-identity.ts` e
 * `single-instance-decision.ts` — decisão testável em unidade, efeito
 * colateral do lado de fora.
 *
 * Postura (taste do board): ausência declarada, nunca valor inventado. Um
 * `--profile` desconhecido NÃO vira o padrão em silêncio — a seleção marca
 * `usedFallback` e o motivo, e a casca AVISA nomeando o id pedido. Um
 * registro `profiles.json` de versão futura NUNCA é reescrito; um corrompido
 * só é recuperado quando não há perfis em disco para perder.
 */

import { isOpaqueId } from "./local-identity-decision";
import { isProviderHomeMode, type ProviderHomeMode } from "./config-home-decision";

/** Nome do registro, na raiz do userData (ao lado de `profiles/`). */
export const PROFILES_REGISTRY_FILENAME = "profiles.json";
/** Diretório que contém um subdiretório por perfil. */
export const PROFILES_DIR_NAME = "profiles";
export const PROFILES_REGISTRY_SCHEMA_VERSION = 1;
/** Marcador de migração em andamento, na raiz. Existe = migração começou e
 *  não terminou; o próximo boot RETOMA (renomear é idempotente por entrada). */
export const PROFILES_MIGRATION_IN_PROGRESS = ".profiles-migration-in-progress";
/** Manifesto do que a migração moveu — a "cópia de segurança" reversível.
 *  Renomear não duplica bytes nem perde nada; o manifesto torna a reversão
 *  mecânica e deixa auditável de qual raiz para qual perfil os dados foram. */
export const PROFILES_MIGRATION_BACKUP_FILENAME = "profiles-migration.backup.json";
/** Prefixo da quarentena do registro corrompido (a casca completa com ts). */
export const PROFILES_REGISTRY_QUARANTINE_PREFIX = "profiles.corrupt-";

/** Forma longa aceita: `--profile=<id>` e `--profile <id>` (a última vence). */
export const PROFILE_ARG = "--profile";

export const MAX_PROFILE_NAME_LENGTH = 60;
export const MAX_PROFILES = 50;

export type ProfileKind = "personal" | "team";
export const PROFILE_KINDS: readonly ProfileKind[] = ["personal", "team"];

export function isProfileKind(value: unknown): value is ProfileKind {
  return typeof value === "string" && (PROFILE_KINDS as readonly string[]).includes(value);
}

/**
 * The link between a team profile and the account team. Stored in the LOCAL
 * registry (the server holds its own truth) only so the app knows which team
 * house to pull and which slug to use in the prefix of materialized files.
 */
export type ProfileTeam = {
  id: string;
  slug: string;
  name: string;
};

export type ProfileEntry = {
  /** `profile_id` (§3) — opaco, é também o nome da pasta em `profiles/`. */
  id: string;
  /** Nome exibido, editável. Nunca vazio. */
  name: string;
  kind: ProfileKind;
  createdAt: number;
  /**
   * A3c/P5 — casa das CLIs: `system` (padrão do pessoal) ou `isolated`
   * (padrão de time). Ausente no arquivo é derivado do `kind`, para o
   * `profiles.json` da A1 continuar válido sem bump de versão.
   */
  homeMode: ProviderHomeMode;
  /**
   * Team of the account this profile belongs to. PRESENT only on a linked team
   * profile; absent means a personal profile or a turned-off team. Absence is
   * absence: no team and no slug are invented.
   */
  team?: ProfileTeam;
  /**
   * `true` once the member left the team or was removed: the profile stays
   * LOCAL and OFF (nothing is deleted without confirmation). PRESENT only when
   * true.
   */
  detached?: boolean;
  /**
   * The id of this profile on the SERVER (`POST`/`GET /v1/profiles`), once the
   * local profile has been registered there. The local `id` stays the local
   * key (the folder name); this is the id every house sync must use — the
   * server never knows the local id. ABSENT until the first sync links it (or
   * the person picks one); absence is absence, never the local id as a guess.
   */
  cloudProfileId?: string;
};

/** O padrão por tipo de perfil (P5): pessoal no sistema, time isolado. */
export function defaultHomeModeForKind(kind: ProfileKind): ProviderHomeMode {
  return kind === "personal" ? "system" : "isolated";
}

export type ProfilesRegistry = {
  schemaVersion: number;
  /** `null` quando o arquivo não declara um padrão utilizável — a seleção
   *  cai no primeiro perfil e diz que caiu (nunca inventa um padrão). */
  defaultProfileId: string | null;
  profiles: ProfileEntry[];
};

/** Nome de perfil utilizável: não-vazio (após trim) e dentro do limite. */
export function isValidProfileName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_PROFILE_NAME_LENGTH;
}

export function normalizeProfileName(name: string): string {
  return name.trim();
}

function parseProfileTeam(value: unknown): ProfileTeam | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!isOpaqueId(rec.id)) return null;
  if (typeof rec.slug !== "string" || rec.slug.trim() === "") return null;
  if (!isValidProfileName(rec.name)) return null;
  return { id: rec.id, slug: rec.slug.trim(), name: normalizeProfileName(rec.name) };
}

function parseProfileEntry(value: unknown): ProfileEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!isOpaqueId(rec.id)) return null;
  if (!isValidProfileName(rec.name)) return null;
  if (!isProfileKind(rec.kind)) return null;
  const createdAt = rec.createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0) return null;
  // `homeMode` ausente (arquivo da A1) NÃO é inválido: deriva do `kind`.
  const homeMode: ProviderHomeMode = isProviderHomeMode(rec.homeMode) ? rec.homeMode : defaultHomeModeForKind(rec.kind);
  // Absent `team`/`detached` (an older registry file) do NOT invalidate the
  // entry: absence is absence. A malformed `team` is DROPPED, never repaired.
  const team = parseProfileTeam(rec.team);
  const base: ProfileEntry = { id: rec.id, name: normalizeProfileName(rec.name), kind: rec.kind, createdAt, homeMode };
  if (team) base.team = team;
  if (rec.detached === true) base.detached = true;
  // The server profile id is opaque (a UUID); a value that is not one is
  // DROPPED, never repaired into something plausible.
  if (isOpaqueId(rec.cloudProfileId)) base.cloudProfileId = rec.cloudProfileId;
  return base;
}

/**
 * Valida um registro na versão ATUAL. Entradas inválidas são descartadas
 * (nunca "consertadas" com um valor plausível); sem nenhuma entrada válida o
 * registro inteiro é recusado. `defaultProfileId` que não aponta para um
 * perfil existente vira `null` — ausência declarada, não um palpite.
 */
export function parseProfilesRegistry(raw: unknown): ProfilesRegistry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVersion !== PROFILES_REGISTRY_SCHEMA_VERSION) return null;
  if (!Array.isArray(rec.profiles)) return null;

  const seen = new Set<string>();
  const profiles: ProfileEntry[] = [];
  for (const entry of rec.profiles.slice(0, MAX_PROFILES * 2)) {
    const parsed = parseProfileEntry(entry);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    profiles.push(parsed);
    if (profiles.length >= MAX_PROFILES) break;
  }
  if (profiles.length === 0) return null;

  const defaultId = isOpaqueId(rec.defaultProfileId) && seen.has(rec.defaultProfileId) ? rec.defaultProfileId : null;
  return { schemaVersion: PROFILES_REGISTRY_SCHEMA_VERSION, defaultProfileId: defaultId, profiles };
}

export type ProfilesRegistryFinding =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  /** `schemaVersion` maior que a atual — um app mais novo escreveu isto.
   *  NUNCA reescrever: seria um downgrade destrutivo. */
  | { kind: "future"; version: number }
  | { kind: "valid"; registry: ProfilesRegistry };

/** Classifica o conteúdo cru do registro. `raw == null` = arquivo ausente. */
export function inspectProfilesRegistry(raw: string | null | undefined): ProfilesRegistryFinding {
  if (raw == null) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", reason: "não é JSON (truncado ou corrompido)" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "JSON não é um objeto" };
  }
  const version = (parsed as Record<string, unknown>).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { kind: "malformed", reason: "schemaVersion ausente ou não-inteiro" };
  }
  if (version > PROFILES_REGISTRY_SCHEMA_VERSION) {
    return { kind: "future", version };
  }
  if (version < PROFILES_REGISTRY_SCHEMA_VERSION) {
    return { kind: "malformed", reason: `schemaVersion ${version} < ${PROFILES_REGISTRY_SCHEMA_VERSION} (corrupção, não legado)` };
  }
  const registry = parseProfilesRegistry(parsed);
  if (!registry) {
    return { kind: "malformed", reason: "estrutura inválida (sem perfil utilizável, id/campos recusados)" };
  }
  return { kind: "valid", registry };
}

export type ProfilesBootstrapSnapshot = {
  registry: "absent" | "malformed" | "future" | "valid";
  /** Marcador de migração retomável presente na raiz. */
  inProgress: boolean;
  /** `profiles/` existe e não está vazio. */
  profilesDirHasEntries: boolean;
  /** A raiz tem dados que pertencem a um perfil (banco, providers…). */
  rootHasProfileData: boolean;
};

export type ProfilesBootstrapDecision =
  | { action: "ready" }
  | { action: "migrate"; reason: "first-boot" | "resume-interrupted" | "recover-malformed" }
  | { action: "abort"; reason: "registry-malformed" | "registry-future" };

/**
 * O gate do primeiro boot (e dos seguintes). Puro: o chamador monta o
 * snapshot e aplica o resultado.
 *
 * Regras, em ordem:
 *  - registro válido            => `ready` (nada a migrar; o marcador
 *    retomável, se sobrou de um crash entre escrever o registro e apagá-lo,
 *    é lixo e a casca o remove).
 *  - registro de versão futura  => `abort` (não reescrever às cegas).
 *  - registro corrompido        => `abort` se há perfis em disco (não dá para
 *    adivinhar nomes/padrão); senão `migrate` recuperando (quarentena + criar).
 *  - ausente + em andamento     => `migrate` retomando a migração interrompida.
 *  - ausente                    => `migrate` do primeiro boot (mover o que há
 *    na raiz para o perfil pessoal; raiz vazia = só semear o pessoal).
 */
export function decideProfilesBootstrap(snapshot: ProfilesBootstrapSnapshot): ProfilesBootstrapDecision {
  if (snapshot.registry === "valid") return { action: "ready" };
  if (snapshot.registry === "future") return { action: "abort", reason: "registry-future" };
  if (snapshot.registry === "malformed") {
    if (snapshot.profilesDirHasEntries) return { action: "abort", reason: "registry-malformed" };
    return { action: "migrate", reason: "recover-malformed" };
  }
  if (snapshot.inProgress) return { action: "migrate", reason: "resume-interrupted" };
  return { action: "migrate", reason: "first-boot" };
}

export type ProfileSelection =
  | { ok: true; profileId: string; usedFallback: false }
  | { ok: true; profileId: string; usedFallback: true; reason: "unknown-profile" | "no-default" }
  | { ok: false; reason: "empty-registry" };

/**
 * Escolhe o perfil a abrir. `requestedId` vem de `--profile=`. Sem flag, o
 * padrão do registro; padrão ausente cai no primeiro perfil. Um id pedido que
 * não existe cai no padrão/primeiro, mas diz que caiu — o chamador avisa
 * nomeando o id que a pessoa digitou (recusa útil, nunca silenciosa).
 */
export function resolveProfileSelection(
  registry: ProfilesRegistry,
  requestedId: string | null | undefined,
): ProfileSelection {
  if (registry.profiles.length === 0) return { ok: false, reason: "empty-registry" };

  const byId = (id: string | null): ProfileEntry | undefined =>
    id ? registry.profiles.find((p) => p.id === id) : undefined;

  if (requestedId) {
    const requested = byId(requestedId);
    if (requested) return { ok: true, profileId: requested.id, usedFallback: false };
    const fallback = byId(registry.defaultProfileId) ?? registry.profiles[0];
    return { ok: true, profileId: fallback.id, usedFallback: true, reason: "unknown-profile" };
  }

  const def = byId(registry.defaultProfileId);
  if (def) return { ok: true, profileId: def.id, usedFallback: false };
  return { ok: true, profileId: registry.profiles[0].id, usedFallback: true, reason: "no-default" };
}

/**
 * Lê `--profile=<id>` (ou `--profile <id>`) da linha de comando. A ÚLTIMA
 * ocorrência vence (um relaunch pode empilhar a flag); valor vazio é ausência.
 * O id NÃO é validado aqui — ele só é usado para casar com um perfil do
 * registro, então um valor arbitrário nunca vira caminho.
 */
export function parseProfileArg(argv: readonly string[]): string | null {
  let found: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === PROFILE_ARG) {
      const next = argv[i + 1];
      if (typeof next === "string" && next.trim().length > 0) {
        found = next.trim();
        i++;
      }
    } else if (arg.startsWith(`${PROFILE_ARG}=`)) {
      const value = arg.slice(PROFILE_ARG.length + 1).trim();
      if (value.length > 0) found = value;
    }
  }
  return found;
}

/**
 * Args para `app.relaunch` ao trocar de perfil: remove qualquer `--profile`
 * anterior (nas duas formas) e anexa um só, canônico. `appArgs` é
 * `process.argv.slice(1)` (sem o binário do Electron). Puro — testável sem
 * relançar nada.
 */
export function buildRelaunchArgs(appArgs: readonly string[], profileId: string): string[] {
  const kept: string[] = [];
  for (let i = 0; i < appArgs.length; i++) {
    const arg = appArgs[i];
    if (arg === PROFILE_ARG) {
      if (i + 1 < appArgs.length) i++;
      continue;
    }
    if (arg.startsWith(`${PROFILE_ARG}=`)) continue;
    kept.push(arg);
  }
  kept.push(`${PROFILE_ARG}=${profileId}`);
  return kept;
}

/** Nome de perfil novo é recusado se vazio, longo demais, repetido ou se o
 *  teto de perfis foi atingido — cada motivo com seu próprio código. */
export type NewProfileRejection = "invalid-name" | "duplicate-name" | "too-many";

export function validateNewProfile(
  registry: ProfilesRegistry,
  name: string,
): { ok: true; name: string } | { ok: false; reason: NewProfileRejection } {
  if (!isValidProfileName(name)) return { ok: false, reason: "invalid-name" };
  const normalized = normalizeProfileName(name);
  if (registry.profiles.length >= MAX_PROFILES) return { ok: false, reason: "too-many" };
  if (registry.profiles.some((p) => p.name.toLowerCase() === normalized.toLowerCase())) {
    return { ok: false, reason: "duplicate-name" };
  }
  return { ok: true, name: normalized };
}

/** Renomear mantém o id e recusa nome inválido/repetido (contra os OUTROS). */
export function validateRenameProfile(
  registry: ProfilesRegistry,
  id: string,
  name: string,
): { ok: true; name: string } | { ok: false; reason: "invalid-name" | "duplicate-name" | "unknown-profile" } {
  if (!registry.profiles.some((p) => p.id === id)) return { ok: false, reason: "unknown-profile" };
  if (!isValidProfileName(name)) return { ok: false, reason: "invalid-name" };
  const normalized = normalizeProfileName(name);
  if (registry.profiles.some((p) => p.id !== id && p.name.toLowerCase() === normalized.toLowerCase())) {
    return { ok: false, reason: "duplicate-name" };
  }
  return { ok: true, name: normalized };
}

export function createProfileEntry(
  id: string,
  name: string,
  kind: ProfileKind,
  createdAt: number,
  homeMode: ProviderHomeMode = defaultHomeModeForKind(kind),
): ProfileEntry {
  return { id, name: normalizeProfileName(name), kind, createdAt, homeMode };
}

/** A TEAM profile entry: kind `team`, `isolated` house and the team link. It
 *  never puts `team` on a profile that is not a team one. */
export function createTeamProfileEntry(
  id: string,
  name: string,
  createdAt: number,
  team: ProfileTeam,
  homeMode: ProviderHomeMode = "isolated",
): ProfileEntry {
  return { id, name: normalizeProfileName(name), kind: "team", createdAt, homeMode, team };
}

/** Local profile already linked to this team, if any. */
export function profileForTeam(registry: ProfilesRegistry, teamId: string): ProfileEntry | null {
  return registry.profiles.find((p) => p.team?.id === teamId) ?? null;
}

/**
 * Local name for a team's profile, avoiding a name already in use: the team
 * name, then "<name> (<slug>)" and finally a numeric suffix. What the person
 * sees on the Home screen is unique — a profile is never overwritten because of
 * a repeated name, and a different name is never invented silently.
 */
export function teamProfileName(registry: ProfilesRegistry, team: { name: string; slug: string }): string {
  const taken = new Set(registry.profiles.map((p) => p.name.toLowerCase()));
  const base = normalizeProfileName(team.name) || team.slug;
  const candidates = [base, `${base} (${team.slug})`, `${base} (2)`, `${base} (3)`];
  for (const candidate of candidates) {
    const trimmed = candidate.slice(0, MAX_PROFILE_NAME_LENGTH);
    if (isValidProfileName(trimmed) && !taken.has(trimmed.toLowerCase())) return trimmed;
  }
  return `${base} (${Date.now()})`.slice(0, MAX_PROFILE_NAME_LENGTH);
}

/**
 * Onde um perfil pode ser aberto. É a checagem que o seletor da Home usa para
 * NÃO oferecer "trocar" para um perfil cujo diretório sumiu — a UI mostra o
 * estado e diz o que falta em vez de fingir que abriu.
 */
export type ProfileOpenability =
  | { ok: true }
  | { ok: false; reason: "missing-directory" };

export function decideProfileOpenable(directoryExists: boolean): ProfileOpenability {
  return directoryExists ? { ok: true } : { ok: false, reason: "missing-directory" };
}

/**
 * A recusa da migração precisa ORIENTAR (taste: recusa útil). Diz qual
 * arquivo está no caminho, para onde o bytes bom iria e o que fazer por mão.
 */
export function describeProfilesBootstrapAbort(
  reason: "registry-malformed" | "registry-future",
  ctx: { baseDir: string; registryPath: string; quarantinePath?: string | null },
): string {
  const head = `[stellar] não vou abrir sem resolver o registro de perfis (${ctx.registryPath}).`;
  if (reason === "registry-future") {
    return (
      `${head} O arquivo é de uma versão MAIS NOVA do Stellar (schemaVersion maior) — este build não entende os campos dele e ` +
      `reescrevê-lo seria downgrade destrutivo. Abra com o app atualizado, ou mova ${ctx.registryPath} para fora se quiser começar de novo.`
    );
  }
  return (
    `${head} O arquivo está corrompido e JÁ EXISTEM perfis em ${ctx.baseDir}/profiles/ — sem o registro não dá para saber ` +
    `nomes nem qual abre por padrão, e eu não adivinho. ` +
    (ctx.quarantinePath
      ? `O corrompido foi preservado em ${ctx.quarantinePath}. `
      : "") +
    `Restaure um profiles.json bom (ou remova ${ctx.baseDir}/profiles/ para começar do zero) e abra de novo.`
  );
}

/** Aviso de `--profile` desconhecido: nomeia o id pedido e o que foi aberto. */
export function describeUnknownProfile(requestedId: string, openedName: string): string {
  return (
    `[stellar] --profile=${requestedId} não existe neste userData — abrindo "${openedName}". ` +
    `Confira o id em profiles.json ou abra sem a flag.`
  );
}

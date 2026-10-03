import { isAbsolute } from "node:path";

/**
 * STELLAR TEAM — ETAPA 6: o bundle PORTÁTIL da config de providers (task
 * dd94912c). Ver `docs/STELLAR_TEAM.md` §6 (decisão 1: "Stellar não carrega
 * secrets") e §7/§8.
 *
 * O QUE ISTO É: a metade da etapa 6 que NÃO precisa de servidor — o FORMATO do
 * que viaja e as duas transformações puras (empacotar / aplicar). O transporte
 * (onde o arquivo fica, o merge de duas máquinas) é a etapa 7/8; aqui ele não
 * é inventado.
 *
 * O QUE VIAJA (as três coisas, e só elas):
 *   1. `providers[]` — as DECLARAÇÕES do usuário (o que ele escreveu à mão no
 *      `providers.json`). É a casa de trabalho dele, em dado.
 *   2. `schemaVersion` — a versão do formato de origem, para a chegada saber o
 *      que está lendo.
 *   3. `credentialsRequired` — os NOMES das credenciais que a casa usa. O
 *      VALOR nunca entra (decisão do dono, §6.1): o usuário redigita em cada
 *      máquina. Este módulo é PURO e recebe os nomes já extraídos — ele nem
 *      tem acesso a um valor — e `credentialNamesFromSecrets` é a fronteira que
 *      prova o descarte (só as CHAVES do arquivo de segredos saem de lá).
 *
 * O QUE NÃO VIAJA, e por quê:
 *   - QUALQUER valor de segredo — §6.1: a credencial não viaja.
 *   - `appProviders` — é do APP, reescrito INTEIRO a cada boot a partir do
 *     binário (`providers-dynamic.ts`). Carregá-lo congelaria o catálogo da
 *     versão copiada na máquina de chegada — o mesmo defeito que a sobrescrita
 *     por cópia cria (ver `providers.description` no schema).
 *   - `$schema` / `_notice` — chaves de INSTRUÇÃO recriadas no nascimento pelo
 *     `ensureProvidersConfigFile`; viajar seria escrever por cima do que a
 *     chegada gera.
 *   - caminho absoluto CRU — §8: "não sincronizar `cwd` absoluto sem remap".
 *     Vira `{home}` no pacote e é remapeado na chegada; o que NÃO estiver sob a
 *     home é carregado como está e DENUNCIADO (nunca aceito em silêncio).
 *
 * CONFLITO (§3.5): esta etapa resolve o lado CALMO — declaração de provider é
 * `{id, campos}`, e a chegada mescla por id pelo caminho de escrita que já
 * existe. O conflito DURO (posição de card, sticky, `tasks.status`, metadados
 * de board) é da etapa 7, e não é tocado aqui.
 */

export const PROVIDER_SYNC_KIND = "stellar-provider-config";

/** Versão do FORMATO DESTE BUNDLE (não do `providers.json`). */
export const PROVIDER_SYNC_VERSION = 1;

/** O marcador que substitui a home no pacote. Um token de TEXTO (e não um
 * `~`) porque a chegada precisa saber que AQUILO é portável: `~` é do shell e
 * não é expandido no meio de um JSON. */
export const HOME_PLACEHOLDER = "{home}";

export type PortableProviderBundle = {
  kind: typeof PROVIDER_SYNC_KIND;
  version: typeof PROVIDER_SYNC_VERSION;
  /** A versão do formato do `providers.json` de origem — o loader da chegada
   * decide se entende (a recusa direcional de `parseProviderSpecs` já existe). */
  schemaVersion: number;
  /** As declarações do USUÁRIO, com caminhos sob a home templatizados. */
  providers: unknown[];
  /** NOMES das credenciais que a casa usa — NUNCA o valor. */
  credentialsRequired: string[];
};

/** A fronteira do descarte de segredo: recebe o arquivo de segredos JÁ PARSEADO
 * e devolve SÓ AS CHAVES. Nenhum valor atravessa esta função — é o que o teste
 * prova (um valor falso no arquivo não aparece no pacote). */
export function credentialNamesFromSecrets(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>)
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .sort();
}

/** Troca o prefixo da home por `{home}` em TODA string do valor (descendo
 * objetos e arrays). Só o PREFIXO — um `--path=/home/x/y` no meio de uma flag
 * não é um caminho da casa, é o texto de uma flag. */
function templateHome(value: unknown, homeDir: string): unknown {
  if (typeof value === "string") {
    const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
    return value.startsWith(prefix) ? `${HOME_PLACEHOLDER}/${value.slice(prefix.length)}` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => templateHome(entry, homeDir));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = templateHome(entry, homeDir);
    return out;
  }
  return value;
}

/** O inverso: `{home}/x` → `<homeDir>/x`. Usa o separador da PRÓPRIA home da
 * chegada (Linux/macOS `/`, Windows `\`). */
function expandHome(value: unknown, homeDir: string): unknown {
  if (typeof value === "string") {
    if (value.startsWith(HOME_PLACEHOLDER)) return homeDir.replace(/\/$/, "") + value.slice(HOME_PLACEHOLDER.length);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => expandHome(entry, homeDir));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = expandHome(entry, homeDir);
    return out;
  }
  return value;
}

/** Caminhos ABSOLUTOS que sobraram E estão FORA da casa local (nenhum
 * `{home}` os cobria) — a chegada os DENUNCIA: eles apontam para um lugar que
 * provavelmente não existe aqui, e §8 proíbe tratá-los como portáveis. Um
 * caminho que veio de `{home}` e expandiu para a home DISTO aqui é mapeado, não
 * denunciado. */
function collectUnmapped(value: unknown, homeDir: string, out: string[] = []): string[] {
  if (typeof value === "string") {
    const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
    if (isAbsolute(value) && value !== homeDir && !value.startsWith(prefix)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectUnmapped(entry, homeDir, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) collectUnmapped(entry, homeDir, out);
    return out;
  }
  return out;
}

/**
 * `providers.json` + nomes de credencial → o pacote portátil. PURO: sem fs,
 * sem relógio, sem rede. `appProviders`, `$schema` e `_notice` NÃO entram (ver
 * o cabeçalho).
 */
export function buildPortableBundle(input: {
  config: Record<string, unknown>;
  /** Só NOMES — ver `credentialNamesFromSecrets`. */
  credentialNames: readonly string[];
  homeDir: string;
}): PortableProviderBundle {
  const schemaVersion = input.config.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    // O formato de origem tem de ser dito: sem ele a chegada não sabe o que
    // está lendo, e "assumir 1" seria interpretar por sorte — a mesma recusa
    // do loader (`parseProviderSpecs`).
    throw new Error("provider config has no integer `schemaVersion` to carry");
  }
  const entries = Array.isArray(input.config.providers) ? input.config.providers : [];
  return {
    kind: PROVIDER_SYNC_KIND,
    version: PROVIDER_SYNC_VERSION,
    schemaVersion,
    providers: entries.map((entry) => templateHome(entry, input.homeDir)),
    credentialsRequired: [
      ...new Set(input.credentialNames.map((name) => name.trim()).filter((name) => name !== "")),
    ].sort(),
  };
}

export type ApplyPortableBundleResult =
  | {
      ok: true;
      /** As declarações do usuário, com `{home}` já expandido para a casa LOCAL. */
      providers: unknown[];
      /** Nomes das credenciais que a pessoa precisa REDIGITAR nesta máquina. */
      credentialsRequired: string[];
      /** Caminhos absolutos que não vieram da home e apontam para fora: a
       * chegada os reporta, nunca os trata como portáveis. */
      unmapped: string[];
    }
  | { ok: false; error: string };

function describe(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  return "an object";
}

/**
 * O pacote → as declarações para a chegada. PURO, e NÃO escreve arquivo: quem
 * grava é o caminho de escrita ÚNICO que já existe (`ensureProvidersConfigFile`
 * / `app:add-provider`) — este módulo não inventa um segundo (§8, e a lição da
 * d9aa8b1a).
 */
export function applyPortableBundle(bundle: unknown, opts: { homeDir: string }): ApplyPortableBundleResult {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
    return { ok: false, error: `not a ${PROVIDER_SYNC_KIND} bundle — expected a JSON object, got ${describe(bundle)}` };
  }
  const record = bundle as Record<string, unknown>;
  if (record.kind !== PROVIDER_SYNC_KIND) {
    return { ok: false, error: `not a ${PROVIDER_SYNC_KIND} bundle — \`kind\` was ${describe(record.kind)}` };
  }
  if (record.version !== PROVIDER_SYNC_VERSION) {
    return {
      ok: false,
      error: `\`version\` must be ${PROVIDER_SYNC_VERSION} (the only bundle version this build understands) — got ${describe(record.version)}`,
    };
  }
  if (!Array.isArray(record.providers)) {
    return { ok: false, error: `\`providers\` must be an array — got ${describe(record.providers)}` };
  }
  const providers = record.providers.map((entry) => expandHome(entry, opts.homeDir));
  const credentialsRequired = Array.isArray(record.credentialsRequired)
    ? record.credentialsRequired.filter((name): name is string => typeof name === "string" && name.trim() !== "")
    : [];
  const unmapped = [...new Set(collectUnmapped(providers, opts.homeDir))].sort();
  return { ok: true, providers, credentialsRequired, unmapped };
}

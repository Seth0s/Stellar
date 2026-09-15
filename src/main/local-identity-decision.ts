/**
 * Identidade local real desde o primeiro run — a DECISÃO, sem I/O.
 *
 * docs/STELLAR_TEAM.md §6 decisão 4 (tomada pelo dono em 2026-09-15):
 * SIM, id real no modo local desde o dia 1. Com id, a migração
 * local→conta é ANEXAR; sem id, seria migração feia exatamente quando
 * houver usuário real para migrar. Barata agora, cara depois.
 *
 * Dois ids, e a distinção é o ponto (§1, §4):
 *
 * - `user_id` — a PESSOA. Anônimo-local, estável. Duas máquinas da
 *   mesma pessoa têm o MESMO `user_id`. É ele que um dia é anexado a
 *   uma conta. Precisa sobreviver a um banco recriado — por isso a
 *   fonte é o arquivo em `userData` (`local-identity.json`), e o
 *   SQLite carrega um ESPELHO (tabela `local_identity`), nunca o
 *   contrário.
 * - `install_id` — ESTA instalação/máquina. É o que torna "levar minha
 *   casa para qualquer PC" representável: a casa viaja com o
 *   `user_id`, o `install_id` fica (ou nasce outro na máquina nova).
 *
 * Regra inegociável (§4, "anônimo-local"): os dois ids são OPACOS —
 * `randomUUID()` e ponto. Nada derivado de e-mail, hostname, usuário
 * do SO, MAC, serial de disco ou path. Um id que revela a máquina
 * destrói a propriedade que o torna aceitável. `isOpaqueId` existe
 * para barrar qualquer valor que não seja um UUID canônico, na
 * leitura E na geração.
 *
 * Este módulo é PURO (sem fs, sem SQLite, sem Date.now implícito):
 * recebe o que foi encontrado em disco (`raw`) e o que o espelho do
 * banco devolveu (`dbMirror`), e diz o que fazer. A casca com I/O é
 * `local-identity.ts`. Mesma divisão de `single-instance-decision.ts`
 * / `delivery-lifecycle-decision.ts` — decisão testável em unidade,
 * efeito colateral do lado de fora.
 *
 * Matriz de decisão (arquivo × espelho):
 *
 * | arquivo               | espelho válido | efeito                                        |
 * |-----------------------|----------------|-----------------------------------------------|
 * | válido                | igual          | usar; não escrever nada                        |
 * | válido                | diferente/aus. | usar o ARQUIVO (fonte); reparar espelho        |
 * | versão futura, ids ok | qualquer       | usar read-only; NUNCA reescrever o arquivo     |
 * | versão futura, ids ?  | qualquer       | quarantena + nascer novo                       |
 * | inválido/truncado     | válido         | RESTAURAR do espelho; quarantena + reescrever  |
 * | inválido/truncado     | inválido/aus.  | quarantena + nascer novo                       |
 * | ausente               | válido         | restaurar do espelho; reescrever arquivo       |
 * | ausente               | inválido/aus.  | nascer novo; escrever arquivo + espelho        |
 *
 * "Quarantena" = renomear o arquivo existente para
 * `local-identity.corrupt-<ts>.json` antes de escrever por cima — os
 * bytes do dono nunca são destruídos (postura do repo: nenhum caminho
 * que descarte estado). Quem decide é este módulo; quem renomeia é a
 * casca.
 *
 * Por que o arquivo vence o espelho quando os dois divergem: o
 * arquivo é a FONTE (sobrevive a banco recriado, migração de userData,
 * backup parcial). O espelho existe para o caso complementar — arquivo
 * corrompido/perdido com banco intacto — e para consultas SQL sem
 * sair do banco. Espelho que discorda de arquivo válido é espelho
 * stale, e é reparado, nunca adotado.
 */

/** Versão do formato de `local-identity.json`. Bump = escrever vN+1
 * aceitando ler vN (upgrade), nunca o contrário. */
export const LOCAL_IDENTITY_SCHEMA_VERSION = 1;

/** Nome do arquivo dentro de `userData` — convenção de `locale.json` /
 * `secrets.json` (basename simples, sem ponto no meio). */
export const LOCAL_IDENTITY_FILENAME = "local-identity.json";

/** Prefixo do arquivo de quarantena (a casca completa com timestamp). */
export const LOCAL_IDENTITY_QUARANTINE_PREFIX = "local-identity.corrupt-";

export type LocalIdentity = {
  /** A pessoa. Anônimo-local, opaco, estável entre reinícios. */
  user_id: string;
  /** Esta instalação/máquina. Opaco. Não viaja com a "casa". */
  install_id: string;
  /** Nascimento da identidade (epoch-ms). Não é um timestamp de acesso
   * — nunca muda depois de criada. */
  created_at: number;
};

/**
 * UUID canônico (8-4-4-4-12 hex), case-insensitive, qualquer versão.
 * Deliberadamente NÃO exige v4: `randomUUID()` gera v4 hoje, mas um
 * arquivo escrito por versão futura com outro UUID não deve ser
 * recusado — a garantia que importa aqui é a OPAQUIDADE (hostname,
 * path, e-mail e MAC não passam neste formato), não o número da
 * versão.
 */
const OPAQUE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_RE.test(value);
}

/**
 * Valida um registro {user_id, install_id, created_at} — usado TANTO
 * para o conteúdo do arquivo (versão atual) quanto para a linha do
 * espelho no banco (que pode ser garbage: banco copiado pela metade,
 * coluna NULL de migração parcial). `null` = não é uma identidade
 * utilizável.
 *
 * `user_id === install_id` é recusado: os dois eixos são coisas
 * diferentes por definição (pessoa × máquina), e um arquivo com os
 * dois iguais foi corrompido ou fabricado à mão — tratar como
 * inválido preserva a distinção em vez de propagá-la.
 */
export function parseLocalIdentity(value: unknown): LocalIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!isOpaqueId(rec.user_id)) return null;
  if (!isOpaqueId(rec.install_id)) return null;
  if (rec.user_id === rec.install_id) return null;
  if (typeof rec.created_at !== "number" || !Number.isFinite(rec.created_at) || rec.created_at < 0) return null;
  return { user_id: rec.user_id, install_id: rec.install_id, created_at: rec.created_at };
}

/** O que foi encontrado no arquivo, antes de qualquer decisão. */
export type IdentityFileFinding =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  /** `schema_version` maior que a atual. `identity` não-null quando os
   * dois ids ainda são legíveis (campos estáveis entre versões) — caso
   * em que dá para usar read-only sem entender o resto do formato. */
  | { kind: "future"; version: number; identity: LocalIdentity | null }
  | { kind: "valid"; identity: LocalIdentity };

/**
 * Classifica o conteúdo cru do arquivo. `raw == null` = arquivo não
 * existe (ou a casca não conseguiu ler — ela passa `null` só para
 * ausência real; erro de leitura chega como string e cai em
 * `malformed`).
 */
export function inspectIdentityFile(raw: string | null | undefined): IdentityFileFinding {
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
  const rec = parsed as Record<string, unknown>;
  const version = rec.schema_version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { kind: "malformed", reason: "schema_version ausente ou não-inteiro" };
  }
  if (version > LOCAL_IDENTITY_SCHEMA_VERSION) {
    // Versão futura: os CAMPOS que conhecemos podem ainda ser legíveis.
    // `created_at` ilegível vira 0 ("desconhecido") — o que importa
    // para não trocar a pessoa de id são os dois ids.
    if (isOpaqueId(rec.user_id) && isOpaqueId(rec.install_id) && rec.user_id !== rec.install_id) {
      const createdAt =
        typeof rec.created_at === "number" && Number.isFinite(rec.created_at) && rec.created_at >= 0 ? rec.created_at : 0;
      return { kind: "future", version, identity: { user_id: rec.user_id, install_id: rec.install_id, created_at: createdAt } };
    }
    return { kind: "future", version, identity: null };
  }
  if (version < LOCAL_IDENTITY_SCHEMA_VERSION) {
    // Nunca existiu v0 — um número menor que a primeira versão é
    // corrupção, não legado. (Upgrade de versão antiga de verdade é
    // problema do código que bumpar a versão.)
    return { kind: "malformed", reason: `schema_version ${version} < ${LOCAL_IDENTITY_SCHEMA_VERSION} (corrupção, não legado)` };
  }
  const identity = parseLocalIdentity(rec);
  if (!identity) {
    return { kind: "malformed", reason: "user_id/install_id/created_at inválidos (id não-opaco, ids iguais ou timestamp ruim)" };
  }
  return { kind: "valid", identity };
}

export type LocalIdentityDecision = {
  /** A identidade a adotar — sempre presente; toda saída é utilizável. */
  identity: LocalIdentity;
  /** De onde ela veio. "fresh" = nasceu agora (randomUUID). */
  origin: "file" | "future-file" | "mirror" | "fresh";
  /** A casca deve (re)escrever `local-identity.json`. */
  writeFile: boolean;
  /** O chamador deve atualizar o espelho no banco. */
  writeMirror: boolean;
  /** A casca deve renomear o arquivo existente para a quarantena
   * ANTES de qualquer escrita — bytes suspeitos são preservados, não
   * sobrescritos. */
  quarantine: boolean;
  /** Diagnóstico legível — por que esta decisão, para log/relatório. */
  reason: string;
};

/**
 * Decide a identidade desta instalação dado o que existe em disco e
 * no espelho do banco. Pura: `generateId` e `now` vêm de fora (a
 * casca passa `randomUUID` e `Date.now()`), o que torna "nascer uma
 * identidade" testável sem relógio nem entropia reais.
 *
 * `generateId` que devolve valor não-opaco LANÇA — um gerador
 * quebrado não pode cunhar em silêncio um id que viole a regra de
 * anonimato (§4). Melhor falhar o boot que nascer identificável.
 */
export function decideLocalIdentity(input: {
  /** Conteúdo cru do arquivo, `null` se ausente. */
  raw: string | null | undefined;
  /** Linha do espelho no banco (qualquer forma — validada aqui). */
  dbMirror: unknown;
  generateId: () => string;
  now: number;
}): LocalIdentityDecision {
  const finding = inspectIdentityFile(input.raw);
  const mirror = parseLocalIdentity(input.dbMirror);

  function fresh(reason: string, quarantine: boolean): LocalIdentityDecision {
    const user_id = input.generateId();
    const install_id = input.generateId();
    if (!isOpaqueId(user_id) || !isOpaqueId(install_id)) {
      throw new Error("generateId devolveu valor não-opaco — recusado pela regra de anonimato (§4)");
    }
    return {
      identity: { user_id, install_id, created_at: input.now },
      origin: "fresh",
      writeFile: true,
      writeMirror: true,
      quarantine,
      reason,
    };
  }

  switch (finding.kind) {
    case "valid": {
      const mirrorStale = !mirror || mirror.user_id !== finding.identity.user_id || mirror.install_id !== finding.identity.install_id;
      return {
        identity: finding.identity,
        origin: "file",
        writeFile: false,
        writeMirror: mirrorStale,
        quarantine: false,
        reason: mirrorStale
          ? "arquivo válido é a fonte; espelho do banco ausente/divergente será reparado"
          : "arquivo válido; espelho confere — nada a escrever",
      };
    }
    case "future": {
      if (finding.identity) {
        // Read-only: NÃO reescrever. Este código não conhece todos os
        // campos de vN+1; escrever por cima seria downgrade destrutivo.
        const mirrorStale =
          !mirror || mirror.user_id !== finding.identity.user_id || mirror.install_id !== finding.identity.install_id;
        return {
          identity: finding.identity,
          origin: "future-file",
          writeFile: false,
          writeMirror: mirrorStale,
          quarantine: false,
          reason: `arquivo é de versão futura (v${finding.version}) mas os ids são legíveis — usado read-only, nunca reescrito`,
        };
      }
      return fresh(
        `arquivo de versão futura (v${finding.version}) sem ids legíveis — quarantena e identidade nova`,
        true,
      );
    }
    case "malformed": {
      if (mirror) {
        return {
          identity: mirror,
          origin: "mirror",
          writeFile: true,
          writeMirror: false,
          quarantine: true,
          reason: `arquivo inválido (${finding.reason}); espelho do banco intacto restaura a identidade — arquivo corrompido vai para quarantena e é reescrito`,
        };
      }
      return fresh(`arquivo inválido (${finding.reason}) e sem espelho utilizável — quarantena e identidade nova`, true);
    }
    case "absent": {
      if (mirror) {
        return {
          identity: mirror,
          origin: "mirror",
          writeFile: true,
          writeMirror: false,
          quarantine: false,
          reason: "arquivo ausente; espelho do banco restaura a identidade e o arquivo é recriado",
        };
      }
      return fresh("primeiro run — nada em disco nem no banco; identidade nova (randomUUID)", false);
    }
  }
}

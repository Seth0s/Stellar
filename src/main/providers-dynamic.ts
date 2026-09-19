/**
 * Provider DINÂMICO — a fundação para CLIs de terceiros sem hardcode
 * (2026-09-19, task 53dc0cff).
 *
 * O problema que isto resolve: até aqui, escolher um CLI era EDITAR
 * TIPO. `ProviderId` era uma union fechada de seis ids, `PROVIDERS` era um
 * array literal, e cada provider novo custava um `buildArgs` escrito à mão
 * mais um branch em cada lugar que precisava saber de algo dele. Um CLI
 * que o Stellar nunca ouviu falar (cline, commandcode) era simplesmente
 * impossível de nomear.
 *
 * O desenho: um provider dinâmico é DADO — um objeto JSON declarando o que
 * foi medido da CLI (binário, como o id de sessão entra, qual flag carrega
 * prompt de sistema, onde fica o config de MCP do bichinho, esforço,
 * modelo, como o brief chega). A partir dessa declaração,
 * `dynamicProviderDef` produz um `ProviderDef` comum, com o `buildArgs`
 * SINTETIZADO — e a partir daí o provider usa a MESMA infraestrutura dos
 * nativos: `spawnArgv` põe o brief na cauda, `resolveSpawn` resolve o
 * binário, `decideSpawnProfile` valida effort/model contra a faixa
 * declarada, `deriveReportDiscovery`/`deriveReportChannel` derivam a
 * entrega do report. Zero caso especial por id em qualquer parte abaixo ou
 * acima disto.
 *
 * Fonte das medições do catálogo embutido (task 4938e154, 2026-09-19) —
 * medidas contra os binários instalados nesta máquina, não deduzidas de
 * documentação:
 *
 *   cline (cline@3.0.62)         binário `cline`; retoma de verdade com id
 *                                IMPOSTO via `--id`; effort em `--thinking`
 *                                (none/low/medium/high/xhigh); model em
 *                                `-m/--model`; MCP em
 *                                `~/.cline/data/settings/cline_mcp_settings.json`
 *                                (chave `mcpServers`); prompt de sistema em
 *                                `-s`; brief posicional (honra `--`).
 *   commandcode (command-code@1.58.0)
 *                                binário `commandcode`/`command-code`;
 *                                retoma SÓ sessão existente (`--resume` /
 *                                `--session`) — NÃO aceita id imposto;
 *                                effort em `--effort`
 *                                (low/medium/high/xhigh/max); model em
 *                                `-m/--model`; MCP em
 *                                `~/.commandcode/mcp.json` (chave
 *                                `mcpServers`); SEM flag de prompt de
 *                                sistema; brief posicional.
 *
 * O que este arquivo NÃO faz, de propósito: registrar o MCP. A declaração
 * ganhou `configPath`/`configKey`/`serverShape` (é a fonte que o
 * registrador vai ler), mas quem ESCREVE no arquivo é outra task — este
 * módulo não toca em `~` nenhum. Enquanto isso, um provider dinâmico
 * com `mcp: "global-config"` aparece como canal esperado (`mcp`) sem ter
 * registro de fato; o `acbridge` no PATH continua cobrindo o report.
 *
 * Divisão de camadas (a mesma do resto do repo, ver `local-identity.ts`):
 * validação/decisão PURA aqui em cima, I/O de arquivo na casca no fim.
 * Nada neste módulo importa `electron` — quem chama o loader passa o
 * `userDataDir` (é `app.getPath("userData")` em produção).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeSystemPrompt,
  registerDynamicProviders,
  type McpServerShape,
  type ProviderDef,
  type ProviderFlagOpts,
  type ProviderId,
  type RegisterProvidersResult,
} from "./providers";

/** Nome do arquivo dentro de `userData` — mesma convenção de `locale.json`
 * / `local-identity.json` / `remote-devices.json` (um JSON por assunto, na
 * raiz do userData, e o mesmo diretório serve de override nos testes). */
export const PROVIDERS_CONFIG_FILENAME = "providers.json";

/** Versão do formato do ARQUIVO (não do app). Um arquivo de versão
 * desconhecida é recusado inteiro, visivelmente — nunca "interpretado por
 * sorte", que é como um formato evolui quebrando config de usuário em
 * silêncio. */
export const PROVIDERS_CONFIG_SCHEMA_VERSION = 1;

export function providersConfigPath(userDataDir: string): string {
  return join(userDataDir, PROVIDERS_CONFIG_FILENAME);
}

/**
 * UM provider de CLI, em JSON — um espelho declarativo de `ProviderDef`
 * (`providers.ts`): id/label/binaryNames/installCommand iguais, e o
 * `capacity` com os mesmos campos menos o que um adaptador data-driven
 * NÃO consegue expressar: o que só existe como implementação medida de um
 * nativo (o `midTurnQueue` do cursor, os `submitStartedPattern`) fica de
 * fora e continua `undefined` num dinâmico — inventar essa medição para
 * outra CLI é justamente o que este projeto não faz.
 */
export type DynamicProviderSpec = {
  /** Id estável usado em `spawn_agent`, no card e no banco. */
  id: string;
  /** Nome exibido na UI (Topbar/rail). */
  label: string;
  /** Nomes tentados em ordem por `which()` — o primeiro que resolver. */
  binaryNames: string[];
  /** Sugestão de instalação por SO (`null` = nunca "não instalado"). */
  installCommand: { posix: string; windows: string } | null;
  capacity: {
    role: "agent" | "shell";
    /** Como o id de sessão entra no argv — ver `SessionCapability`. */
    session: {
      canImposeSessionId: boolean;
      resumeFlag?: string;
      imposeFlag?: string;
      continueFlag?: string;
    };
    /** `flag` (o CLI tem uma flag real que recebe o bloco composto por
     * `composeSystemPrompt`) ou `none`. Os dois mecanismos nomeados dos
     * nativos (`append-system-prompt`, `developer_instructions`) são recusa
     * explícita aqui: cada um é uma fiação específica daquele CLI, e marcar
     * `flag` num deles esconderia qual flag o CLI de fato lê. */
    systemPrompt: { mechanism: "flag"; flag: string } | { mechanism: "none" };
    /** `global-config` exige caminho/chave/forma (o registrador é a próxima
     * task). `ephemeral-flag` é recusa explícita: o sintetizador abaixo não
     * sabe montar o JSON de config de UMA CLI desconhecida — isso é
     * `buildArgs` à mão, como nos nativos. */
    mcp:
      | { mechanism: "global-config"; configPath: string; configKey: string; serverShape: McpServerShape }
      | { mechanism: "none" };
    acbridgeOnPath: boolean;
    effort:
      | { mechanism: "flag"; flag: string; values: string[] }
      | { mechanism: "none"; reason: "shell" | "no-flag" | "unmeasured" };
    model: { mechanism: "flag"; flag: string } | { mechanism: "none"; reason: "shell" };
    delivery: { briefMechanism: "positional" | "flag" | "none"; briefFlag?: string };
  };
};

/**
 * O catálogo MEDIDO embutido (task 4938e154) — os dois CLIs de terceiro
 * que já foram medidos nesta máquina.
 *
 * Por que embutido, e não só no arquivo do usuário: sem isto, "cadastrar
 * cline" seria um passo manual de cada instalação do Stellar, e o recurso
 * nasceria desligado. É DADO declarativo, não código por provider — o que
 * o desenho veio remover é o `buildArgs`/branch hardcoded, e aqui não
 * existe nenhum. O usuário continua podendo sobrescrever ou acrescentar
 * qualquer id pelo `providers.json` (um id igual ao de cá VENCE).
 */
export const MEASURED_THIRD_PARTY_SPECS: readonly DynamicProviderSpec[] = [
  {
    id: "cline",
    label: "Cline",
    binaryNames: ["cline"],
    installCommand: { posix: "npm install -g cline", windows: "npm install -g cline" },
    capacity: {
      role: "agent",
      session: {
        // `--id <uuid>`: retoma de verdade, e a sessão nasce com o id que o
        // Stellar gerou — a mesma semântica do `--resume` do cursor (uma
        // flag para os dois papéis). Medido, não presumido.
        canImposeSessionId: true,
        resumeFlag: "--id",
        imposeFlag: "--id",
      },
      systemPrompt: { mechanism: "flag", flag: "-s" },
      mcp: {
        mechanism: "global-config",
        configPath: "~/.cline/data/settings/cline_mcp_settings.json",
        configKey: "mcpServers",
        serverShape: "stdio-command",
      },
      acbridgeOnPath: true,
      effort: {
        mechanism: "flag",
        flag: "--thinking",
        values: ["none", "low", "medium", "high", "xhigh"],
      },
      model: { mechanism: "flag", flag: "-m" },
      // Brief posicional e `--` honrado, medido — mesmo caminho de
      // claude/cursor (ver `END_OF_OPTIONS`).
      delivery: { briefMechanism: "positional" },
    },
  },
  {
    id: "commandcode",
    label: "Command Code",
    binaryNames: ["commandcode", "command-code"],
    installCommand: { posix: "npm install -g command-code", windows: "npm install -g command-code" },
    capacity: {
      role: "agent",
      session: {
        // Medido: só retoma sessão EXISTENTE. Um id imposto seria recusado,
        // então `canImposeSessionId: false` — e `shouldImposeSessionId`
        // nunca gera UUID para ele.
        canImposeSessionId: false,
        resumeFlag: "--resume",
      },
      systemPrompt: { mechanism: "none" },
      mcp: {
        mechanism: "global-config",
        configPath: "~/.commandcode/mcp.json",
        configKey: "mcpServers",
        serverShape: "stdio-command",
      },
      acbridgeOnPath: true,
      effort: {
        mechanism: "flag",
        flag: "--effort",
        values: ["low", "medium", "high", "xhigh", "max"],
      },
      model: { mechanism: "flag", flag: "-m" },
      delivery: { briefMechanism: "positional" },
    },
  },
];

// ---------------------------------------------------------------------------
// Decisão pura: validação do arquivo. A regra é a mesma do gate de spawn
// (`spawn-profile-decision.ts`): recusar VISIVELMENTE, nunca aceitar e
// largar. Um spec inválido nunca entra no registro — e nunca derruba os
// outros: cada recusa é reportada com o índice e o motivo, e o resto do
// arquivo segue valendo.
// ---------------------------------------------------------------------------

export type SpecRejection = {
  /** Índice em `providers[]`; `-1` quando o próprio arquivo é o problema. */
  index: number;
  /** Id do spec, quando ele chegou a ser legível. */
  id: string | null;
  reason: string;
};

export type ParseProviderSpecsResult = {
  specs: DynamicProviderSpec[];
  rejected: SpecRejection[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return nonEmptyString(value);
}

/** Array de strings não vazias, ou `null` — `[]` também é `null`: uma
 * lista vazia de nomes de binário/flags não é uma declaração. */
function nonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: string[] = [];
  for (const entry of value) {
    const str = nonEmptyString(entry);
    if (str === null) return null;
    out.push(str);
  }
  return out;
}

const EFFORT_NONE_REASONS = ["shell", "no-flag", "unmeasured"] as const;

/**
 * Valida UM spec (já sabidamente um objeto) contra `DynamicProviderSpec`.
 * Devolve o spec tipado ou a frase da recusa — sem exceção, para que uma
 * entrada podre no meio do arquivo não apague as outras.
 */
export function parseProviderSpec(value: unknown): { ok: true; spec: DynamicProviderSpec } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "provider entry is not a JSON object" };

  const id = nonEmptyString(value.id);
  if (!id) return { ok: false, reason: "missing or empty `id`" };
  // Um id que não dá para pôr em argv/env/db sem escape não é um id.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { ok: false, reason: `\`id\` must match /^[a-z0-9][a-z0-9-]*$/, got "${id}"` };
  }
  const label = nonEmptyString(value.label);
  if (!label) return { ok: false, reason: "missing or empty `label`" };

  const binaryNames = nonEmptyStringArray(value.binaryNames);
  if (binaryNames === null) {
    return { ok: false, reason: "`binaryNames` must be a non-empty array of non-empty strings" };
  }

  // Daqui para baixo tudo mora no `capacity` — o espelho do
  // `ProviderCapacity` que o registro vivo de fato consome.
  const capacityRaw = value.capacity;
  if (!isRecord(capacityRaw)) return { ok: false, reason: "missing `capacity` object" };

  const role = capacityRaw.role;
  if (role !== "agent" && role !== "shell") {
    return { ok: false, reason: "`capacity.role` must be \"agent\" or \"shell\"" };
  }

  let installCommand: DynamicProviderSpec["installCommand"] = null;
  if (value.installCommand !== undefined && value.installCommand !== null) {
    const cmd = value.installCommand;
    if (!isRecord(cmd)) return { ok: false, reason: "`installCommand` must be an object or null" };
    const posix = nonEmptyString(cmd.posix);
    const windows = nonEmptyString(cmd.windows);
    if (!posix || !windows) {
      return { ok: false, reason: "`installCommand` requires non-empty `posix` and `windows`" };
    }
    installCommand = { posix, windows };
  }

  const sessionRaw = capacityRaw.session;
  if (!isRecord(sessionRaw)) return { ok: false, reason: "missing `capacity.session` object" };
  if (typeof sessionRaw.canImposeSessionId !== "boolean") {
    return { ok: false, reason: "`capacity.session.canImposeSessionId` must be a boolean" };
  }
  const resumeFlag = optionalString(sessionRaw.resumeFlag);
  const imposeFlag = optionalString(sessionRaw.imposeFlag);
  const continueFlag = optionalString(sessionRaw.continueFlag);
  if (resumeFlag === null || imposeFlag === null || continueFlag === null) {
    return { ok: false, reason: "session flags must be non-empty strings when present" };
  }
  // A checagem que faz a declaração ser HONESTA: dizer que impõe sem dizer
  // com que flag deixaria `imposedSessionId` sem rumo no argv — e o silêncio
  // é exatamente a classe de falha que o gate de effort já existe para não
  // repetir.
  if (sessionRaw.canImposeSessionId && !imposeFlag) {
    return { ok: false, reason: "`capacity.session.canImposeSessionId: true` requires `imposeFlag`" };
  }

  const systemPromptRaw = capacityRaw.systemPrompt;
  if (!isRecord(systemPromptRaw)) return { ok: false, reason: "missing `capacity.systemPrompt` object" };
  let systemPrompt: DynamicProviderSpec["capacity"]["systemPrompt"];
  if (systemPromptRaw.mechanism === "none") {
    systemPrompt = { mechanism: "none" };
  } else if (systemPromptRaw.mechanism === "flag") {
    const flag = nonEmptyString(systemPromptRaw.flag);
    if (!flag) return { ok: false, reason: "`capacity.systemPrompt.flag` is required when mechanism is \"flag\"" };
    systemPrompt = { mechanism: "flag", flag };
  } else {
    return {
      ok: false,
      reason:
        "`capacity.systemPrompt.mechanism` must be \"flag\" or \"none\" for a dynamic provider" +
        " (append-system-prompt / developer_instructions are native-specific wiring)",
    };
  }

  const mcpRaw = capacityRaw.mcp;
  if (!isRecord(mcpRaw)) return { ok: false, reason: "missing `capacity.mcp` object" };
  let mcp: DynamicProviderSpec["capacity"]["mcp"];
  if (mcpRaw.mechanism === "none") {
    mcp = { mechanism: "none" };
  } else if (mcpRaw.mechanism === "global-config") {
    const configPath = nonEmptyString(mcpRaw.configPath);
    const configKey = nonEmptyString(mcpRaw.configKey);
    const serverShape = mcpRaw.serverShape;
    if (!configPath) return { ok: false, reason: "`capacity.mcp.configPath` is required for global-config" };
    if (!configKey) return { ok: false, reason: "`capacity.mcp.configKey` is required for global-config" };
    if (serverShape !== "stdio-command" && serverShape !== "local-array") {
      return { ok: false, reason: "`capacity.mcp.serverShape` must be \"stdio-command\" or \"local-array\"" };
    }
    mcp = { mechanism: "global-config", configPath, configKey, serverShape };
  } else {
    return {
      ok: false,
      reason:
        "`capacity.mcp.mechanism` must be \"global-config\" or \"none\" for a dynamic provider" +
        " (an ephemeral per-CLI flag is hand-written buildArgs, not declarable)",
    };
  }

  if (typeof capacityRaw.acbridgeOnPath !== "boolean") {
    return { ok: false, reason: "`capacity.acbridgeOnPath` must be a boolean" };
  }

  const effortRaw = capacityRaw.effort;
  if (!isRecord(effortRaw)) return { ok: false, reason: "missing `capacity.effort` object" };
  let effort: DynamicProviderSpec["capacity"]["effort"];
  if (effortRaw.mechanism === "flag") {
    const flag = nonEmptyString(effortRaw.flag);
    if (!flag) return { ok: false, reason: "`capacity.effort.flag` is required when mechanism is \"flag\"" };
    const values = nonEmptyStringArray(effortRaw.values);
    if (values === null) {
      return { ok: false, reason: "`capacity.effort.values` must be a non-empty array of non-empty strings" };
    }
    effort = { mechanism: "flag", flag, values };
  } else if (effortRaw.mechanism === "none") {
    const reason = effortRaw.reason;
    if (reason !== "shell" && reason !== "no-flag" && reason !== "unmeasured") {
      return { ok: false, reason: `\`capacity.effort.reason\` must be one of ${EFFORT_NONE_REASONS.join(", ")}` };
    }
    effort = { mechanism: "none", reason };
  } else {
    return { ok: false, reason: "`capacity.effort.mechanism` must be \"flag\" or \"none\"" };
  }

  const modelRaw = capacityRaw.model;
  if (!isRecord(modelRaw)) return { ok: false, reason: "missing `capacity.model` object" };
  let model: DynamicProviderSpec["capacity"]["model"];
  if (modelRaw.mechanism === "flag") {
    const flag = nonEmptyString(modelRaw.flag);
    if (!flag) return { ok: false, reason: "`capacity.model.flag` is required when mechanism is \"flag\"" };
    model = { mechanism: "flag", flag };
  } else if (modelRaw.mechanism === "none" && modelRaw.reason === "shell") {
    model = { mechanism: "none", reason: "shell" };
  } else {
    return { ok: false, reason: "`capacity.model.mechanism` must be \"flag\", or \"none\" with reason \"shell\"" };
  }

  const deliveryRaw = capacityRaw.delivery;
  if (!isRecord(deliveryRaw)) return { ok: false, reason: "missing `capacity.delivery` object" };
  let delivery: DynamicProviderSpec["capacity"]["delivery"];
  if (deliveryRaw.briefMechanism === "positional" || deliveryRaw.briefMechanism === "none") {
    delivery = { briefMechanism: deliveryRaw.briefMechanism };
  } else if (deliveryRaw.briefMechanism === "flag") {
    const briefFlag = nonEmptyString(deliveryRaw.briefFlag);
    if (!briefFlag) return { ok: false, reason: "`capacity.delivery.briefFlag` is required when briefMechanism is \"flag\"" };
    delivery = { briefMechanism: "flag", briefFlag };
  } else {
    return { ok: false, reason: "`capacity.delivery.briefMechanism` must be \"positional\", \"flag\" or \"none\"" };
  }

  return {
    ok: true,
    spec: {
      id,
      label,
      binaryNames,
      installCommand,
      capacity: {
        role,
        session: {
          canImposeSessionId: sessionRaw.canImposeSessionId,
          ...(resumeFlag ? { resumeFlag } : {}),
          ...(imposeFlag ? { imposeFlag } : {}),
          ...(continueFlag ? { continueFlag } : {}),
        },
        systemPrompt,
        mcp,
        acbridgeOnPath: capacityRaw.acbridgeOnPath,
        effort,
        model,
        delivery,
      },
    },
  };
}

/**
 * Valida o ARQUIVO inteiro (`{ schemaVersion, providers: [...] }`).
 * Pura: recebe o JSON já parseado. O que não valida não entra, e cada
 * recusa sai nomeada; um arquivo de versão desconhecida é recusado
 * inteiro, porque interpretar um formato que não conhecemos "no melhor
 * esforço" é como config de usuário quebra em silêncio.
 */
export function parseProviderSpecs(raw: unknown): ParseProviderSpecsResult {
  if (!isRecord(raw)) {
    return { specs: [], rejected: [{ index: -1, id: null, reason: "root must be a JSON object" }] };
  }
  if (raw.schemaVersion !== PROVIDERS_CONFIG_SCHEMA_VERSION) {
    return {
      specs: [],
      rejected: [
        {
          index: -1,
          id: null,
          reason: `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} — expected ${PROVIDERS_CONFIG_SCHEMA_VERSION}`,
        },
      ],
    };
  }
  if (!Array.isArray(raw.providers)) {
    return { specs: [], rejected: [{ index: -1, id: null, reason: "`providers` must be an array" }] };
  }

  const specs: DynamicProviderSpec[] = [];
  const rejected: SpecRejection[] = [];
  const seen = new Set<string>();
  raw.providers.forEach((entry, index) => {
    const parsed = parseProviderSpec(entry);
    if (!parsed.ok) {
      rejected.push({ index, id: isRecord(entry) ? nonEmptyString(entry.id) : null, reason: parsed.reason });
      return;
    }
    // Dois specs com o mesmo id no MESMO arquivo não têm uma resposta
    // certa ("o último vence" é uma opinião) — o primeiro que valida fica
    // e o duplicado é recusado com o motivo.
    if (seen.has(parsed.spec.id)) {
      rejected.push({ index, id: parsed.spec.id, reason: `duplicate id "${parsed.spec.id}" in the same file` });
      return;
    }
    seen.add(parsed.spec.id);
    specs.push(parsed.spec);
  });
  return { specs, rejected };
}

/**
 * Síntese do `buildArgs` de um provider dinâmico — o coração do desenho.
 *
 * A ORDEM é a mesma dos nativos (sessão → model → effort → prompt de
 * sistema) e o brief NÃO aparece aqui de jeito nenhum: quem o põe é
 * `spawnArgv`, sempre na cauda (posicional atrás de `--`), porque uma flag
 * variádica no meio comeria o texto — o caso `--mcp-config` do claude
 * (card 471) é a prova de que essa ordem não pode ser escolhida por
 * provider.
 *
 * O prompt de sistema é emitido SEMPRE que o mecanismo é `flag`, mesmo sem
 * `systemPrompt` do chamador: é por aí que o `ACBRIDGE_HINT` chega ao
 * agente, exatamente como `--append-system-prompt` faz no claude. Um
 * provider com `mechanism: "none"` não recebe o hint por argv nenhum —
 * a descoberta do report cai para `scrollback` (derivada, ver
 * `deriveReportDiscovery`), que é o que o `acbridge` no PATH cobre.
 */
export function synthesizeBuildArgs(spec: DynamicProviderSpec): (opts: ProviderFlagOpts) => string[] {
  const capacity = spec.capacity;
  return (opts) => {
    const args: string[] = [];
    if (opts.resumeId && capacity.session.resumeFlag) {
      args.push(capacity.session.resumeFlag, opts.resumeId);
    } else if (opts.imposedSessionId && capacity.session.canImposeSessionId && capacity.session.imposeFlag) {
      args.push(capacity.session.imposeFlag, opts.imposedSessionId);
    } else if (opts.continueLast && capacity.session.continueFlag) {
      args.push(capacity.session.continueFlag);
    }
    if (opts.model && capacity.model.mechanism === "flag") args.push(capacity.model.flag, opts.model);
    if (opts.effort && capacity.effort.mechanism === "flag") args.push(capacity.effort.flag, opts.effort);
    if (capacity.systemPrompt.mechanism === "flag") {
      args.push(capacity.systemPrompt.flag, composeSystemPrompt(opts.systemPrompt));
    }
    return args;
  };
}

/** Spec declarada → `ProviderDef` comum. Depois daqui não existe mais
 * "provider dinâmico": é um provider, ponto — mesma capacidade, mesmo
 * `buildArgs` (só que sintetizado), mesmas derivações. */
export function dynamicProviderDef(spec: DynamicProviderSpec): ProviderDef {
  const declared = spec.capacity;
  return {
    id: spec.id,
    label: spec.label,
    binaryNames: [...spec.binaryNames],
    installCommand: spec.installCommand ? { ...spec.installCommand } : null,
    capacity: {
      role: declared.role,
      systemPrompt:
        declared.systemPrompt.mechanism === "flag"
          ? { mechanism: "flag", flag: declared.systemPrompt.flag }
          : { mechanism: "none" },
      mcp:
        declared.mcp.mechanism === "global-config"
          ? {
              mechanism: "global-config",
              configPath: declared.mcp.configPath,
              configKey: declared.mcp.configKey,
              serverShape: declared.mcp.serverShape,
            }
          : { mechanism: "none" },
      acbridgeOnPath: declared.acbridgeOnPath,
      effort:
        declared.effort.mechanism === "flag"
          ? { mechanism: "flag", flag: declared.effort.flag, values: [...declared.effort.values] }
          : { mechanism: "none", reason: declared.effort.reason },
      model:
        declared.model.mechanism === "flag"
          ? { mechanism: "flag", flag: declared.model.flag }
          : { mechanism: "none", reason: "shell" },
      session: {
        canImposeSessionId: declared.session.canImposeSessionId,
        ...(declared.session.resumeFlag ? { resumeFlag: declared.session.resumeFlag } : {}),
        ...(declared.session.imposeFlag ? { imposeFlag: declared.session.imposeFlag } : {}),
        ...(declared.session.continueFlag ? { continueFlag: declared.session.continueFlag } : {}),
      },
      // `submitStartedPattern` fica de fora de propósito: é vocabulário de
      // TELA medido, e não foi medido para nenhum dinâmico. Ausente =
      // "não medido", que é a verdade — inventar aqui mudaria o
      // comportamento do `isActive` sem prova.
      delivery: {
        briefMechanism: declared.delivery.briefMechanism,
        ...(declared.delivery.briefFlag ? { briefFlag: declared.delivery.briefFlag } : {}),
      },
    },
    buildArgs: synthesizeBuildArgs(spec),
  };
}

// ---------------------------------------------------------------------------
// A casca com I/O: lê o arquivo, valida, registra. Nunca lança — um
// problema de config não pode impedir um spawn nem derrubar o app, e o
// resultado conta o que aconteceu para quem chamou poder mostrar.
// ---------------------------------------------------------------------------

export type LoadDynamicProvidersResult = {
  /** Caminho que foi tentado (existe ou não). */
  file: string;
  /** O arquivo existia e foi lido+parseado. `false` = ausente (normal) ou
   * ilegível (aí `error` está preenchido). */
  fileRead: boolean;
  /** Arquivo ilegível/JSON inválido, ou qualquer recusa do arquivo. As
   * recusas por spec estão em `rejected`; aqui fica só o que impediu de
   * ler o arquivo inteiro. */
  error: string | null;
  /** Ids que passaram a valer agora. */
  registered: ProviderId[];
  /** Ids recusados por colisão com um nativo (nativo sempre ganha). */
  skipped: ProviderId[];
  /** Specs inválidas do arquivo do usuário, com índice e motivo. */
  rejected: SpecRejection[];
  /** Ids que só existem porque o catálogo medido embutido os trouxe. */
  shippedDefaults: ProviderId[];
  /** Ids dinâmicos que ESTA carga derrubou do registro vivo — não estão
   * mais no arquivo (nem no catálogo). Vazio quando o arquivo não pôde ser
   * lido: nesse caso não se remove nada (ver `loadDynamicProviders`). */
  removed: ProviderId[];
};

/**
 * Lê `<userDataDir>/providers.json`, valida e SINCRONIZA o registro vivo
 * (`registerDynamicProviders`). Idempotente e re-chamável: um segundo load
 * substitui o def dos mesmos ids dinâmicos E derruba os que sumiram do
 * arquivo — é o que faz "editar (ou remover) e recarregar" funcionar sem
 * reiniciar o app.
 *
 * QUANDO O DIFF VALE, E QUANDO NÃO (2026-09-19, follow-ups da G6): a lista
 * efetiva só é uma DECLARAÇÃO do usuário quando o arquivo inteiro é
 * declaração. O diff (a poda) roda em exatamente dois casos:
 *
 *   1. arquivo AUSENTE (`ENOENT`) — "o usuário não tem entradas": apagar o
 *      arquivo é remover os providers dele;
 *   2. arquivo lido, parseado e SEM nenhuma recusa de NÍVEL-ARQUIVO — a
 *      lista efetiva é exatamente o que o arquivo declara (menos o que o
 *      catálogo embutido já sobrepõe).
 *
 * Fora disso o diff fica DESLIGADO e o registro mantém a última carga boa:
 *
 *   - arquivo ILEGÍVEL (JSON quebrado, permissão): o conteúdo é
 *     desconhecido, e derrubar os providers do usuário porque um editor
 *     salvou um estado intermediário seria perder a config dele por causa
 *     de um erro de I/O (o `error` daqui conta o que houve);
 *   - arquivo válido mas RECUSADO NO TOPO (`schemaVersion` desconhecida,
 *     `providers` que não é array, raiz que não é objeto): isto é uma
 *     recusa de INDEX `-1` vinda do validador, e um formato que este build
 *     não entende NÃO é um usuário dizendo "não quero mais nada" — podar
 *     aqui apagaria todos os providers dele por causa de uma versão de
 *     arquivo. Achado do review da G6: `error === null` também era verdade
 *     nesse caso, e o contrato estava sendo violado em silêncio.
 *
 * Recusa de ENTRADA (index >= 0) é DIFERENTE e continua podando: o arquivo
 * é uma declaração (formato conhecido, `providers` é array), e aquela
 * entrada específica não é válida — então aquele id sai do registro vivo e
 * aparece nomeado em `rejected`, em vez de manter no ar um def velho que o
 * usuário acabou de substituir por algo quebrado.
 *
 * Precedência: nativo > arquivo do usuário > catálogo embutido. Ou seja,
 * o usuário pode sobrescrever o cline embutido com o caminho de outro
 * binário, mas nunca transformar `claude` em outra coisa.
 */
export function loadDynamicProviders(
  userDataDir: string,
  opts: { shipped?: readonly DynamicProviderSpec[] } = {},
): LoadDynamicProvidersResult {
  const file = providersConfigPath(userDataDir);
  const shipped = opts.shipped ?? MEASURED_THIRD_PARTY_SPECS;

  let raw: unknown = null;
  let fileRead = false;
  let error: string | null = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
    fileRead = true;
  } catch (err) {
    // Ausente é o caso NORMAL (ninguém nunca escreveu o arquivo) e não é
    // erro. Qualquer outra coisa — permissão, JSON truncado — é reportada
    // e o catálogo embutido continua valendo: config podre não pode
    // derrubar um recurso que não depende dela.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      error = `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const parsed = raw === null ? { specs: [], rejected: [] } : parseProviderSpecs(raw);
  const userIds = new Set(parsed.specs.map((s) => s.id));
  const shippedEffective = shipped.filter((s) => !userIds.has(s.id));
  const effective = [...shippedEffective, ...parsed.specs];

  // `error === null` cobre os dois casos em que a lista efetiva é uma
  // declaração confiável: arquivo lido e válido (`fileRead`) e arquivo
  // ausente (ENOENT = "o usuário não tem entradas"). E um arquivo lido mas
  // RECUSADO NO TOPO não é declaração nenhuma: `parseProviderSpecs` marca
  // essas recusas com index `-1` (schemaVersion desconhecida, `providers`
  // que não é array, raiz que não é objeto), e sem esta segunda condição o
  // contrato vazava — medido no review da G6: error=null e removed=[...]
  // mesmo com o arquivo inteiro recusado. Ver o doc comment acima.
  const fileLevelRejected = parsed.rejected.some((entry) => entry.index === -1);
  const result: RegisterProvidersResult = registerDynamicProviders(effective.map(dynamicProviderDef), {
    pruneMissing: error === null && !fileLevelRejected,
  });

  return {
    file,
    fileRead,
    error,
    registered: result.registered,
    skipped: result.skipped,
    rejected: parsed.rejected,
    shippedDefaults: shippedEffective.map((s) => s.id),
    removed: result.removed,
  };
}

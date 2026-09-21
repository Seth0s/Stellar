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

import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  END_OF_OPTIONS,
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
  /**
   * Args FIXOS do binário — "flags que esta CLI sempre precisa", declaradas
   * uma vez e presentes em TODO spawn deste provider (2026-09-20, task
   * 64aed52b). É o buraco que `capacity` não cobria: ela deriva argv de
   * session/model/effort/systemPrompt, e nada disso expressa um
   * `--yolo`/`--trust`/`--no-ask` que o binário exige para rodar sem
   * atrito.
   *
   * POSIÇÃO: entram ANTES de tudo que `synthesizeBuildArgs` deriva, logo
   * depois do nome do binário — o argv final é
   * `binário <baseArgs> <sessão> <model> <effort> <prompt de sistema> -- <brief>`.
   * Três razões, em ordem de peso:
   *
   *   1. IDENTIDADE NÃO PODE SER SOBREPOSTA: numa CLI que aceita a mesma
   *      flag duas vezes (yargs/argparse/commander: a última vence), um
   *      `--resume`/`--id` escrito à mão aqui não pode ganhar do
   *      `--resume <uuid>` que o Stellar derivou da sessão do card — no fim
   *      da linha, ganharia. O mesmo vale para `-m`/effort: o que o card
   *      pediu vence um default do arquivo.
   *   2. O TAIL É RESERVADO: depois do prompt de sistema vêm `--` e o brief
   *      posicional (`spawnArgv`/`briefArgvFragment`, `providers.ts`) —
   *      declaração de usuário não entra na única região cujo significado
   *      não pode variar por provider.
   *   3. É COMO O HUMANO DIGITA: `cmd --yolo` é a invocação medida que
   *      funciona; a declaração reproduz essa forma em vez de inventar
   *      outra.
   *
   * FORMATO: um item = UM elemento de argv. Sem split por espaço e sem
   * shell (`pty-registry` passa array de argv, nunca `shell: true` — mesma
   * postura endurecida de `GateSpawn` em `gate-runner.ts`, cuja assinatura
   * por array existe para `shell: true` ser impossível por acidente). Por
   * isso um valor com espaço (`["--label", "meu agente"]`) é legítimo e
   * chega intacto; a validação recusa só o que quebraria a FORMA da linha
   * de comando (elemento vazio, `--`, NUL) — nunca o conteúdo da flag, que
   * é declaração do dono do arquivo.
   *
   * Ausente = sem args fixos. `[]` é declaração explícita de "nenhum", e é
   * assim que o usuário derruba um default do catálogo embutido.
   */
  baseArgs?: string[];
  /**
   * Declaração MEDIDA de efeito, não detecção (task c857539c): `true` diz
   * que as flags fixas desta declaração dispensam os prompts de permissão
   * da CLI (o caso medido: commandcode + `--yolo`, task 64aed52b). Ausente
   * = SEM claim — nem o schema nem a UI inferem efeito de string nenhuma,
   * que é exatamente o que impede a lista de "strings perigosas" por
   * provider (a ramificação por id que o sistema inteiro existe pra
   * evitar). Quem declara é quem mediu: o catálogo embutido, com a medição
   * no comentário ao lado da flag; ou o dono do arquivo, para a CLI dele.
   * A UI usa isto para EXPOR ("sobe sem pedir permissão"), não para
   * alarmar — o dono da máquina escolheu a flag de propósito.
   */
  bypassesPermissionPrompts?: boolean;
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
    // MEDIDO (nesta máquina, `command-code` 1.58.1) — é o que torna este
    // provider utilizável como card, e por que ele passa a vir declarado:
    //
    //   $ command-code --help | grep yolo
    //     --yolo    Bypass all permission prompts (alias for
    //               --dangerously-skip-permissions)
    //
    // Sem essa flag, o provider pedia confirmação a CADA comando de shell e
    // a CADA ferramenta MCP — inviável para um agente que roda sozinho num
    // card, que foi exatamente o relato do dono do repo (task 64aed52b).
    // Rodando `cmd --yolo` à mão num card bash, o mesmo agente trabalha sem
    // atrito: a declaração só reproduz a invocação medida.
    //
    // O QUE ISSO CUSTA, dito por inteiro porque é uma permissão: um card
    // `commandcode` nasce sem NENHUM prompt de permissão da CLI, igual a
    // quem digita `--yolo` na mão. Quem quiser os prompts de volta declara
    // `"baseArgs": []` para este id no `providers.json` (o arquivo do
    // usuário vence o catálogo embutido) — ou troca por `--auto-accept`,
    // que só dispensa confirmação de edição.
    //
    // MEDIDO (mesma máquina, `command-code` 1.58.1) — a segunda flag fixa, e
    // a razão dela estar aqui é que um card spawnado não tem quem responda
    // diálogo: sem ela o CLI abre, ANTES da view principal, o modal "Build
    // Your Coding Taste — Found 2 sessions from Claude Code for this project.
    // Analyze those sessions to build your coding taste package?".
    //
    //   $ command-code --help | grep onboarding
    //     --skip-onboarding   Skip taste onboarding (for automated runs)
    //
    // O diálogo não é cosmético: escolher "1. Yes, learn" (o default do
    // Enter) manda o CLI LER E PROCESSAR as transcrições de trabalho do dono
    // da máquina — os jsonl de sessão que OUTROS agentes (Claude Code, Codex,
    // Cursor) escreveram neste projeto. Um onboarding que consome isso sem o
    // dono pedir é efeito que o Stellar não pode causar ao spawnar um card:
    // não é preferência de configuração, é o processo que o Stellar abriu.
    //
    // O A/B foi medido, não deduzido, num HOME isolado (o estado do dono não
    // foi lido nem escrito, e as "2 sessões" eram jsonl fabricados dentro
    // desse HOME): sem a flag, o modal aparece e o log do CLI registra
    // "[Onboarding] starting taste learning (has_sessions)"; com a flag, o
    // CLI vai direto ao prompt de entrada e o log não tem UMA linha de
    // onboarding — e nenhum `tasteOnboarding` é gravado no projeto.
    //
    // NÃO MEDIDO, dito para ninguém supor o contrário: (a) que a flag cubra
    // qualquer onboarding futuro que este CLI venha a ganhar — ela cobre o de
    // HOJE (o de taste, que é o que o `--help` nomeia); (b) que exista flag
    // mais estreita que desligue só a análise de sessões: não existe (`--help`
    // não tem nenhuma outra de onboarding). `--no-session`, que aparece nas
    // sondas, NÃO entra: ele desliga a persistência da sessão (in-memory only)
    // e um card sem histórico perde o `/resume`.
    //
    // Ordem dos dois itens: independentes entre si (`--yolo` é permissão,
    // isto é onboarding), então a ordem não é semântica — `--yolo` primeiro
    // só preserva a ordem em que foram medidas.
    baseArgs: ["--yolo", "--skip-onboarding"],
    // O efeito declarado (task c857539c): a UI expõe "sobe sem pedir
    // permissão" a partir deste campo — dado medido ao lado da flag, nunca
    // detecção de string.
    bypassesPermissionPrompts: true,
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
// A RECEITA COPIÁVEL (2026-09-20, task 49796d45): as declarações MEDIDAS
// publicadas como EXEMPLO, sem saírem da camada embutida.
//
// O pedido do dono, textual, ao abrir o `providers.json` pelo botão de editar:
// "o cline e o commandcode não estão, e não tem o schema e explicação nele".
// Ele queria VER os dois CLIs que já funcionam nesta máquina, e o arquivo não
// ensinava nada.
//
// O QUE **NÃO** SE FAZ AQUI, e é a medição que sustenta esta task: mover os
// specs de `MEASURED_THIRD_PARTY_SPECS` para o arquivo do usuário COLAPSA a
// precedência de três níveis (nativo > arquivo > embutido) em dois. Medido
// contra este módulo: (C) o usuário apaga o arquivo e o `commandcode`
// DESAPARECE do registro, quando hoje ele volta pelo catálogo embutido; (D) um
// cline VELHO no arquivo VENCE o embutido e o app perde a capacidade de
// corrigir aquela declaração numa versão nova; (B) o `shippedDefaults`
// esvazia. O JSON é override e instrução; o embutido é ORIGEM.
//
// A SAÍDA, então, é de APRESENTAÇÃO, e ela mora no `providers.schema.json`:
//
//   - o schema é reescrito pelo app a CADA BOOT (`ensureProvidersSchemaFile`,
//     que compara o conteúdo e só grava quando difere), então a receita NUNCA
//     envelhece. O `_example` do arquivo do usuário, por decisão da task
//     d9aa8b1a, só recebe o que FALTA — colocar a receita lá seria envelhecê-la
//     em silêncio, que é justamente o problema que aquela decisão evitou;
//   - ela é GERADA daqui (`measuredProviderRecipes`), não um literal ao lado:
//     uma segunda cópia divergiria no primeiro dia;
//   - o `providers.json` do usuário aponta para o schema na primeira linha
//     (`$schema`), então o editor a mostra sozinho — o dono não precisa
//     procurar;
//   - e o arquivo do USUÁRIO continua com `providers` intocado: nenhuma
//     camada muda por causa disto.
//
// A receita também AVISA o que acontece se for copiada (ver a `description` de
// `providers.items`): copiar cria uma entrada de usuário que VENCE a embutida
// — o caso (D) acima. Sem esse aviso, publicar a receita criaria o problema
// que a medição identificou.
// ---------------------------------------------------------------------------

/**
 * As declarações medidas, como RECEITA — uma CÓPIA, para que o schema publicado
 * não possa ser mutado por quem o lê (o schema sai daqui direto para
 * `JSON.stringify`, e um `examples` apontando para os objetos vivos seria uma
 * porta para qualquer um que mexesse no schema mexer no catálogo).
 *
 * Hoje são as duas que o app já entrega prontas: cline e commandcode.
 */
export function measuredProviderRecipes(): DynamicProviderSpec[] {
  return MEASURED_THIRD_PARTY_SPECS.map((spec) => structuredClone(spec));
}

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

/** Como o valor recebido aparece na recusa — para a mensagem dizer o que
 * CHEGOU, não só o que se esperava. Uma recusa que não mostra o recebido
 * obriga o humano a caçar a linha por tentativa e erro. */
function describeValue(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  // Um array curto sai na mensagem INTEIRO: em `["ok", ""]` o problema é o
  // item vazio, e "an array" esconderia exatamente o que o humano precisa
  // ver. Um array enorme vira contagem, para a mensagem não virar o arquivo.
  if (Array.isArray(value)) return value.length <= 4 ? JSON.stringify(value) : `an array of ${value.length} items`;
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** `"a", "b" or "c"` — a forma com que os valores aceitos são escritos. */
function acceptedList(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/** Pertence à lista de valores aceitos — com estreitamento de tipo, para o
 * validador e a mensagem saírem da MESMA lista (é o que impede o schema
 * publicado de divergir do que o loader aceita). */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/**
 * A FRASE DE UMA RECUSA, com as três coisas que a tornam acionável: o
 * CAMPO, o que ele ACEITA e o que chegou. É a única fábrica de mensagem
 * deste validador, então nenhuma recusa nasce sem dizer o campo.
 *
 * Em inglês, como as vinte que já existiam aqui (e como as recusas
 * agent-facing do resto do main): a superfície em pt-BR é a UI, via `t()`, no
 * renderer. A "instrução" que o usuário pediu mora no JSON Schema
 * (`providersConfigSchema`) e no arquivo inicial — não em traduzir estas
 * frases no meio de uma lista que já é inglesa.
 */
function refusal(field: string, accepted: string, got: unknown): string {
  const received = got === RECEIVED_NOTHING ? "" : ` — got ${describeValue(got)}`;
  // Backtick no campo, como nas mensagens que já existiam aqui: um nome de
  // campo comprido (`capacity.session.canImposeSessionId`) no meio da frase
  // sem marcação vira sopa. Campo que já cita outro campo entre backticks
  // (ex.: "each entry of `providers`") não ganha um segundo par.
  const named = field.includes("`") ? field : `\`${field}\``;
  return `${named} must be ${accepted}${received}`;
}

/** Sentinela para "não há valor recebido a mostrar" (campo exigido e
 * ausente), diferente de `undefined` e de `null`, que SÃO valores que o
 * arquivo pode conter. */
const RECEIVED_NOTHING = Symbol("nothing");

// ---------------------------------------------------------------------------
// Os valores aceitos, em UMA fonte. Cada lista é usada pelo VALIDADOR (que
// recusa o resto) e pelo JSON SCHEMA publicado (`providersConfigSchema`), de
// forma que "o que o schema deixa autocompletar" e "o que o loader aceita"
// não podem divergir sem um teste cair (ver o teste anti-drift).
// ---------------------------------------------------------------------------

/** `capacity.role` — quem o provider É (mesmo vocabulário de `ProviderCapacity`). */
export const PROVIDER_ROLES = ["agent", "shell"] as const;
const SESSION_FLAG_KEYS = ["resumeFlag", "imposeFlag", "continueFlag"] as const;
export const SYSTEM_PROMPT_MECHANISMS = ["flag", "none"] as const;
export const MCP_MECHANISMS = ["global-config", "none"] as const;
export const MCP_SERVER_SHAPES = ["stdio-command", "local-array"] as const;
export const EFFORT_MECHANISMS = ["flag", "none"] as const;
export const EFFORT_NONE_REASONS = ["shell", "no-flag", "unmeasured"] as const;
export const MODEL_MECHANISMS = ["flag", "none"] as const;
export const DELIVERY_BRIEF_MECHANISMS = ["positional", "flag", "none"] as const;
/** O único `reason` aceito para `model.mechanism: "none"` (espelha
 * `ProviderCapacity.model`). */
export const MODEL_NONE_REASONS = ["shell"] as const;

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

/**
 * Valida `baseArgs` — a parte que impede que uma declaração de boa-fé
 * QUEBRE a linha de comando em vez de configurá-la. Exportada porque é a
 * regra de segurança do campo, e regra de segurança se testa direto.
 *
 * O que NÃO é recusado, de propósito: o CONTEÚDO da flag. O arquivo é
 * escrito pelo dono do repo numa máquina dele, e `--yolo` é literalmente o
 * caso de uso — policiar conteúdo aqui só criaria a próxima "flag que
 * funciona na mão e não funciona no Stellar". A linha é: a forma da linha de
 * comando é do Stellar, o conteúdo é do usuário.
 */
export function parseBaseArgs(value: unknown): { ok: true; args: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: refusal(
        "baseArgs",
        "an array of strings — one item = ONE argv element, never a string with spaces to be split",
        value,
      ),
    };
  }
  const args: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        ok: false,
        reason: refusal(`baseArgs[${index}]`, "a non-empty string", entry),
      };
    }
    // `--` encerraria o parsing de opções e TUDO que o Stellar deriva depois
    // (sessão, model, effort, prompt de sistema) viraria argumento
    // posicional — e o brief posicional (`--` + texto) passaria a ser lido
    // como mais um posicional. É a forma da linha de comando, não um gosto.
    if (entry === END_OF_OPTIONS) {
      return {
        ok: false,
        reason:
          "baseArgs must not contain `--`: it ends option parsing, so every flag Stellar derives after it " +
          "(session, model, effort, system prompt) and the positional brief would be read as a positional argument",
      };
    }
    // NUL não sobrevive ao execve: o erro real apareceria no spawn, longe do
    // arquivo que o causou.
    if (entry.includes("\0")) {
      return { ok: false, reason: refusal(`baseArgs[${index}]`, "a string without a NUL character", entry) };
    }
    args.push(entry);
  }
  return { ok: true, args };
}

/**
 * Valida UM spec (já sabidamente um objeto) contra `DynamicProviderSpec`.
 * Devolve o spec tipado ou a frase da recusa — sem exceção, para que uma
 * entrada podre no meio do arquivo não apague as outras.
 */
export function parseProviderSpec(value: unknown): { ok: true; spec: DynamicProviderSpec } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: refusal(
        "each entry of `providers`",
        "a JSON object with `id`, `label`, `binaryNames` and `capacity`",
        value,
      ),
    };
  }

  // Um id que não dá para pôr em argv/env/db sem escape não é um id — e a
  // mensagem diz a FORMA aceita em vez de só "id inválido", porque o caso
  // comum é um rótulo humano colado aqui ("Meu CLI").
  const id = nonEmptyString(value.id);
  if (id === null || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return {
      ok: false,
      reason: refusal("id", "a string matching /^[a-z0-9][a-z0-9-]*$/ (lowercase letters, digits and `-`)", value.id),
    };
  }
  const label = nonEmptyString(value.label);
  if (!label) {
    return { ok: false, reason: refusal("label", "a non-empty string (the name shown in the UI)", value.label) };
  }

  const binaryNames = nonEmptyStringArray(value.binaryNames);
  if (binaryNames === null) {
    return {
      ok: false,
      reason: refusal("binaryNames", 'a non-empty array of non-empty strings (e.g. ["cline"])', value.binaryNames),
    };
  }

  // Args FIXOS do binário (ver o campo em `DynamicProviderSpec`): validados
  // pela forma, nunca pelo conteúdo.
  let baseArgs: string[] | undefined;
  if (value.baseArgs !== undefined && value.baseArgs !== null) {
    const parsedBaseArgs = parseBaseArgs(value.baseArgs);
    if (!parsedBaseArgs.ok) return { ok: false, reason: parsedBaseArgs.reason };
    baseArgs = parsedBaseArgs.args;
  }

  // O efeito declarado sobre essas flags (ver o campo em
  // `DynamicProviderSpec`): booleano opcional, ausente é o caminho normal.
  let bypassesPermissionPrompts: boolean | undefined;
  if (value.bypassesPermissionPrompts !== undefined && value.bypassesPermissionPrompts !== null) {
    if (typeof value.bypassesPermissionPrompts !== "boolean") {
      return {
        ok: false,
        reason: refusal(
          "bypassesPermissionPrompts",
          'a boolean — declare true ONLY for a flag you measured to disable the CLI\'s permission prompts; absent means "no claim"',
          value.bypassesPermissionPrompts,
        ),
      };
    }
    bypassesPermissionPrompts = value.bypassesPermissionPrompts;
  }

  // Daqui para baixo tudo mora no `capacity` — o espelho do
  // `ProviderCapacity` que o registro vivo de fato consome.
  const capacityRaw = value.capacity;
  if (!isRecord(capacityRaw)) {
    return {
      ok: false,
      reason: refusal("capacity", "an object declaring role/session/systemPrompt/mcp/acbridgeOnPath/effort/model/delivery", capacityRaw),
    };
  }

  const role = capacityRaw.role;
  if (!isOneOf(role, PROVIDER_ROLES)) {
    return { ok: false, reason: refusal("capacity.role", `one of ${acceptedList(PROVIDER_ROLES)}`, role) };
  }

  let installCommand: DynamicProviderSpec["installCommand"] = null;
  if (value.installCommand !== undefined && value.installCommand !== null) {
    const cmd = value.installCommand;
    if (!isRecord(cmd)) {
      return { ok: false, reason: refusal("installCommand", 'an object with `posix` and `windows`, or null', cmd) };
    }
    // Diz QUAL dos dois está faltando: `{posix: "npm i -g x"}` sem `windows`
    // era recusado com uma frase que listava os dois campos e deixava o
    // humano procurando qual tinha escapado.
    const posix = nonEmptyString(cmd.posix);
    if (!posix) {
      return { ok: false, reason: refusal("installCommand.posix", 'a non-empty string (e.g. "npm install -g cline")', cmd.posix) };
    }
    const windows = nonEmptyString(cmd.windows);
    if (!windows) {
      return { ok: false, reason: refusal("installCommand.windows", "a non-empty string (the Windows equivalent)", cmd.windows) };
    }
    installCommand = { posix, windows };
  }

  const sessionRaw = capacityRaw.session;
  if (!isRecord(sessionRaw)) {
    return { ok: false, reason: refusal("capacity.session", "an object with `canImposeSessionId` and optional flags", sessionRaw) };
  }
  if (typeof sessionRaw.canImposeSessionId !== "boolean") {
    return {
      ok: false,
      reason: refusal("capacity.session.canImposeSessionId", "a boolean (true or false)", sessionRaw.canImposeSessionId),
    };
  }
  const sessionFlags: Partial<Record<(typeof SESSION_FLAG_KEYS)[number], string>> = {};
  for (const key of SESSION_FLAG_KEYS) {
    const parsed = optionalString(sessionRaw[key]);
    // Nomeia a FLAG: "session flags must be non-empty strings" mandava o
    // humano adivinhar qual das três (e um `""` no JSON parece, à vista,
    // um campo preenchido).
    if (parsed === null) {
      return { ok: false, reason: refusal(`capacity.session.${key}`, 'a non-empty flag string (e.g. "--resume")', sessionRaw[key]) };
    }
    if (parsed !== undefined) sessionFlags[key] = parsed;
  }
  const imposeFlag = sessionFlags.imposeFlag;
  // A checagem que faz a declaração ser HONESTA: dizer que impõe sem dizer
  // com que flag deixaria `imposedSessionId` sem rumo no argv — e o silêncio
  // é exatamente a classe de falha que o gate de effort já existe para não
  // repetir.
  if (sessionRaw.canImposeSessionId && !imposeFlag) {
    return {
      ok: false,
      reason:
        "capacity.session.canImposeSessionId is true but `capacity.session.imposeFlag` is absent — " +
        'declare the flag that carries the id (e.g. "--id"), or set canImposeSessionId to false',
    };
  }

  const systemPromptRaw = capacityRaw.systemPrompt;
  if (!isRecord(systemPromptRaw)) {
    return { ok: false, reason: refusal("capacity.systemPrompt", "an object with `mechanism` (see the schema)", systemPromptRaw) };
  }
  let systemPrompt: DynamicProviderSpec["capacity"]["systemPrompt"];
  if (systemPromptRaw.mechanism === "none") {
    systemPrompt = { mechanism: "none" };
  } else if (systemPromptRaw.mechanism === "flag") {
    const flag = nonEmptyString(systemPromptRaw.flag);
    if (!flag) {
      return {
        ok: false,
        reason: refusal('capacity.systemPrompt.flag', 'a non-empty flag string (e.g. "-s"); required when mechanism is "flag"', systemPromptRaw.flag),
      };
    }
    systemPrompt = { mechanism: "flag", flag };
  } else {
    return {
      ok: false,
      reason:
        refusal("capacity.systemPrompt.mechanism", `one of ${acceptedList(SYSTEM_PROMPT_MECHANISMS)}`, systemPromptRaw.mechanism) +
        " (append-system-prompt / developer_instructions are native-specific wiring, not declarable here)",
    };
  }

  const mcpRaw = capacityRaw.mcp;
  if (!isRecord(mcpRaw)) {
    return { ok: false, reason: refusal("capacity.mcp", "an object with `mechanism` (see the schema)", mcpRaw) };
  }
  let mcp: DynamicProviderSpec["capacity"]["mcp"];
  if (mcpRaw.mechanism === "none") {
    mcp = { mechanism: "none" };
  } else if (mcpRaw.mechanism === "global-config") {
    const configPath = nonEmptyString(mcpRaw.configPath);
    const configKey = nonEmptyString(mcpRaw.configKey);
    const serverShape = mcpRaw.serverShape;
    if (!configPath) {
      return {
        ok: false,
        reason: refusal('capacity.mcp.configPath', 'the config file the CLI reads (e.g. "~/.commandcode/mcp.json")', mcpRaw.configPath),
      };
    }
    if (!configKey) {
      return {
        ok: false,
        reason: refusal('capacity.mcp.configKey', 'the key inside that file that holds the servers (e.g. "mcpServers")', mcpRaw.configKey),
      };
    }
    if (!isOneOf(serverShape, MCP_SERVER_SHAPES)) {
      return { ok: false, reason: refusal("capacity.mcp.serverShape", `one of ${acceptedList(MCP_SERVER_SHAPES)}`, serverShape) };
    }
    mcp = { mechanism: "global-config", configPath, configKey, serverShape };
  } else {
    return {
      ok: false,
      reason:
        refusal("capacity.mcp.mechanism", `one of ${acceptedList(MCP_MECHANISMS)}`, mcpRaw.mechanism) +
        " (an ephemeral per-CLI flag is hand-written buildArgs, not declarable)",
    };
  }

  if (typeof capacityRaw.acbridgeOnPath !== "boolean") {
    return {
      ok: false,
      reason: refusal("capacity.acbridgeOnPath", "a boolean (true or false)", capacityRaw.acbridgeOnPath),
    };
  }

  const effortRaw = capacityRaw.effort;
  if (!isRecord(effortRaw)) {
    return { ok: false, reason: refusal("capacity.effort", "an object with `mechanism` (see the schema)", effortRaw) };
  }
  let effort: DynamicProviderSpec["capacity"]["effort"];
  if (effortRaw.mechanism === "flag") {
    const flag = nonEmptyString(effortRaw.flag);
    if (!flag) {
      return {
        ok: false,
        reason: refusal('capacity.effort.flag', 'a non-empty flag string (e.g. "--thinking"); required when mechanism is "flag"', effortRaw.flag),
      };
    }
    const values = nonEmptyStringArray(effortRaw.values);
    if (values === null) {
      return {
        ok: false,
        reason: refusal("capacity.effort.values", 'a non-empty array of accepted values (e.g. ["low", "high"])', effortRaw.values),
      };
    }
    effort = { mechanism: "flag", flag, values };
  } else if (effortRaw.mechanism === "none") {
    const reason = effortRaw.reason;
    if (!isOneOf(reason, EFFORT_NONE_REASONS)) {
      return { ok: false, reason: refusal("capacity.effort.reason", `one of ${acceptedList(EFFORT_NONE_REASONS)}`, reason) };
    }
    effort = { mechanism: "none", reason };
  } else {
    return { ok: false, reason: refusal("capacity.effort.mechanism", `one of ${acceptedList(EFFORT_MECHANISMS)}`, effortRaw.mechanism) };
  }

  const modelRaw = capacityRaw.model;
  if (!isRecord(modelRaw)) {
    return { ok: false, reason: refusal("capacity.model", "an object with `mechanism` (see the schema)", modelRaw) };
  }
  let model: DynamicProviderSpec["capacity"]["model"];
  if (modelRaw.mechanism === "flag") {
    const flag = nonEmptyString(modelRaw.flag);
    if (!flag) {
      return {
        ok: false,
        reason: refusal('capacity.model.flag', 'a non-empty flag string (e.g. "-m"); required when mechanism is "flag"', modelRaw.flag),
      };
    }
    model = { mechanism: "flag", flag };
  } else if (modelRaw.mechanism === "none") {
    if (!isOneOf(modelRaw.reason, MODEL_NONE_REASONS)) {
      return {
        ok: false,
        reason: refusal("capacity.model.reason", `${acceptedList(MODEL_NONE_REASONS)} when mechanism is "none"`, modelRaw.reason),
      };
    }
    model = { mechanism: "none", reason: "shell" };
  } else {
    return {
      ok: false,
      reason: refusal("capacity.model.mechanism", `one of ${acceptedList(MODEL_MECHANISMS)}`, modelRaw.mechanism),
    };
  }

  const deliveryRaw = capacityRaw.delivery;
  if (!isRecord(deliveryRaw)) {
    return { ok: false, reason: refusal("capacity.delivery", "an object with `briefMechanism` (see the schema)", deliveryRaw) };
  }
  let delivery: DynamicProviderSpec["capacity"]["delivery"];
  if (deliveryRaw.briefMechanism === "positional" || deliveryRaw.briefMechanism === "none") {
    delivery = { briefMechanism: deliveryRaw.briefMechanism };
  } else if (deliveryRaw.briefMechanism === "flag") {
    const briefFlag = nonEmptyString(deliveryRaw.briefFlag);
    if (!briefFlag) {
      return {
        ok: false,
        reason: refusal('capacity.delivery.briefFlag', 'a non-empty flag string (e.g. "--prompt"); required when briefMechanism is "flag"', deliveryRaw.briefFlag),
      };
    }
    delivery = { briefMechanism: "flag", briefFlag };
  } else {
    return {
      ok: false,
      reason: refusal("capacity.delivery.briefMechanism", `one of ${acceptedList(DELIVERY_BRIEF_MECHANISMS)}`, deliveryRaw.briefMechanism),
    };
  }

  return {
    ok: true,
    spec: {
      id,
      label,
      binaryNames,
      installCommand,
      ...(baseArgs !== undefined ? { baseArgs } : {}),
      ...(bypassesPermissionPrompts !== undefined ? { bypassesPermissionPrompts } : {}),
      capacity: {
        role,
        session: {
          canImposeSessionId: sessionRaw.canImposeSessionId,
          ...sessionFlags,
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

// ---------------------------------------------------------------------------
// O CONTRATO DO ARQUIVO (2026-09-20, task 64aed52b, parte B).
//
// O relato: "o json para editar não tem os campos aceitáveis (instrução), e
// sem instrução nenhuma". `providers.json` é editado À MÃO — é o fluxo
// suportado — e até aqui não dizia quais campos existem, o que é
// obrigatório, que valores um enum aceita, nem o que acontece se errar.
//
// As três peças, e por que estão AQUI (e não num documento à parte):
//
//   1. Um JSON Schema DERIVADO das mesmas listas de valores que o validador
//      usa (`PROVIDER_ROLES`, `EFFORT_NONE_REASONS`, …). Schema escrito à
//      mão divergiria do parser no primeiro campo novo, e schema que mente
//      é pior que schema nenhum: o editor autocompletaria exatamente o que
//      o loader recusa. Um teste anti-drift percorre o schema e o confronta
//      com `parseProviderSpec` (providers-dynamic-json-contract.test.ts).
//   2. O ARQUIVO INICIAL exemplificado (`initialProvidersConfig`), para o
//      primeiro save não ser um `{ "providers": [] }` mudo.
//   3. As recusas que dizem CAMPO + VALOR ACEITO + valor recebido
//      (`refusal()`), que é o que transforma "rejeitado" em "rejeitado, e é
//      isto que você escreve no lugar".
//
// `$schema` aponta para o schema ao LADO do arquivo
// (`./providers.schema.json`): referência relativa é como o editor resolve,
// offline, sem depender de URL nenhuma deste repositório.
//
// Sem `additionalProperties: false`, de propósito: o loader IGNORA chaves
// desconhecidas e JSON não tem comentário — então uma chave extra é o lugar
// legítimo para a nota do dono do arquivo. O contrato publicado não pode
// proibir o que o carregador aceita; erro de digitação continua sendo pego
// pelas mensagens de campo obrigatório.
// ---------------------------------------------------------------------------

/** Nome do schema, no MESMO userData do `providers.json`. */
export const PROVIDERS_SCHEMA_FILENAME = "providers.schema.json";

/** O valor que vai em `$schema` no arquivo do usuário — relativo ao próprio
 * arquivo, que é como o editor o resolve sem rede. */
export const PROVIDERS_SCHEMA_REF = `./${PROVIDERS_SCHEMA_FILENAME}`;

export function providersSchemaPath(userDataDir: string): string {
  return join(userDataDir, PROVIDERS_SCHEMA_FILENAME);
}

const asStr = (description: string) => ({ type: "string", description });
const asNonEmptyStr = (description: string) => ({ type: "string", minLength: 1, description });
const asBool = (description: string) => ({ type: "boolean", description });
const asEnum = (values: readonly string[], description: string) => ({
  type: "string",
  enum: [...values],
  description,
});

/**
 * Um objeto de "mecanismo": sempre exige `mechanism` e, quando ele vale
 * `flag` (ou `global-config`), exige o campo que o carrega — a MESMA
 * condicional que o parser aplica (`if/then` do JSON Schema 2020-12).
 */
function mechanismObject(args: {
  description: string;
  mechanisms: readonly string[];
  flagValue: string;
  flagField: string;
  flagDescription: string;
  /** Nome do campo do mecanismo, quando NÃO é `mechanism` (o `delivery` usa
   * `briefMechanism` — medido no parser, não uma preferência). */
  mechanismKey?: string;
  /** Outros campos obrigatórios quando o mecanismo é `flagValue` (ex.:
   * `configKey` e `serverShape` do mcp). */
  alsoRequired?: readonly string[];
  /** Obrigatórios no OUTRO ramo (ex.: o `reason` do effort/model quando o
   * mecanismo não é flag). */
  elseRequired?: readonly string[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    description,
    mechanisms,
    flagValue,
    flagField,
    flagDescription,
    mechanismKey = "mechanism",
    alsoRequired = [],
    elseRequired = [],
    extra = {},
  } = args;
  return {
    type: "object",
    description,
    required: [mechanismKey],
    properties: {
      [mechanismKey]: asEnum(mechanisms, "Como este recurso é entregue a esta CLI."),
      [flagField]: asNonEmptyStr(flagDescription),
      ...extra,
    },
    if: { properties: { [mechanismKey]: { const: flagValue } }, required: [mechanismKey] },
    then: { required: [flagField, ...alsoRequired] },
    // O ramo "não flag" também tem obrigação própria (o `reason` de quem não
    // tem a flag) — sem isto o schema deixaria passar uma declaração que o
    // parser recusa.
    ...(elseRequired.length > 0 ? { else: { required: [...elseRequired] } } : {}),
  };
}

/** O corpo de `capacity` — o espelho declarativo de `ProviderCapacity`. */
function capacitySchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "O que foi MEDIDO desta CLI: como a sessão entra no argv, como o prompt de sistema chega, " +
      "onde fica o config de MCP, esforço, modelo e como o brief é entregue.",
    required: ["role", "session", "systemPrompt", "mcp", "acbridgeOnPath", "effort", "model", "delivery"],
    properties: {
      role: asEnum(PROVIDER_ROLES, 'Quem o provider é: "agent" (TUI de agente) ou "shell".'),
      session: {
        type: "object",
        description: "Como o id de sessão entra no argv.",
        required: ["canImposeSessionId"],
        properties: {
          canImposeSessionId: asBool(
            "true = a CLI aceita um id de sessão IMPOSTO por você (e o retoma depois); exige `imposeFlag`. " +
              "false = a CLI só retoma sessão que já existe.",
          ),
          imposeFlag: asNonEmptyStr('Flag que carrega o id imposto (ex.: "--id"). Obrigatória quando canImposeSessionId é true.'),
          resumeFlag: asNonEmptyStr('Flag que retoma uma sessão existente (ex.: "--resume").'),
          continueFlag: asNonEmptyStr('Flag de "continue a última" (ex.: "--continue").'),
        },
      },
      systemPrompt: mechanismObject({
        description:
          "Como o prompt de sistema chega ao agente. Os mecanismos nomeados dos nativos " +
          "(append-system-prompt, developer_instructions) são recusa explícita: cada um é fiação de UM CLI.",
        mechanisms: SYSTEM_PROMPT_MECHANISMS,
        flagValue: "flag",
        flagField: "flag",
        flagDescription: 'Flag que recebe o prompt (ex.: "-s"). Obrigatória quando mechanism é "flag".',
      }),
      mcp: mechanismObject({
        description:
          'Onde esta CLI lê a lista de servidores MCP. "global-config" exige configPath/configKey/serverShape; ' +
          '"none" = a CLI não lê arquivo de MCP (o report cai para o acbridge no PATH).',
        mechanisms: MCP_MECHANISMS,
        flagValue: "global-config",
        flagField: "configPath",
        flagDescription: 'Caminho do arquivo de config de MCP desta CLI (ex.: "~/.commandcode/mcp.json").',
        alsoRequired: ["configKey", "serverShape"],
        extra: {
          configKey: asNonEmptyStr('Chave dentro do arquivo que lista os servidores (ex.: "mcpServers").'),
          serverShape: asEnum(
            MCP_SERVER_SHAPES,
            '"stdio-command" = cada servidor é um objeto com command/args; "local-array" = um array posicional.',
          ),
        },
      }),
      acbridgeOnPath: asBool(
        "true = o `acbridge` está no PATH de todo card (o Stellar o põe), então este provider entrega o report " +
          "mesmo sem MCP. Declare false só se foi medido o contrário.",
      ),
      effort: mechanismObject({
        description:
          'Faixa de esforço declarada. "none" exige um reason: shell (não é agente), no-flag (a CLI não tem ' +
          "essa noção) ou unmeasured (não foi medido — não invente uma faixa).",
        mechanisms: EFFORT_MECHANISMS,
        flagValue: "flag",
        flagField: "flag",
        flagDescription: 'Flag que recebe o esforço (ex.: "--thinking").',
        alsoRequired: ["values"],
        elseRequired: ["reason"],
        extra: {
          values: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description:
              'Valores aceitos por esta CLI, em ordem (ex.: ["low", "medium", "high"]). Obrigatório quando mechanism é "flag".',
          },
          reason: asEnum(EFFORT_NONE_REASONS, 'Por que não há esforço declarado. Obrigatório quando mechanism é "none".'),
        },
      }),
      model: mechanismObject({
        description: 'Como escolher o modelo. "none" só é aceito com reason "shell".',
        mechanisms: MODEL_MECHANISMS,
        flagValue: "flag",
        flagField: "flag",
        flagDescription: 'Flag que recebe o modelo (ex.: "-m").',
        elseRequired: ["reason"],
        extra: { reason: asEnum(MODEL_NONE_REASONS, 'Único reason aceito no lugar da flag: "shell".') },
      }),
      delivery: mechanismObject({
        description:
          '"positional" = o brief vai no fim do argv, atrás de `--` (que esta CLI honra); "flag" exige ' +
          'briefFlag; "none" = não recebe brief (ex.: shell).',
        mechanisms: DELIVERY_BRIEF_MECHANISMS,
        flagValue: "flag",
        mechanismKey: "briefMechanism",
        flagField: "briefFlag",
        flagDescription: 'Flag que recebe o brief (ex.: "--prompt").',
      }),
    },
  };
}

/**
 * O JSON Schema do arquivo. GERADO a partir das mesmas listas que o
 * validador usa — ver o bloco acima e o teste anti-drift.
 */
export function providersConfigSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Stellar — providers.json",
    description:
      `Providers de CLI declarados pelo usuário (${PROVIDERS_CONFIG_FILENAME}, no userData do Stellar). ` +
      "Cada entrada de `providers` é um CLI que o Stellar passa a poder spawnar como card. " +
      "Editar este arquivo NÃO exige reiniciar: o Stellar o observa e re-sincroniza o registro vivo, " +
      "reportando quantos providers entraram, saíram e qual entrada foi recusada. " +
      "Chaves desconhecidas são ignoradas no carregamento — use-as como suas notas.",
    type: "object",
    required: ["schemaVersion", "providers"],
    properties: {
      $schema: asStr("Aponta para este schema, para o editor autocompletar e validar enquanto você edita."),
      schemaVersion: {
        const: PROVIDERS_CONFIG_SCHEMA_VERSION,
        description:
          `Versão do FORMATO do arquivo (não do app). Hoje só ${PROVIDERS_CONFIG_SCHEMA_VERSION} é entendida — ` +
          "uma versão desconhecida faz o arquivo inteiro ser recusado, em vez de interpretado por sorte.",
      },
      providers: {
        type: "array",
        description:
          "Os providers declarados. Um id igual ao de um provider nativo (claude, codex, cursor, antigravity, " +
          "opencode, bash) é recusado — o nativo sempre ganha. Um id igual ao do catálogo embutido " +
          "(cline, commandcode) SUBSTITUI a declaração embutida inteira, campo por campo: é assim que você MUDA " +
          "o que o Stellar já entrega. A consequência de copiar por copiar está nos `examples` abaixo — eles são " +
          "as declarações REAIS que o app já usa, então só valem a pena se você quiser mudar alguma coisa nelas.",
        items: {
          type: "object",
          description:
            "Um provider. Os `examples` deste schema são as declarações medidas que JÁ VÊM PRONTAS no Stellar " +
            "(cline e commandcode): o app sobe os dois sem você escrever nada. Copiar uma delas para `providers` " +
            "cria uma entrada SUA com o mesmo id, e a sua VENCE a embutida — que é o que permite sobrescrever. O " +
            "custo, medido: a partir da cópia, as correções que o app fizer naquela declaração em versões novas " +
            "NÃO chegam até ela (sua cópia fica congelada na versão em que você copiou). Copie só se quiser MUDAR " +
            "algo — para usar, não precisa copiar nada.",
          required: ["id", "label", "binaryNames", "capacity"],
          // A receita copiável, GERADA das specs embutidas (ver
          // `measuredProviderRecipes`): um literal aqui divergiria do código no
          // primeiro dia, e o schema é reescrito a cada boot, então o que está
          // publicado é sempre o que este build de fato usa.
          examples: measuredProviderRecipes(),
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z0-9][a-z0-9-]*$",
              description: 'Id estável, usado em spawn_agent, no card e no banco (ex.: "minha-cli"). Minúsculas, dígitos e `-`.',
            },
            label: asNonEmptyStr("Nome exibido na UI (Topbar/rail)."),
            binaryNames: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
              description: 'Nomes tentados em ordem por which() — o primeiro que resolver (ex.: ["cline"]).',
            },
            installCommand: {
              type: ["object", "null"],
              required: ["posix", "windows"],
              properties: {
                posix: asNonEmptyStr("Como instalar no Linux/macOS."),
                windows: asNonEmptyStr("Como instalar no Windows."),
              },
              description: 'Sugestão de instalação por SO. null = nunca acusar "não instalado".',
            },
            baseArgs: {
              type: "array",
              items: { type: "string", minLength: 1 },
              description:
                'Flags que esta CLI SEMPRE precisa, uma por item (ex.: ["--yolo"]). Entram no argv logo depois do ' +
                "binário e ANTES de tudo que o Stellar deriva (sessão, modelo, esforço, prompt de sistema) — assim " +
                "um default escrito aqui nunca sobrepõe a identidade de sessão do card. Cada item é UM elemento de " +
                "argv: não há split por espaço nem shell, então valores com espaço são legítimos. Recusados: item " +
                "vazio, `--` (encerraria o parsing de opções) e NUL. [] ou ausente = nenhum.",
            },
            bypassesPermissionPrompts: asBool(
              'true = MEDIDO: as flags fixas acima dispensam os prompts de permissão desta CLI (ex.: "--yolo" no ' +
                "command-code, medido no --help 1.58.1). Declare só para flag que VOCÊ mediu; ausente = sem claim — " +
                "a UI mostra as flags sem o efeito. Isto é declaração, nunca detecção: o Stellar não deduz efeito " +
                "de string nenhuma.",
            ),
            capacity: capacitySchema(),
          },
        },
      },
      _example: {
        type: "object",
        description:
          "Exemplo completo, NÃO lido pelo Stellar: copie o objeto para dentro de `providers` para ele valer. " +
          "As descrições de cada campo e os valores aceitos estão neste schema (autocompletar do editor).",
      },
    },
  };
}

/** O schema serializado como vai para o disco. */
export function providersConfigSchemaJson(): string {
  return `${JSON.stringify(providersConfigSchema(), null, 2)}\n`;
}

/**
 * O spec do exemplo que vai no arquivo inicial. VÁLIDO pelo próprio
 * validador (travado em teste): um exemplo que o loader recusa seria a
 * primeira instrução errada que o usuário leria.
 */
export const PROVIDERS_CONFIG_EXAMPLE: DynamicProviderSpec = {
  id: "minha-cli",
  label: "Minha CLI",
  binaryNames: ["minha-cli"],
  installCommand: { posix: "npm install -g minha-cli", windows: "npm install -g minha-cli" },
  baseArgs: ["--yolo"],
  capacity: {
    role: "agent",
    session: { canImposeSessionId: false, resumeFlag: "--resume" },
    systemPrompt: { mechanism: "none" },
    mcp: { mechanism: "none" },
    acbridgeOnPath: true,
    effort: { mechanism: "none", reason: "no-flag" },
    model: { mechanism: "none", reason: "shell" },
    delivery: { briefMechanism: "positional" },
  },
};

/**
 * O conteúdo do arquivo quando ele NASCE (primeiro save do app). Em vez de
 * `{ "providers": [] }` — que não instrui nada — sai com `$schema` (para o
 * editor autocompletar) e o exemplo acima em `_example`, que o loader ignora
 * justamente por não estar em `providers`.
 *
 * Devolve o OBJETO, não a string, porque quem grava é o main
 * (`writeProvidersConfig`, em `index.ts`), cujo contrato preserva as chaves
 * que não conhece — assim `$schema` e `_example` sobrevivem a toda reedição
 * feita pelo formulário.
 */
export function initialProvidersConfig(): Record<string, unknown> {
  return {
    $schema: PROVIDERS_SCHEMA_REF,
    schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION,
    providers: [],
    _example: PROVIDERS_CONFIG_EXAMPLE,
  };
}

export function initialProvidersConfigJson(): string {
  return `${JSON.stringify(initialProvidersConfig(), null, 2)}\n`;
}

export type EnsureProvidersSchemaResult = {
  path: string;
  /** `true` só quando o arquivo foi (re)escrito nesta chamada. */
  written: boolean;
  /** Falha de escrita (permissão, disco). O schema é conveniência de
   * editor, nunca pré-condição de nada — então isto não lança nem impede o
   * app, mas também não some em silêncio. */
  error: string | null;
};

/**
 * Garante o schema ao LADO do `providers.json`, ATUALIZADO: um schema velho
 * depois de um upgrade do app autocompletaria campos que o build atual não
 * aceita, que é a versão mais cruel do problema original. Idempotente (relê
 * e só escreve quando o conteúdo difere) e por rename (temporário + rename,
 * mesma postura de `writeProvidersConfig`) para nunca deixar um schema pela
 * metade invalidando o editor de quem está editando agora.
 */
export function ensureProvidersSchemaFile(userDataDir: string): EnsureProvidersSchemaResult {
  const path = providersSchemaPath(userDataDir);
  const text = providersConfigSchemaJson();
  try {
    // Ausente ou ilegível cai no catch e é reescrito — não é erro.
    if (readFileSync(path, "utf8") === text) return { path, written: false, error: null };
  } catch {
    /* escreve abaixo */
  }
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
    return { path, written: true, error: null };
  } catch (err) {
    return { path, written: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// O ARQUIVO NASCE INSTRUÍDO, E O QUE JÁ EXISTE É COMPLETADO (2026-09-20, task
// d9aa8b1a).
//
// O relato do dono: "o schema não está no providers.json, eu fui clicar para
// editar; o cline e o commandcode não estão, e não tem o schema e explicação
// nele". E a causa medida: `initialProvidersConfig` e `ensureProvidersSchemaFile`
// existiam desde a 64aed52b, documentados e testados, e NÃO TINHAM UM CHAMADOR
// em código de produção — o arquivo real do dono tinha 44 bytes
// (`{ "schemaVersion": 1, "providers": [] }`), exatamente o caso que a primeira
// foi escrita para evitar. O bloco abaixo é a metade que faltava: quem chama.
//
// A LIÇÃO, registrada aqui porque é a parte que vale mais que o conserto: os
// testes chamavam as duas funções DIRETO, então passavam; o `tsc` não reclama
// porque elas são exportadas; e a revisão leu o desenho e aprovou. Uma função
// exportada, testada e sem chamador atravessa todos os portões que existiam —
// por isso a fiação ganhou UM símbolo (`bootstrapProvidersConfig`) e um gate
// que pergunta "alguém chama isto?" (tests/unit/providers-config-seed.test.ts).
// ---------------------------------------------------------------------------

/**
 * As chaves que fazem o arquivo SE EXPLICAR SOZINHO, na ordem em que aparecem
 * no arquivo. `$schema` é o que faz o editor autocompletar e validar; `_example`
 * é uma declaração completa, que o loader IGNORA (não está em `providers`),
 * posta ali para ser copiada.
 */
export const PROVIDERS_INSTRUCTION_KEYS = ["$schema", "_example"] as const;

export type ProvidersSeedPlan = {
  /** O conteúdo que deve ir para o disco. É o MESMO objeto de `raw` quando
   * nada falta — nesse caso o chamador não grava nada. */
  next: Record<string, unknown>;
  /** Chaves que faltavam, na ordem. Vazio = não há o que gravar. */
  addedKeys: string[];
};

/**
 * Decide o que ACRESCENTAR a um `providers.json` que já existe. Pura: sem fs,
 * sem relógio — é isto que o teste exercita direto, e é onde mora a única
 * decisão desta migração.
 *
 * A REGRA, estreita de propósito: só entra o que está FALTANDO. `providers`
 * nunca é tocado (a lista é do usuário), e uma chave que JÁ EXISTE fica como
 * está — mesmo `null`, mesmo apontando para outro schema, mesmo que o usuário
 * tenha reescrito `_example` como bloco de notas. O contrato do arquivo diz
 * que chaves desconhecidas são do dono (`additionalProperties` fica aberto no
 * schema justamente por isso); sobrescrever uma delas seria o app decidindo
 * pelo dono da máquina dentro do único arquivo que ele edita à mão.
 *
 * Consequência aceita e declarada: o `_example` de um arquivo antigo NÃO
 * acompanha os exemplos novos do app. Quem carrega a documentação sempre
 * atualizada é o `providers.schema.json`, que o app reescreve a cada boot — o
 * `_example` é conveniência, não a fonte da instrução.
 */
export function planProvidersSeed(raw: Record<string, unknown>): ProvidersSeedPlan {
  const missing = PROVIDERS_INSTRUCTION_KEYS.filter((key) => !(key in raw));
  if (missing.length === 0) return { next: raw, addedKeys: [] };
  const seed = initialProvidersConfig();
  const next: Record<string, unknown> = {};
  // `$schema` ABRE o arquivo (é o primeiro campo que o editor lê) e
  // `_example` FECHA — a mesma ordem em que o arquivo nasce. As chaves do
  // usuário ficam entre as duas, na ordem em que ele mesmo as escreveu, e
  // nenhuma delas é reordenada.
  if (missing.includes("$schema")) next.$schema = seed.$schema;
  for (const [key, value] of Object.entries(raw)) next[key] = value;
  if (missing.includes("_example")) next._example = seed._example;
  return { next, addedKeys: [...missing] };
}

export type EnsureProvidersConfigResult = {
  path: string;
  /**
   * `created` = não existia e nasceu instruído; `migrated` = existia e ganhou
   * a(s) chave(s) que faltavam; `unchanged` = já estava completo, nada foi
   * escrito; `invalid`/`unreadable` = NÃO foi tocado (o motivo vai em `error`);
   * `unwritable` = a leitura deu certo e a gravação falhou.
   */
  action: "created" | "migrated" | "unchanged" | "invalid" | "unreadable" | "unwritable";
  /** Chaves acrescentadas nesta chamada (vazio em todos os outros casos). */
  addedKeys: string[];
  /** Impedimento de leitura/escrita, ou JSON inválido. `null` no caminho bom. */
  error: string | null;
};

/** Gravação ATÔMICA do conteúdo semeado (tmp + rename) — mesma postura do
 * `writeProvidersConfig` do main, e pelo mesmo motivo: um `writeFileSync`
 * interrompido no meio deixaria ilegível um arquivo que o usuário edita à mão
 * por definição, e ele é o único registro dos providers dele. */
function writeProvidersSeed(
  path: string,
  content: Record<string, unknown>,
  action: "created" | "migrated",
  addedKeys: string[],
): EnsureProvidersConfigResult {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return { path, action, addedKeys, error: null };
  } catch (err) {
    return {
      path,
      action: "unwritable",
      addedKeys: [],
      error: `could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Garante que o `providers.json` EXISTA e SE EXPLIQUE. Nunca lança: arquivo de
 * config não pode derrubar o boot, e o resultado conta o que aconteceu para
 * quem chamou poder mostrar (mesma postura de `loadDynamicProviders`).
 *
 * Três casos, três posturas:
 *
 *   1. AUSENTE (`ENOENT`) — é o NASCIMENTO: sai com `$schema`, `schemaVersion`,
 *      `providers: []` e `_example` (`initialProvidersConfig`). Apagar o
 *      arquivo não é um estado a preservar: no boot seguinte ele nasce de
 *      novo, instruído.
 *   2. EXISTENTE e completo — NADA é escrito (`unchanged`), em vez de um save
 *      silencioso a cada boot.
 *   3. EXISTENTE e POBRE (o caso medido do dono: 44 bytes, `{ "schemaVersion":
 *      1, "providers": [] }`) — MIGRA: acrescenta só o que falta
 *      (`planProvidersSeed`) e preserva todo o resto, `providers` incluído.
 *
 * E o que NÃO acontece, que é a parte que importa para quem edita à mão:
 * ARQUIVO COM JSON QUEBRADO (ou ilegível) NÃO é tocado nem "consertado". A
 * tentação de reescrever um arquivo inválido é grande, e é exatamente onde um
 * app destrói o trabalho de quem estava no meio de uma edição — o conteúdo é
 * do usuário, o app REPORT (`invalid`/`unreadable` + `error`) e o registro vivo
 * já fica como estava (o contrato de não-podar de `loadDynamicProviders`).
 */
export function ensureProvidersConfigFile(userDataDir: string): EnsureProvidersConfigResult {
  const path = providersConfigPath(userDataDir);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return {
        path,
        action: "unreadable",
        addedKeys: [],
        error: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return writeProvidersSeed(path, initialProvidersConfig(), "created", []);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      path,
      action: "invalid",
      addedKeys: [],
      error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isRecord(raw)) {
    return { path, action: "invalid", addedKeys: [], error: `${path} is not a JSON object` };
  }

  const plan = planProvidersSeed(raw);
  if (plan.addedKeys.length === 0) return { path, action: "unchanged", addedKeys: [], error: null };
  return writeProvidersSeed(path, plan.next, "migrated", plan.addedKeys);
}

export type ProvidersBootstrapResult = {
  schema: EnsureProvidersSchemaResult;
  config: EnsureProvidersConfigResult;
};

/**
 * O PASSO DE BOOT dos providers: o schema ao lado (conveniência de editor,
 * reescrito quando o app muda) e o arquivo do usuário existente e instruído.
 * Os dois são idempotentes, nenhum lança, e nenhum dos dois mexe no registro
 * vivo — quem registra é `loadDynamicProviders`, que o main chama logo depois.
 *
 * Por que UMA função em vez de duas chamadas soltas no `index.ts`: é ESTE
 * símbolo que o gate de fiação procura. A função existe para dar nome à
 * fiação, e o nome existe para um teste poder afirmar "isto é chamado de
 * produção" — que é a pergunta que nenhum gate anterior fazia.
 */
export function bootstrapProvidersConfig(userDataDir: string): ProvidersBootstrapResult {
  return {
    schema: ensureProvidersSchemaFile(userDataDir),
    config: ensureProvidersConfigFile(userDataDir),
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
    return {
      specs: [],
      rejected: [
        {
          index: -1,
          id: null,
          reason: refusal("the root of the file", "a JSON object like { \"$schema\": …, \"schemaVersion\": 1, \"providers\": [ … ] }", raw),
        },
      ],
    };
  }
  if (raw.schemaVersion !== PROVIDERS_CONFIG_SCHEMA_VERSION) {
    return {
      specs: [],
      rejected: [
        {
          index: -1,
          id: null,
          reason: refusal(
            "schemaVersion",
            `the number ${PROVIDERS_CONFIG_SCHEMA_VERSION} (the only version this build understands)`,
            raw.schemaVersion,
          ),
        },
      ],
    };
  }
  if (!Array.isArray(raw.providers)) {
    return {
      specs: [],
      rejected: [
        { index: -1, id: null, reason: refusal("providers", "an array of provider objects (empty array is fine)", raw.providers) },
      ],
    };
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
      rejected.push({
        index,
        id: parsed.spec.id,
        reason:
          `duplicate id "${parsed.spec.id}" in the same file — the first entry with this id wins; ` +
          "remove one of them",
      });
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
  // Os args FIXOS vêm PRIMEIRO, logo depois do binário — ver o campo
  // `baseArgs` em `DynamicProviderSpec` para a justificativa da posição e
  // para o que a validação recusa. Nenhum `if` por id em lugar nenhum: o
  // array é dado, igual ao resto da declaração.
  const baseArgs = spec.baseArgs ?? [];
  return (opts) => {
    const args: string[] = [...baseArgs];
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

/**
 * Uma entrada da DECLARAÇÃO efetiva de uma leitura: o id que o registro
 * recebeu e uma impressão digital do spec que o declarou.
 *
 * A impressão é o que permite dizer "o def deste id MUDOU" (rótulo, binário,
 * flag de effort) numa releitura em que nenhum id entrou nem saiu — sem ela,
 * editar o `binaryNames` de um provider já registrado seria reportado como
 * "nada mudou", que é exatamente a classe de mentira que este módulo evita.
 */
export type DeclaredProvider = { id: ProviderId; fingerprint: string };

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
  /** A DECLARAÇÃO desta leitura (catálogo embutido + arquivo, já sem os ids
   * que o arquivo sobrepõe), com a impressão digital de cada spec. É o
   * `registered` com o que falta para um diff honesto entre duas leituras:
   * ATENÇÃO, em leitura recusada no topo ou ilegível esta lista é só o
   * catálogo embutido (o que o arquivo dizia é desconhecido) enquanto o
   * registro vivo continua com a carga anterior — quem compara duas leituras
   * precisa usar `removed` (o efeito real) e não esta lista sozinha. */
  effective: DeclaredProvider[];
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
    effective: effective.map((spec) => ({ id: spec.id, fingerprint: JSON.stringify(spec) })),
    skipped: result.skipped,
    rejected: parsed.rejected,
    shippedDefaults: shippedEffective.map((s) => s.id),
    removed: result.removed,
  };
}

// ---------------------------------------------------------------------------
// WATCHER — editar `providers.json` passa a surtir efeito sem reiniciar
// (2026-09-20, task 510df7b9), COM o relatório do que aconteceu.
//
// O QUE JÁ EXISTIA, e o que faltava: `loadDynamicProviders` já era
// re-chamável e já sincronizava o registro vivo (inclusive podando o que
// saiu do arquivo — ver o doc comment dele). O que não existia era o
// GATILHO: a releitura só acontecia no boot e quando a tela de Settings
// pedia. Este bloco é o gatilho, e nada mais — nenhuma segunda cópia da
// regra de carga.
//
// A METADE "VISUALIZAR" DO PEDIDO é este relatório. Um watcher que aplica em
// silêncio troca um problema (não aplica até reiniciar) por um pior (aplicou
// pela metade e ninguém viu), então cada releitura produz um
// `ProvidersReloadReport` com o que entrou, o que saiu, o que mudou de def,
// o que foi recusado e QUAL linha, quando o parser soube dizer. Quem chama
// decide onde isso aparece (a casca em `index.ts` loga e empurra pro
// renderer).
//
// OS QUATRO CUIDADOS REAIS, e onde cada um está resolvido aqui:
//
//   (a) editor salva em VÁRIAS escritas — debounce TRAILING (o timer reinicia
//       a cada evento): só depois de `debounceMs` de silêncio o arquivo é
//       lido, que é quando o save terminou. Ler no primeiro evento pegaria
//       JSON truncado no meio do save.
//   (b) arquivo momentaneamente inválido NÃO derruba o registro vivo — isso
//       não é responsabilidade do watcher, é do loader: `pruneMissing` fica
//       DESLIGADO quando a leitura falhou ou o topo foi recusado (o contrato
//       que a task c379112f separou e travou em teste). O watcher só garante
//       que um erro de leitura nunca vire um "0 providers" silencioso: o
//       relatório sai como `kept-last-good` com o erro e a linha.
//   (c) `pruneMissing` num arquivo ilegível apagaria providers em uso — é o
//       mesmo contrato acima, e é por isso que este módulo NUNCA chama
//       `registerDynamicProviders` por conta própria: o único caminho é
//       `loadDynamicProviders`.
//   (d) provider removido do arquivo enquanto um card VIVO o usa: o deff sai
//       do registro e o card continua rodando. O PTY já existe, o
//       `pty-registry` não consulta `PROVIDERS` para ler/escrever nele (a
//       consulta é no spawn e na restauração de sessão), então matar o
//       processo ou bloquear o card seria destruir trabalho do usuário por
//       causa de uma edição de arquivo. O que muda é o FUTURO: aquele id não
//       aparece mais em `checkAgentAvailability` nem aceita spawn novo — e o
//       relatório nomeia o id em `removed`, que é a parte visível da decisão.
// ---------------------------------------------------------------------------

/** Silêncio exigido antes de reler. 300ms é maior que o intervalo entre as
 * escritas de um save típico (o editor escreve o arquivo de uma vez e, quando
 * não escreve, cria um temporário e renomeia) e pequeno o bastante para a
 * releitura parecer imediata para quem está olhando a tela. */
export const PROVIDERS_WATCH_DEBOUNCE_MS = 300;

/** O que aconteceu com o REGISTRO VIVO nesta releitura. */
export type ProvidersReloadOutcome =
  /** O registro mudou (ou alguma entrada foi recusada): entrou, saiu ou teve
   * def substituído. */
  | "applied"
  /** Arquivo relido e nada mudou de fato — é a resposta a "será que o app
   * viu o que eu editei?" quando a edição é cosmética ou não muda o registro. */
  | "unchanged"
  /** A leitura não pôde ser aplicada (JSON quebrado, permissão, formato
   * recusado no topo): o registro ficou EXATAMENTE como estava. */
  | "kept-last-good";

export type ProvidersReloadReport = {
  /** `Date.now()` do momento em que a releitura foi aplicada. */
  at: number;
  file: string;
  outcome: ProvidersReloadOutcome;
  /** Ids que passaram a existir no registro agora. */
  added: ProviderId[];
  /** Ids que já existiam e cujo def foi SUBSTITUÍDO por outro (mesmo id,
   * declaração diferente) — "entrou de novo" para quem está editando. */
  changed: ProviderId[];
  /** Ids DERRUBADOS do registro vivo por esta releitura. */
  removed: ProviderId[];
  /** Entradas recusadas pelo validador, com índice no array e motivo. */
  rejected: SpecRejection[];
  /** Impedimento de leitura/aplicação; `null` quando deu para ler e validar. */
  error: string | null;
  /** Linha (1-based) de um erro de SINTAXE JSON, quando o parser a deu. O
   * `JSON.parse` do Node só inclui "(line N column M)" em parte dos erros
   * (truncamento e chaves sem aspas, medidos; `Unexpected token` não traz) —
   * `null` aqui é "o parser não soube dizer", nunca um palpite. */
  errorLine: number | null;
  /** Quantos providers dinâmicos o registro tem DEPOIS desta releitura
   * (catálogo embutido incluído) — o total contra o qual "entrou/saiu" se lê. */
  total: number;
  /** Esta releitura é a SEGUNDA leitura da mesma mudança: a primeira veio
   * inválida (save em curso, tipicamente) e foi repetida antes de reportar. */
  retried: boolean;
};

/** Compara duas declarações (o `effective` de duas leituras). Pura. */
export function diffDeclaredProviders(
  previous: readonly DeclaredProvider[],
  next: readonly DeclaredProvider[],
): { added: ProviderId[]; changed: ProviderId[]; removed: ProviderId[] } {
  const before = new Map(previous.map((entry) => [entry.id, entry.fingerprint]));
  const after = new Map(next.map((entry) => [entry.id, entry.fingerprint]));
  const added: ProviderId[] = [];
  const changed: ProviderId[] = [];
  const removed: ProviderId[] = [];
  for (const [id, fingerprint] of after) {
    const previousFingerprint = before.get(id);
    if (previousFingerprint === undefined) added.push(id);
    else if (previousFingerprint !== fingerprint) changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id);
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/** A linha de um erro de sintaxe do `JSON.parse`, quando a mensagem a traz
 * ("... at position 11 (line 2 column 10)"). Pura e exportada pro teste. */
export function jsonErrorLine(message: string): number | null {
  const match = /\(line (\d+) column \d+\)/.exec(message);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : null;
}

/**
 * Duas leituras consecutivas → o relatório. Pura (nenhum I/O, nenhum
 * relógio): o `at` entra por parâmetro, o que a torna testável sem `fs`.
 *
 * A sutileza que este diff existe para não errar: em leitura RECUSADA, a
 * declaração desta leitura é só o catálogo embutido, mas o registro vivo
 * manteve a carga anterior — comparar as duas listas direto diria "os
 * providers do usuário saíram" quando ninguém saiu. Por isso `removed` vem do
 * EFEITO real (`next.removed`, que o loader só preenche quando podou) e
 * `added`/`changed` são filtrados por `next.registered`: o que a declaração
 * diz só conta se de fato chegou ao registro (um id que colide com um nativo
 * é recusado e não entra como "added").
 */
export function buildProvidersReloadReport(args: {
  previous: LoadDynamicProvidersResult;
  next: LoadDynamicProvidersResult;
  at: number;
  retried: boolean;
}): ProvidersReloadReport {
  const { previous, next, at, retried } = args;
  const registered = new Set<ProviderId>(next.registered);
  const diff = diffDeclaredProviders(previous.effective, next.effective);
  const added = diff.added.filter((id) => registered.has(id));
  const changed = diff.changed.filter((id) => registered.has(id));
  const removed = [...next.removed].sort();

  const fileLevelRejected = next.rejected.some((entry) => entry.index === -1);
  const keptLastGood = next.error !== null || fileLevelRejected;
  const outcome: ProvidersReloadOutcome = keptLastGood
    ? "kept-last-good"
    : added.length > 0 || changed.length > 0 || removed.length > 0
      ? "applied"
      : "unchanged";

  return {
    at,
    file: next.file,
    outcome,
    added,
    changed,
    removed,
    rejected: next.rejected,
    error: next.error,
    errorLine: next.error === null ? null : jsonErrorLine(next.error),
    total: next.registered.length,
    retried,
  };
}

function list(ids: readonly string[]): string {
  return ids.length === 0 ? "nenhum" : ids.join(", ");
}

function providers(count: number): string {
  return `${count} provider${count === 1 ? "" : "s"}`;
}

/**
 * O relatório em UMA linha, para log/journal — é a parte "visualizar" que não
 * depende de UI. pt-BR porque quem lê é o dono do repo: mesma postura das
 * mensagens de migração de userData em `index.ts`. Pura, exportada pro teste.
 */
export function formatProvidersReloadLine(report: ProvidersReloadReport): string {
  const head = `${report.file} relido`;
  const retryNote = report.retried ? " (relido após leitura inválida — save em curso)" : "";
  const rejectNote =
    report.rejected.length === 0
      ? ""
      : ` · ${report.rejected.length} recusa${report.rejected.length === 1 ? "" : "s"}: ${report.rejected
          .map((entry) => `${entry.index >= 0 ? `[${entry.index}]` : "[arquivo]"} ${entry.id ?? "?"}: ${entry.reason}`)
          .join(" | ")}`;

  if (report.outcome === "kept-last-good") {
    const where = report.errorLine === null ? "" : ` (linha ${report.errorLine})`;
    return (
      `${head}: NADA aplicado${where} — ${report.error ?? "arquivo recusado pelo schema"}. ` +
      `Registro mantido como estava: ${providers(report.total)}${retryNote}${rejectNote}`
    );
  }
  if (report.outcome === "unchanged") {
    return `${head}: nada entrou nem saiu — ${providers(report.total)} no registro${retryNote}${rejectNote}`;
  }
  return (
    `${head}: entraram ${list(report.added)}; mudaram de def ${list(report.changed)}; saíram ${list(report.removed)} ` +
    `— ${providers(report.total)} no registro${retryNote}${rejectNote}`
  );
}

/** O observador de diretório, injetável: o watcher de verdade é um `fs.watch`
 * não-recursivo NO DIRETÓRIO, e o teste recebe este gancho para dirigir os
 * eventos sem inotify nem timer de verdade. */
export type ProvidersDirWatcher = (
  dir: string,
  onChange: (filename: string | null) => void,
) => (() => void) | null;

/**
 * Observa o DIRETÓRIO e filtra pelo nome do arquivo — não o arquivo.
 *
 * Medido, e é o ponto que faz isto sobreviver a editores de verdade: o
 * caminho de escrita mais comum (inclusive o `writeProvidersConfig` de
 * `index.ts`, e o save atômico de qualquer editor decente) é escrever um
 * temporário e RENOMEAR por cima — o que troca o inode. Um `fs.watch` no
 * arquivo segue o inode antigo e para de receber eventos exatamente depois do
 * primeiro save; no diretório, o `rename` é só mais um evento de entrada.
 *
 * `filename === null` (o SO não disse qual entrada mudou) NÃO é ignorado:
 * reler é barato e idempotente, e perder a edição do usuário não é.
 */
export const watchProvidersConfigDir: ProvidersDirWatcher = (dir, onChange) => {
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dir, { recursive: false }, (_eventType, filename) => {
      onChange(filename === null ? null : String(filename));
    });
  } catch {
    // Diretório ausente/sem permissão: sem watcher o recurso continua
    // funcionando pelo caminho antigo (boot + tela de Settings). Não é
    // motivo para derrubar nada.
    return null;
  }
  // O `fs.watch` emite `error` (ex.: o diretório sumiu) — sem listener, um
  // erro do EventEmitter é uma exceção não tratada que mata o main process
  // (é a mesma classe do item 37 do DESIGN-BACKLOG). O registro vivo segue
  // no último estado bom.
  watcher.on("error", () => {
    /* registro mantido; o próximo evento do SO rearma a releitura */
  });
  return () => {
    try {
      watcher?.close();
    } catch {
      /* já fechado */
    }
  };
};

export type ProvidersWatcherOptions = {
  userDataDir: string;
  /** Só para teste: o mesmo catálogo embutido injetável do loader. */
  shipped?: readonly DynamicProviderSpec[];
  /** A leitura que já rodou no boot — a linha de base do primeiro diff. Sem
   * ela o watcher faz a própria leitura inicial (não reportada: não há
   * "antes" para comparar) e passa a usar ESSA como base. */
  baseline?: LoadDynamicProvidersResult;
  debounceMs?: number;
  /** Chamado UMA vez por mudança aplicada (nunca no baseline). */
  onReload: (report: ProvidersReloadReport) => void;
  now?: () => number;
  watchDir?: ProvidersDirWatcher;
};

export type ProvidersWatcher = {
  /** Para de observar e cancela um flush pendente. Idempotente. */
  stop(): void;
  /** Releitura imediata (não espera o debounce) — devolve e reporta. */
  reloadNow(): ProvidersReloadReport;
};

/**
 * O gatilho em si. Não importa `electron` (o relatório sai por callback —
 * quem decide mostrar é quem chamou), não lança, e a releitura é SÍNCRONA:
 * um evento do watcher nunca interleave com um `loadDynamicProviders` vindo
 * do IPC, então não existe corrida entre "a tela leu" e "o arquivo mudou".
 */
export function createProvidersConfigWatcher(opts: ProvidersWatcherOptions): ProvidersWatcher {
  const debounceMs = opts.debounceMs ?? PROVIDERS_WATCH_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  const watchDir = opts.watchDir ?? watchProvidersConfigDir;

  let previous = opts.baseline ?? loadDynamicProviders(opts.userDataDir, { shipped: opts.shipped });
  let timer: NodeJS.Timeout | null = null;
  let pendingRetry = false;
  let stopped = false;

  function loadAndReport(retried: boolean): ProvidersReloadReport {
    const next = loadDynamicProviders(opts.userDataDir, { shipped: opts.shipped });
    const report = buildProvidersReloadReport({ previous, next, at: now(), retried });
    // Só uma leitura APLICÁVEL vira linha de base. Numa recusa (`kept-last-
    // good`) o registro vivo continua sendo o da carga anterior, e adotar a
    // declaração recusada como "antes" faria a próxima leitura comparar
    // contra um estado que nunca existiu: os providers que nunca saíram do ar
    // apareceriam como "entraram" — medido, é o que este `if` evita (o teste
    // do save que se conserta sozinho falha sem ele).
    if (report.outcome !== "kept-last-good") previous = next;
    return report;
  }

  function arm() {
    if (stopped) return;
    // TRAILING: cada evento empurra o flush para frente, então só o silêncio
    // depois da última escrita faz o arquivo ser lido.
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, debounceMs);
  }

  function flush() {
    if (stopped) return;
    const report = loadAndReport(pendingRetry);
    // Um arquivo ilegível pode ser só o MEIO de um save (o editor escreve em
    // várias chamadas, e nem todo save é atômico): antes de reportar erro,
    // relê uma vez depois do mesmo silêncio. Se continuar inválido, é erro de
    // verdade e o relatório sai — o retry nunca engole uma falha persistente.
    if (report.outcome === "kept-last-good" && !pendingRetry) {
      pendingRetry = true;
      arm();
      return;
    }
    pendingRetry = false;
    opts.onReload(report);
  }

  const stopDirWatch = watchDir(opts.userDataDir, (filename) => {
    if (filename !== null && filename !== PROVIDERS_CONFIG_FILENAME) return;
    arm();
  });

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      stopDirWatch?.();
    },
    reloadNow() {
      pendingRetry = false;
      const report = loadAndReport(false);
      opts.onReload(report);
      return report;
    },
  };
}

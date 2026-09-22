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

import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
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
import builtinProvidersJson from "./data/providers.builtin.json";
import type { ReadinessProbe } from "./provider-readiness-decision";
import {
  SQL_IDENTIFIER_RE,
  type FileReadSpec,
  type SessionCwdSource,
  type SessionIdSource,
  type SessionStore,
  type SessionTimeSource,
} from "./session-store-spec";

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
   * COMO SABER QUE ESTE PROVIDER ESTÁ *PRONTO* — e não só instalado (task
   * 1777060e). Ausente = o app NÃO SABE, e a disponibilidade responde
   * `unknown` em vez de afirmar (o defeito que a task remove: "o binário
   * existe" tratado como "dá para usar").
   *
   * É DADO, e é por provider porque o caminho que responde "pronto" sem
   * chamar modelo varia por harness. Medido no `omp` (18.2.8):
   * `auth-broker status --json` responde `{"ok":false,"reason":"not_configured"}`
   * em 0,69s com exit 0 — o campo manda, não o exit code. O `hint` é o comando
   * que o HUMANO roda para sair do estado, declarado por quem mediu o CLI:
   * a UI não inventa texto de comando.
   */
  readiness?: ReadinessProbe | null;
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
      /** ONDE ESTA CLI GUARDA SESSÃO (task 2ea0269f) — a declaração que dá
       * ao rodapé do card de onde vir. A LINGUAGEM é `SessionStore`
       * (`session-store-spec.ts`, com o levantamento medido ao lado do
       * leitor) e o único leitor é `session-watch.ts`.
       *
       * AUSENTE = este provider não é observável, e isso é honesto: sem
       * âncora medida de cwd e de tempo, varrer o disco às cegas acharia o
       * arquivo de outro card. Um store pode declarar só a DESCOBERTA (sem
       * `read`) — a resposta de leitura continua saindo da declaração, nunca
       * inventada: são canais diferentes. */
      store?: SessionStore;
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
    delivery: {
      briefMechanism: "positional" | "flag" | "none";
      briefFlag?: string;
      /**
       * Como esta CLI sinaliza o FIM de um turno (task 0dd5c145). Ausente =
       * não sinaliza, e a UI NÃO promete — mesma regra da ausência de esforço.
       * `pattern` é a FONTE da regex, em texto (ver
       * `DELIVERY_TURN_END_MECHANISMS` para o porquê).
       */
      turnEnd?: { mechanism: "hook" } | { mechanism: "screen"; pattern: string };
    };
  };
};

/**
 * O CATÁLOGO DO APP É DADO, NÃO CÓDIGO (task 3fe0db6e, desenho (E) aprovado).
 *
 * As duas declarações que o Stellar entrega prontas (cline, commandcode) vivem
 * em `data/providers.builtin.json` — arquivo de DADOS versionado, ao lado do
 * código, com o MESMO formato do `providers.json` do usuário. O TypeScript fica
 * com a GRAMÁTICA (o tipo `DynamicProviderSpec`, `parseProviderSpec`,
 * `dynamicProviderDef`, o schema publicado); a DECLARAÇÃO é dado.
 *
 * POR QUE (medido, e a razão é o dono ter olhado o resultado e recusado o
 * desenho anterior): declaração enterrada em código é declaração que ninguém
 * confere. O defeito do `cline` (task 6c42314) nasceu assim — a spec afirmava
 * `canImposeSessionId: true` com `imposeFlag: "--id"` e um comentário dizendo
 * "Medido, não presumido"; o `--help` da PRÓPRIA CLI diz `--id <session-id>
 * Resume an existing session by ID`, e o app passou a mandar a CLI RETOMAR
 * sessão que nunca existiu. Em dado, a mesma correção é uma linha de JSON,
 * diffável e confrontável com o `--help` na revisão.
 *
 * POR QUE O CATÁLOGO CONTINUA EMBARCADO NO APP, e não no arquivo do usuário:
 * duas exigências medidas proíbem que a origem seja o `providers.json` —
 * (1) apagar o arquivo do usuário não pode fazer cline/commandcode sumirem;
 * (2) correção do app numa declaração não editada tem de chegar a quem nunca a
 * editou. As duas só fecham se a declaração existir FORA do arquivo do usuário;
 * dado embarcado é o único ponto que atende às duas E tira a declaração do
 * código. O usuário continua sobrescrevendo campo a campo pelo `providers.json`
 * (um id igual ao de cá VENCE por campo — ver `mergeProviderOverride`).
 *
 * O `omp` NÃO entra aqui: `--resume` com o nome inteiro do arquivo como id não
 * foi medido (sem credencial o processo pendura antes de responder), e embarcar
 * campo não medido para TODOS os usuários é o que "medido, não presumido"
 * proíbe. Ele vive no arquivo do dono até alguém medir.
 */
let builtinSpecsCache: ParseProviderSpecsResult | null = null;

/**
 * O catálogo lido do dado, COM as recusas nomeadas.
 *
 * Existe por uma medição da própria task: devolver só `.specs` faz uma
 * declaração recusada DESAPARECER em silêncio do registro (medido com a mutação
 * `cline.canImposeSessionId = true`, que o validador recusa por falta de
 * `imposeFlag`: o provider sumia e nada acusava). Quem chama esta versão pode
 * REPORTAR; `tests/unit/providers-data-contract.test.ts` exige zero recusas.
 */
export function shippedProviderSpecsResult(): ParseProviderSpecsResult {
  if (builtinSpecsCache === null) {
    builtinSpecsCache = parseProviderSpecs(
      {
        schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION,
        providers: (builtinProvidersJson as { providers?: unknown }).providers ?? [],
      },
      {},
    );
  }
  return builtinSpecsCache;
}

/** O catálogo que ESTE build entrega, já validado pela mesma gramática que o
 * arquivo do usuário usa. É a fonte de `shipped` em todo `loadDynamicProviders`
 * e o que a tela rotula como "do app". */
export function shippedProviderSpecs(): DynamicProviderSpec[] {
  return shippedProviderSpecsResult().specs;
}

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
// specs do CATÁLOGO DO APP para o arquivo do usuário COLAPSA a
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
  return shippedProviderSpecs().map((spec) => structuredClone(spec));
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
/** Como um provider DINÂMICO declara o FIM de turno (task 0dd5c145) — o
 * espelho, no arquivo, do `TurnEndSignal` dos nativos (`providers.ts`).
 *
 * A diferença de forma é de ARMAZENAMENTO, não de ideia: aqui o padrão é
 * TEXTO (fonte de regex), e não `RegExp`, porque este spec é ESCRITO EM DISCO
 * (`appProviders`, reescrito a cada boot). Um `RegExp` serializaria para `{}` e
 * a declaração morreria na ida e volta. Quem compila é `dynamicProviderDef`. */
export const DELIVERY_TURN_END_MECHANISMS = ["hook", "screen"] as const;
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
// ---------------------------------------------------------------------------
// O STORE DE SESSÃO (task 2ea0269f) — o validador da declaração
//
// Mesma postura do resto deste arquivo: recusar DIZENDO o que se esperava e o
// que chegou, nomeando o campo por inteiro (`capacity.session.store.<...>`),
// em vez de aceitar e largar. Um store aceito mas malformado não falha alto —
// ele faz o watcher procurar no lugar errado, que é o dano que a declaração
// existe para evitar.
// ---------------------------------------------------------------------------

const SESSION_ID_SOURCES = ["fileName", "dirName", "jsonLine"] as const;
const SESSION_CWD_SOURCES = ["root", "jsonLine", "json", "binaryWorkspaceUri"] as const;
const SESSION_TIME_SOURCES = ["mtime", "json"] as const;
const SESSION_STORE_KINDS = ["files", "sqlite"] as const;
const SQLITE_TIME_FORMATS = ["epoch-ms", "iso-8601"] as const;

type StoreParse<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Um caminho de navegação em JSON (`["payload", "session_id"]`): não-vazio,
 * e cada item um nome — um item vazio navegaria para lugar nenhum. */
function parseJsonPath(value: unknown, field: string): StoreParse<string[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: refusal(field, 'a non-empty array of JSON keys (e.g. ["payload", "session_id"])', value === undefined ? RECEIVED_NOTHING : value) };
  }
  const path: string[] = [];
  for (const key of value) {
    const parsed = nonEmptyString(key);
    if (parsed === null) return { ok: false, reason: refusal(field, "a non-empty array of JSON keys", key) };
    path.push(parsed);
  }
  return { ok: true, value: path };
}

function parseIdSource(raw: unknown, field: string): StoreParse<SessionIdSource> {
  if (!isRecord(raw)) {
    return { ok: false, reason: refusal(field, `an object with \`from\` one of ${acceptedList(SESSION_ID_SOURCES)}`, raw) };
  }
  // Nomeia o CAMPO do enum (`...id.from`), não o objeto que o contém: é onde
  // o humano põe o cursor, e é o que o teste anti-drift exige que a recusa
  // cite — uma recusa que não nomeia o campo obriga a caçada por tentativa.
  if (!isOneOf(raw.from, SESSION_ID_SOURCES)) {
    return { ok: false, reason: refusal(`${field}.from`, `one of ${acceptedList(SESSION_ID_SOURCES)}`, raw.from === undefined ? RECEIVED_NOTHING : raw.from) };
  }
  if (raw.from === "fileName") {
    const strip = nonEmptyString(raw.strip);
    if (strip === null) {
      return { ok: false, reason: refusal(`${field}.strip`, 'the file suffix to remove (e.g. ".jsonl") — required when `from` is "fileName"', raw.strip === undefined ? RECEIVED_NOTHING : raw.strip) };
    }
    return { ok: true, value: { from: "fileName", strip } };
  }
  if (raw.from === "jsonLine") {
    const path = parseJsonPath(raw.path, `${field}.path`);
    if (!path.ok) return path;
    return { ok: true, value: { from: "jsonLine", path: path.value } };
  }
  return { ok: true, value: { from: "dirName" } };
}

function parseCwdSource(raw: unknown, field: string): StoreParse<SessionCwdSource> {
  if (raw === "root") return { ok: true, value: { from: "root" } };
  if (!isRecord(raw)) {
    return { ok: false, reason: refusal(field, `"root" or an object with \`from\` one of ${acceptedList(SESSION_CWD_SOURCES)}`, raw) };
  }
  if (!isOneOf(raw.from, SESSION_CWD_SOURCES)) {
    return { ok: false, reason: refusal(`${field}.from`, `"root" or one of ${acceptedList(SESSION_CWD_SOURCES)}`, raw.from === undefined ? RECEIVED_NOTHING : raw.from) };
  }
  if (raw.from === "root") return { ok: true, value: { from: "root" } };
  if (raw.from === "binaryWorkspaceUri") return { ok: true, value: { from: "binaryWorkspaceUri" } };
  const path = parseJsonPath(raw.path, `${field}.path`);
  if (!path.ok) return path;
  return raw.from === "json"
    ? { ok: true, value: { from: "json", path: path.value } }
    : { ok: true, value: { from: "jsonLine", path: path.value } };
}

function parseTimeSource(raw: unknown, field: string): StoreParse<SessionTimeSource> {
  if (!isRecord(raw)) {
    return { ok: false, reason: refusal(field, `an object with \`from\` one of ${acceptedList(SESSION_TIME_SOURCES)}`, raw) };
  }
  if (!isOneOf(raw.from, SESSION_TIME_SOURCES)) {
    return { ok: false, reason: refusal(`${field}.from`, `one of ${acceptedList(SESSION_TIME_SOURCES)}`, raw.from === undefined ? RECEIVED_NOTHING : raw.from) };
  }
  if (raw.from === "mtime") return { ok: true, value: { from: "mtime" } };
  const path = parseJsonPath(raw.path, `${field}.path`);
  if (!path.ok) return path;
  return { ok: true, value: { from: "json", path: path.value } };
}

/** `{minBytes}` (o próprio registro tem bytes) ou `{file}` (um arquivo DENTRO
 * do registro — o `store.db` do cursor). */
function parseFileContent(raw: unknown, field: string): StoreParse<FileReadSpec["content"]> {
  if (!isRecord(raw)) {
    return { ok: false, reason: refusal(field, 'an object with `minBytes` (a positive number) or `file` (a name inside the record)', raw) };
  }
  if (raw.minBytes !== undefined) {
    if (typeof raw.minBytes !== "number" || !Number.isFinite(raw.minBytes) || raw.minBytes <= 0) {
      return { ok: false, reason: refusal(`${field}.minBytes`, "a positive number", raw.minBytes) };
    }
    return { ok: true, value: { minBytes: raw.minBytes } };
  }
  const file = nonEmptyString(raw.file);
  if (file === null) {
    return { ok: false, reason: refusal(`${field}.file`, "a non-empty file name inside the record (e.g. \"store.db\")", raw.file === undefined ? RECEIVED_NOTHING : raw.file) };
  }
  return { ok: true, value: { file } };
}

function parseSqliteColumns(raw: Record<string, unknown>, columns: readonly string[], field: string): StoreParse<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const column of columns) {
    const name = nonEmptyString(raw[column]);
    if (name === null) {
      return { ok: false, reason: refusal(`${field}.${column}`, "a non-empty column name", raw[column] === undefined ? RECEIVED_NOTHING : raw[column]) };
    }
    if (!SQL_IDENTIFIER_RE.test(name)) {
      return { ok: false, reason: refusal(`${field}.${column}`, `a plain SQL identifier (letters, digits, _ — got ${describeValue(name)})`, name) };
    }
    out[column] = name;
  }
  return { ok: true, value: out };
}

/** O store de UM provider, validado por inteiro. Exportado para o teste
 * poder exercitar cada recusa sem montar um arquivo. */
export function parseSessionStore(raw: unknown): StoreParse<SessionStore> {
  const field = "capacity.session.store";
  if (!isRecord(raw)) {
    return { ok: false, reason: refusal(field, `an object with \`kind\` one of ${acceptedList(SESSION_STORE_KINDS)}`, raw) };
  }
  if (!isOneOf(raw.kind, SESSION_STORE_KINDS)) {
    return { ok: false, reason: refusal(`${field}.kind`, `one of ${acceptedList(SESSION_STORE_KINDS)}`, raw.kind === undefined ? RECEIVED_NOTHING : raw.kind) };
  }

  if (raw.kind === "sqlite") {
    const db = nonEmptyString(raw.db);
    if (db === null) {
      return { ok: false, reason: refusal(`${field}.db`, 'the database path (e.g. "~/.local/share/opencode/opencode.db")', raw.db === undefined ? RECEIVED_NOTHING : raw.db) };
    }
    let timeFormat: (typeof SQLITE_TIME_FORMATS)[number] | undefined;
    if (raw.timeFormat !== undefined && raw.timeFormat !== null) {
      if (!isOneOf(raw.timeFormat, SQLITE_TIME_FORMATS)) {
        return { ok: false, reason: refusal(`${field}.timeFormat`, `one of ${acceptedList(SQLITE_TIME_FORMATS)}`, raw.timeFormat) };
      }
      timeFormat = raw.timeFormat;
    }
    if (!isRecord(raw.discovery)) {
      return { ok: false, reason: refusal(`${field}.discovery`, "an object with `table`, `idColumn`, `cwdColumn` and `timeColumn`", raw.discovery) };
    }
    const discovery = parseSqliteColumns(raw.discovery, ["table", "idColumn", "cwdColumn", "timeColumn"], `${field}.discovery`);
    if (!discovery.ok) return discovery;

    let read: Extract<SessionStore, { kind: "sqlite" }>["read"];
    if (raw.read !== undefined && raw.read !== null) {
      if (!isRecord(raw.read)) {
        return { ok: false, reason: refusal(`${field}.read`, "an object with `table`, `idColumn`, `timeColumn`, `contentTable` and `contentColumn`", raw.read) };
      }
      const columns = parseSqliteColumns(raw.read, ["table", "idColumn", "timeColumn", "contentTable", "contentColumn"], `${field}.read`);
      if (!columns.ok) return columns;
      const c = columns.value as { table: string; idColumn: string; timeColumn: string; contentTable: string; contentColumn: string };
      read = c;
    }
    return {
      ok: true,
      value: {
        kind: "sqlite",
        db,
        ...(timeFormat !== undefined ? { timeFormat } : {}),
        discovery: discovery.value as { table: string; idColumn: string; cwdColumn: string; timeColumn: string },
        ...(read !== undefined ? { read } : {}),
      },
    };
  }

  const root = nonEmptyString(raw.root);
  if (root === null) {
    return { ok: false, reason: refusal(`${field}.root`, 'the directory the CLI writes to, with `~` for home and `{cwd}`, `{cwd:dashes}` or `{cwd:slug}` for the project path', raw.root === undefined ? RECEIVED_NOTHING : raw.root) };
  }
  if (root.startsWith("/") && !root.startsWith("~/")) {
    return { ok: false, reason: refusal(`${field}.root`, 'an ABSOLUTE path (start it with "/" or "~/")', root) };
  }
  const pattern = nonEmptyString(raw.pattern);
  if (pattern === null) {
    return { ok: false, reason: refusal(`${field}.pattern`, 'a glob RELATIVE to `root` (e.g. "*.jsonl"), one `*` per path segment', raw.pattern === undefined ? RECEIVED_NOTHING : raw.pattern) };
  }
  if (pattern.startsWith("/")) {
    return { ok: false, reason: refusal(`${field}.pattern`, "a glob RELATIVE to `root` — no leading \"/\" (the root is already the anchor)", pattern) };
  }
  const id = parseIdSource(raw.id, `${field}.id`);
  if (!id.ok) return id;
  const cwd = parseCwdSource(raw.cwd, `${field}.cwd`);
  if (!cwd.ok) return cwd;
  const time = parseTimeSource(raw.time, `${field}.time`);
  if (!time.ok) return time;

  let read: Extract<SessionStore, { kind: "files" }>["read"];
  if (raw.read !== undefined && raw.read !== null) {
    if (!isRecord(raw.read)) {
      return { ok: false, reason: refusal(`${field}.read`, "an object with `exists` (a glob with `{id}`) and `content`", raw.read) };
    }
    const exists = nonEmptyString(raw.read.exists);
    if (exists === null) {
      return { ok: false, reason: refusal(`${field}.read.exists`, 'a glob with `{id}` naming the record, relative to `root` (e.g. "{id}.jsonl")', raw.read.exists === undefined ? RECEIVED_NOTHING : raw.read.exists) };
    }
    if (!exists.includes("{id}")) {
      return { ok: false, reason: refusal(`${field}.read.exists`, 'a glob with `{id}` in it — without the id there is nothing to look up (use {"..."} for a literal name)', exists) };
    }
    const content = parseFileContent(raw.read.content, `${field}.read.content`);
    if (!content.ok) return content;
    read = { exists, content: content.value };
  }

  return {
    ok: true,
    value: {
      kind: "files",
      root,
      pattern,
      id: id.value,
      cwd: cwd.value,
      time: time.value,
      ...(read !== undefined ? { read } : {}),
    },
  };
}

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
  // A PRONTIDÃO DECLARADA (task 1777060e). Sem ela, o app só sabe "o binário
  // existe" — e é isso que fazia um provider pela metade (omp, sem credencial)
  // aparecer como disponível. O teto de `timeoutMs` é apertado de propósito:
  // um probe de 10s seria validação de trabalho, que o spec do opencode já
  // recusou por orçamento (~1,7s medidos).
  let readiness: DynamicProviderSpec["readiness"] = null;
  if (value.readiness !== undefined && value.readiness !== null) {
    const raw = value.readiness;
    if (!isRecord(raw)) {
      return { ok: false, reason: refusal("readiness", 'an object like { "kind": "command", "args": ["auth-broker", "status", "--json"], "okPath": "ok", "timeoutMs": 2000 }', raw) };
    }
    if (raw.kind !== "command") {
      return { ok: false, reason: refusal("readiness.kind", 'only "command" today', raw.kind) };
    }
    const args = nonEmptyStringArray(raw.args);
    if (args === null || args.length === 0) {
      return { ok: false, reason: refusal("readiness.args", 'a non-empty array of strings (one item = one argv element, no shell)', raw.args) };
    }
    const okPath = nonEmptyString(raw.okPath);
    if (okPath === null) {
      return { ok: false, reason: refusal("readiness.okPath", 'the name of the boolean field of the JSON that means "ready" (e.g. "ok")', raw.okPath) };
    }
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0 || raw.timeoutMs > 10_000) {
      return { ok: false, reason: refusal("readiness.timeoutMs", "a positive number of milliseconds, at most 10000 (a probe is a read, not a validation)", raw.timeoutMs) };
    }
    const hint = raw.hint === undefined || raw.hint === null ? null : nonEmptyString(raw.hint);
    if (raw.hint !== undefined && raw.hint !== null && hint === null) {
      return { ok: false, reason: refusal("readiness.hint", "a non-empty string (the command a human runs) or null", raw.hint) };
    }
    readiness = { kind: "command", args, okPath, timeoutMs: raw.timeoutMs, hint };
  }

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
  // ONDE a CLI guarda sessão (task 2ea0269f) — validado como o resto deste
  // arquivo: um store malformado recusa o spec INTEIRO com o motivo, em vez
  // de ser aceito e virar uma varredura silenciosamente errada mais tarde.
  let sessionStore: SessionStore | undefined;
  if (sessionRaw.store !== undefined && sessionRaw.store !== null) {
    const parsedStore = parseSessionStore(sessionRaw.store);
    if (!parsedStore.ok) return { ok: false, reason: parsedStore.reason };
    sessionStore = parsedStore.value;
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

  // O FIM DE TURNO (task 0dd5c145) — OPCIONAL, e AUSENTE é o default honesto
  // ("não sinaliza"). A fonte da regex é COMPILADA aqui, na porta: uma
  // declaração inválida é recusada com motivo, em vez de virar um
  // `new RegExp` que explode dentro do registro vivo, no meio de um boot.
  if (deliveryRaw.turnEnd !== undefined) {
    const rawTurnEnd = deliveryRaw.turnEnd;
    if (!isRecord(rawTurnEnd)) {
      return {
        ok: false,
        reason: refusal("capacity.delivery.turnEnd", 'an object with `mechanism` ("hook" or "screen")', rawTurnEnd),
      };
    }
    if (rawTurnEnd.mechanism === "hook") {
      delivery.turnEnd = { mechanism: "hook" };
    } else if (rawTurnEnd.mechanism === "screen") {
      const pattern = nonEmptyString(rawTurnEnd.pattern);
      if (!pattern) {
        return {
          ok: false,
          reason: refusal(
            "capacity.delivery.turnEnd.pattern",
            'a non-empty regex SOURCE string (ex.: "Worked for \\\\d+s"); required when mechanism is "screen"',
            rawTurnEnd.pattern,
          ),
        };
      }
      try {
        new RegExp(pattern);
      } catch (err) {
        return {
          ok: false,
          reason: refusal(
            "capacity.delivery.turnEnd.pattern",
            "a source that compiles as a regular expression",
            `${pattern} (${err instanceof Error ? err.message : String(err)})`,
          ),
        };
      }
      delivery.turnEnd = { mechanism: "screen", pattern };
    } else {
      return {
        ok: false,
        reason: refusal(
          "capacity.delivery.turnEnd.mechanism",
          `one of ${acceptedList(DELIVERY_TURN_END_MECHANISMS)}`,
          rawTurnEnd.mechanism,
        ),
      };
    }
  }

  return {
    ok: true,
    spec: {
      id,
      label,
      binaryNames,
      installCommand,
      ...(readiness !== null ? { readiness } : {}),
      ...(baseArgs !== undefined ? { baseArgs } : {}),
      ...(bypassesPermissionPrompts !== undefined ? { bypassesPermissionPrompts } : {}),
      capacity: {
        role,
        session: {
          canImposeSessionId: sessionRaw.canImposeSessionId,
          ...sessionFlags,
          ...(sessionStore !== undefined ? { store: sessionStore } : {}),
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
          // A DECLARAÇÃO QUE FAZ O RODAPÉ DO CARD TER DE ONDE VIR (task
          // 2ea0269f). A descrição é escrita para quem lê NO EDITOR: os dois
          // CLIs embutidos aparecem em `examples` com o store deles, e é de
          // lá que sai a receita de quem quiser declarar o seu.
          store: {
            type: "object",
            description:
              "ONDE ESTA CLI GUARDA AS SESSÕES. Sem este campo o provider NÃO é observável: o rodapé do card nasce vazio, " +
              "honestamente — sem âncora medida de cwd e de tempo, varrer o disco às cegas acharia o arquivo de outro card. " +
              "Os dois CLIs embutidos trazem o store deles em `examples` (copie o mais parecido com o seu e ajuste). " +
              "`kind:\"files\"` = um registro por arquivo/diretório; `kind:\"sqlite\"` = o índice é um banco da própria CLI.",
            required: ["kind"],
            properties: {
              kind: asEnum(SESSION_STORE_KINDS, '"files" (registro por arquivo/diretório sob uma raiz) or "sqlite" (índice em banco)'),
              root: asNonEmptyStr(
                'kind="files": a pasta dos registros. `~` = home; `{cwd}`, `{cwd:dashes}` ou `{cwd:slug}` = o caminho do projeto no encoding que a CLI usa no nome da pasta.',
              ),
              pattern: asNonEmptyStr('kind="files": glob RELATIVO a `root` que casa o registro (ex.: "*.jsonl"); um `*` é UM segmento de caminho.'),
              id: {
                type: "object",
                description: 'kind="files": de onde sai o id da sessão — "fileName" (+strip) do nome do arquivo, "dirName" do diretório que o contém, "jsonLine" (+path) do JSON da 1ª linha.',
                required: ["from"],
                properties: {
                  from: asEnum(SESSION_ID_SOURCES, "where the session id comes from"),
                  strip: asNonEmptyStr('Sufixo a remover do nome (ex.: ".jsonl"); obrigatório com from="fileName".'),
                  path: { type: "array", items: { type: "string" }, description: 'Caminho JSON até o id (ex.: ["payload", "session_id"]); obrigatório com from="jsonLine".' },
                },
              },
              cwd: {
                description:
                  'kind="files": como o registro prova que é DESTE projeto. "root" = a própria pasta já é o cwd (nada a checar); ' +
                  '{"from":"json"|"jsonLine","path":[...]} = lá dentro. É o que amarra a sessão ao card certo.',
                anyOf: [
                  asEnum(["root"], '"root"'),
                  {
                    type: "object",
                    required: ["from", "path"],
                    properties: {
                      from: asEnum(["json", "jsonLine"] as const, 'one of "json" or "jsonLine"'),
                      path: { type: "array", items: { type: "string" } },
                    },
                  },
                ],
              },
              time: {
                description: 'kind="files": o carimbo usado como "criada depois de" — "mtime" do arquivo, ou {"from":"json","path":[...]}.',
                anyOf: [
                  asEnum(["mtime"], '"mtime"'),
                  {
                    type: "object",
                    required: ["from", "path"],
                    properties: { from: asEnum(["json"] as const, '"json"'), path: { type: "array", items: { type: "string" } } },
                  },
                ],
              },
              db: asNonEmptyStr('kind="sqlite": o caminho do banco (ex.: "~/.cline/data/db/sessions.db"). Lido só em modo leitura.'),
              timeFormat: asEnum(SQLITE_TIME_FORMATS as readonly string[], '"epoch-ms" (padrão; milissegundos) or "iso-8601" (texto de data)'),
              discovery: {
                type: "object",
                description: 'kind="sqlite": a consulta que lista sessões novas de um projeto.',
                required: ["table", "idColumn", "cwdColumn", "timeColumn"],
                properties: {
                  table: asNonEmptyStr("Nome da tabela."),
                  idColumn: asNonEmptyStr("Coluna com o id da sessão."),
                  cwdColumn: asNonEmptyStr("Coluna com o diretório do projeto."),
                  timeColumn: asNonEmptyStr("Coluna com o carimbo de criação (na forma de `timeFormat`)."),
                },
              },
              read: {
                description:
                  "Opcional: valida um id RETOMADO. Ausente = este lado nunca foi medido, e a resposta segue a declaração do provider " +
                  "(não bloqueia) — descoberta e leitura são canais diferentes e podem ter respostas diferentes.",
              },
            },
          },
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
        // O FIM DE TURNO, por TELA (task 0dd5c145) — o MESMO helper de
        // mecanismo, então o `if/then` do schema exige `pattern` só quando o
        // mecanismo declarado é `screen` (e nenhum quando é `hook`).
        extra: {
          turnEnd: mechanismObject({
            description:
              "Como esta CLI sinaliza o FIM de um turno. AUSENTE (o default) = não sinaliza, e a UI não " +
              "promete nada: a barra de atividade cai no silêncio e nenhum aviso é disparado por aproximação.",
            mechanisms: DELIVERY_TURN_END_MECHANISMS,
            flagValue: "screen",
            flagField: "pattern",
            flagDescription:
              "FONTE de regex em TEXTO (o arquivo é JSON e não carrega `RegExp`) que casa o marcador de " +
              'fim de turno na tela — ex.: "Worked for \\\\d+s".',
          }),
        },
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
          "SUA lista (a chave do usuário — o Stellar NUNCA escreve nela). Nasce vazia, e é aqui que você ajusta " +
          "o que quiser: um provider novo por completo, ou só os campos que quer MUDAR de um provider que já vem " +
          "pronto — para isso basta `{ \"id\": \"commandcode\", \"baseArgs\": [\"--yolo\", \"--meu-flag\"] }`, " +
          "três linhas, e todo o resto continua vindo de `appProviders` (e continua recebendo correção do " +
          "Stellar). COMO A SOBRESCRITA FUNCIONA, campo a campo: escalares seus vencem; arrays (como `baseArgs`) " +
          "SUBSTITUEM a lista do app, não concatenam; objetos (`capacity`, `session`, `mcp`…) são mesclados " +
          "campo a campo, então você só precisa escrever o que muda. Um id que o app não declara é um provider " +
          "SEU por inteiro — e aí a declaração tem de ser completa. Um id igual ao de um provider NATIVO (claude, " +
          "codex, cursor, antigravity, opencode, bash) é recusado: o nativo sempre ganha.",
        items: {
          type: "object",
          description:
            "Um provider seu — completo, ou só o pedaço que você quer mudar de um provider do app (ver a " +
            "descrição de `providers` e a chave `appProviders`). Nas duas formas o `id` é obrigatório e é ele que " +
            "liga a entrada à declaração do app.",
          required: ["id"],
          // A RECEITA (task 49796d45, agora GERADA de `appProviders`): com a
          // sobrescrita parcial, só o `id` é obrigatório aqui — e é este
          // `examples` que continua mostrando a FORMA COMPLETA de uma
          // declaração, para quem for escrever um provider novo do zero. Como é
          // gerado das mesmas specs que o app publica, não pode divergir.
          examples: measuredProviderRecipes(),
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z0-9][a-z0-9-]*$",
              description: 'Id estável, usado em spawn_agent, no card e no banco (ex.: "commandcode"). Minúsculas, dígitos e `-`.',
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
            readiness: {
              type: ["object", "null"],
              required: ["kind", "args", "okPath", "timeoutMs"],
              properties: {
                kind: asEnum(["command"], "Como este provider diz que está PRONTO (e não só instalado)."),
                args: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                  description:
                    'Args do PRÓPRIO binário deste provider (um item = um elemento de argv, sem shell) que respondem ' +
                    'o estado sem chamar modelo. Ex. medido no omp 18.2.8: ["auth-broker", "status", "--json"].',
                },
                okPath: asNonEmptyStr(
                  'Nome do campo BOOLEANO do JSON que o comando imprime e que significa "pronto" (ex.: "ok"). O ' +
                    'veredito vem do CAMPO, nunca do exit code: medido, o omp responde `{"ok":false,"reason":"not_configured"}` ' +
                    'com exit 0.',
                ),
                timeoutMs: {
                  type: "number",
                  exclusiveMinimum: 0,
                  maximum: 10000,
                  description:
                    "Teto da sonda em ms. CURTO de propósito (máx. 10000): é LEITURA de estado, não validação de " +
                    'trabalho — o spec do opencode já recusou validação por orçamento (~1,7s medidos).',
                },
                hint: {
                  type: ["string", "null"],
                  description:
                    'Comando que o HUMANO roda para sair do estado (ex.: "omp auth-broker login"). É DADO: declare o ' +
                    "que você mediu — a UI não inventa texto de comando por provider. null = a tela não promete caminho.",
                },
              },
              description:
                'COMO SABER QUE ESTE PROVIDER ESTÁ *PRONTO*, e não só instalado (task 1777060e). Sem esta chave, a ' +
                'disponibilidade responde `unknown` — instalado e NÃO verificado — em vez de afirmar. Medido: o `omp` ' +
                "resolve no PATH, responde `--version`, e PENDURA quando chamado porque não tem credencial; com 'installed' " +
                "sozinho a tela oferecia o provider e o card ficava calado para sempre.",
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
      appProviders: {
        type: "array",
        description:
          "DO APP — não é sua. A lista (completa) dos providers de terceiros que o Stellar já entrega prontos, " +
          "reescrita INTEIRA a cada boot. É o MESMO conceito que o badge \"do app\" mostra na aba Provedores, " +
          "escrito em JSON: cline e commandcode funcionam sem você escrever nada, e o que está aqui é exatamente " +
          "o que o app usa. NÃO EDITE esta chave: uma mudança aqui é apagada no próximo boot (e o app AVISA no " +
          "relatório quando percebe que ela não era a que ele escreve). Para mudar alguma coisa num destes " +
          "providers, escreva a mudança em `providers` (a sua chave), que é a que sempre vence.",
        items: { type: "object" },
      },
      _example: {
        type: "object",
        description:
          "Chave legada: era o exemplo fictício que o arquivo ganhava ao nascer. Não é mais escrita (as " +
          "declarações reais vêm em `appProviders`), e o app NUNCA a remove de um arquivo que já a tenha — use-a " +
          "como suas notas; o loader a ignora por não estar em `providers`.",
      },
    },
  };
}

/** O schema serializado como vai para o disco. */
export function providersConfigSchemaJson(): string {
  return `${JSON.stringify(providersConfigSchema(), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// DUAS CHAVES, DONO EXPLÍCITO — E SOBRESCRITA PARCIAL POR ID (2026-09-20, task
// 3fe0db6e, desenho aprovado pelo dono do repo).
//
// O problema, dito por ele: "cadê a unicidade? O cline e o commandcode não estão
// no JSON". A instrução de um provider genérico tem de estar num lugar só e
// visível: o arquivo dele. O que NÃO pode voltar é o que a medição anterior já
// tinha provado: apagar o arquivo não pode fazer os dois sumirem, e correção do
// app não pode deixar de chegar.
//
// O DESENHO: duas listas, com dono declarado —
//
//   "providers":    []          <- do USUÁRIO. Nasce vazio. O app NUNCA escreve.
//   "appProviders": [ ... ]     <- do APP. Completa, reescrita INTEIRA a cada
//                                  boot, a partir do catálogo deste build.
//
// E a personalização é POR CAMPO, não por entrada: para mudar uma flag do
// commandcode, o usuário (ou um agente) escreve em `providers`:
//
//   { "id": "commandcode", "baseArgs": ["--yolo", "--meu-flag"] }
//
// O resto da declaração continua vindo de `appProviders` — e continua recebendo
// correção do app. Nada é copiado inteiro, então nada congela sem querer.
//
// POR QUE ISTO APOSENTA A IMPRESSÃO DIGITAL: com as duas origens em listas
// separadas, "quem escreveu isto?" tem resposta NA CHAVE. Some junto a pior
// falha do desenho anterior (o app registrar a impressão sem a marca, se
// auto-classificar como editado e congelar os dois providers em silêncio) e some
// o merge de três vias: `appProviders` é reescrita inteira, sem comparação.
//
// A REGRA DE MERGE, e ela foi MEDIDA antes de escolhida (8 edições naturais
// contra os campos que existem hoje, em dois esquemas):
//   - RASO (substituir cada filho direto de `capacity`) RECUSA 5 das 8 — trocar
//     o mcp, o esforço, a sessão ou o papel exigiria repetir o resto do
//     `capacity` inteiro, e esquecer um campo torna a entrada inválida;
//   - PROFUNDO recusa 0 das 8. Objetos descem recursivamente; arrays e
//     escalares SUBSTITUEM.
// Por isso: PROFUNDO. Custo medido do profundo: trocar `mcp` para
// `{mechanism: "none"}` deixa as chaves do ramo antigo (`configPath`, …) no
// arquivo. Elas são INERTES — o parser lê só os campos do ramo escolhido, e o
// def efetivo sai `{mechanism: "none"}` — então a sobra informa, não decide.
//
// O QUE O APP NUNCA FAZ: escrever em `providers`. Nem para limpar, nem para
// migrar, nem para "consertar". É a chave do usuário; uma migração que a
// tocasse seria o app decidindo pelo dono da máquina.
// ---------------------------------------------------------------------------

/** A chave do APP: completa, reescrita inteira a cada boot, e o usuário não
 * precisa escrever nada nela. Ver a regra de merge no bloco acima. */
export const PROVIDERS_APP_KEY = "appProviders";

/**
 * Mescla uma entrada do USUÁRIO sobre a declaração do APP — a sobrescrita
 * parcial por id. Pura, e é a regra que sustenta R2/R3 ao mesmo tempo: o que o
 * usuário escreveu vence no campo que ele escreveu; todo o resto continua sendo
 * o do app (e, portanto, continua recebendo correção nas versões novas).
 *
 *   escalares (`label`, `role`, `acbridgeOnPath`, `installCommand: null`) => o do usuário
 *   arrays (`baseArgs`, `binaryNames`)                                   => SUBSTITUEM (não concatenam)
 *   objetos (`capacity`, `session`, `mcp`, …)                            => descem recursivamente
 */
export function mergeProviderOverride(
  base: DynamicProviderSpec,
  override: Record<string, unknown>,
): DynamicProviderSpec {
  return deepMerge(base as unknown as Record<string, unknown>, override) as unknown as DynamicProviderSpec;
}

/** Objetos descem; TUDO o mais (array, string, number, boolean, `null`)
 * substitui. `null` é valor, não ausência: `installCommand: null` é uma
 * declaração ("não sugira instalação") e não pode virar merge. */
function deepMerge(baseValue: unknown, overrideValue: unknown): unknown {
  if (!isRecord(baseValue) || !isRecord(overrideValue)) return structuredClone(overrideValue);
  const out: Record<string, unknown> = { ...baseValue };
  for (const [key, value] of Object.entries(overrideValue)) {
    out[key] = key in baseValue ? deepMerge(baseValue[key], value) : structuredClone(value);
  }
  return out;
}

export type ProvidersSeedPlan = {
  /** O conteúdo que deve ir para o disco. */
  next: Record<string, unknown>;
  /** Chaves de instrução que faltavam, na ordem. */
  addedKeys: string[];
  /** `appProviders` do arquivo existia e NÃO era o que este build escreve (uma
   * versão antiga do app, ou uma edição à mão na chave do app). É reportado —
   * reescrever sem dizer apagaria uma edição de alguém em silêncio. */
  appProvidersDiverged: boolean;
};

/**
 * A DECISÃO desta task, pura: dado o arquivo como ele está e o catálogo deste
 * build, o que deve ir para o disco? Sem fs, sem relógio, sem merge de listas.
 *
 * `providers` é do usuário e passa INTACTA (é a chave que o app nunca escreve —
 * nem para "consertar"); `appProviders` é reescrita por inteiro a partir do
 * catálogo; e as chaves de instrução entram só quando faltam. Nada do usuário é
 * removido: chaves desconhecidas, entradas próprias e o `_example` legado ficam.
 */
export function planProvidersConfig(
  raw: Record<string, unknown>,
  shipped: readonly DynamicProviderSpec[] = shippedProviderSpecs(),
): ProvidersSeedPlan {
  const appProviders = shipped.map((spec) => structuredClone(spec) as unknown as Record<string, unknown>);
  const previousApp = Array.isArray(raw[PROVIDERS_APP_KEY]) ? raw[PROVIDERS_APP_KEY] : null;
  const appProvidersDiverged =
    previousApp !== null && JSON.stringify(previousApp) !== JSON.stringify(appProviders);

  const addedKeys: string[] = [];
  const next: Record<string, unknown> = {};
  // `$schema` abre o arquivo (é o primeiro campo que o editor lê); depois as
  // chaves do usuário, na ordem dele; `providers` e `appProviders` fecham.
  if (!("$schema" in raw)) addedKeys.push("$schema");
  next.$schema = "$schema" in raw ? raw.$schema : PROVIDERS_SCHEMA_REF;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "$schema" || key === "providers" || key === PROVIDERS_APP_KEY) continue;
    next[key] = value;
  }
  if (!("schemaVersion" in raw)) {
    addedKeys.push("schemaVersion");
    next.schemaVersion = PROVIDERS_CONFIG_SCHEMA_VERSION;
  }
  // `providers` do usuário: intocada. Ausente vira lista vazia (é o nascimento).
  next.providers = Array.isArray(raw.providers) ? raw.providers : [];
  next[PROVIDERS_APP_KEY] = appProviders;

  return { next, addedKeys, appProvidersDiverged };
}

/**
 * O conteúdo do arquivo quando ele NASCE (primeiro boot). Em vez do
 * `{ "providers": [] }` mudo — que não instrui nada — sai com `$schema` (para o
 * editor autocompletar), a chave do usuário VAZIA e a lista do app completa e
 * visível: é ela que responde "o que este app entrega pronto", no arquivo que o
 * dono abre.
 *
 * O que NÃO vai mais aqui: o `_example` fictício (`"minha-cli"`), que gastava
 * 702 dos 878 bytes do arquivo para ser um TERCEIRO exemplar ao lado de dois
 * REAIS e completos. Quem já tem `_example` no arquivo fica com ele: a migração
 * nunca tira chave de ninguém.
 */
export function initialProvidersConfig(shipped: readonly DynamicProviderSpec[] = shippedProviderSpecs()): Record<string, unknown> {
  return planProvidersConfig({ schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION }, shipped).next;
}

export function initialProvidersConfigJson(shipped: readonly DynamicProviderSpec[] = shippedProviderSpecs()): string {
  return renderProvidersConfig(initialProvidersConfig(shipped));
}

/** A serialização do arquivo — UMA função, para que "o que eu escreveria" seja
 * comparável byte a byte com "o que está no disco" (é assim que a escrita vira
 * idempotente: segunda passada igual ⇒ não escreve ⇒ mtime estável). */
function renderProvidersConfig(content: Record<string, unknown>): string {
  return `${JSON.stringify(content, null, 2)}\n`;
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
 * As chaves de INSTRUÇÃO do arquivo, na ordem em que entram quando faltam.
 * `$schema` é o que faz o editor autocompletar e validar; `schemaVersion` é o
 * que o próprio loader exige (um arquivo sem ela é recusado NO TOPO — e, agora
 * que o app escreve as declarações, deixá-la faltando seria escrever num
 * arquivo que o loader descarta inteiro).
 */
export const PROVIDERS_INSTRUCTION_KEYS = ["$schema", "schemaVersion"] as const;


export type EnsureProvidersConfigResult = {
  path: string;
  /**
   * `created` = não existia e nasceu com a chave do app preenchida; `applied` =
   * o arquivo existia e foi escrito (ganhou `appProviders` e/ou as chaves de
   * instrução); `unchanged` = nada a escrever; `raced` = o arquivo mudou entre a
   * leitura e a gravação e o app NÃO sobrescreveu; `invalid`/`unreadable` = não
   * foi tocado (motivo em `error`); `unsupported` = formato que este build não
   * entende, intocado; `unwritable` = a gravação falhou.
   */
  action: "created" | "applied" | "unchanged" | "raced" | "invalid" | "unsupported" | "unreadable" | "unwritable";
  /** Chaves de instrução acrescentadas nesta chamada. */
  addedKeys: string[];
  /** O `appProviders` que estava no arquivo não era o que este build escreve
   * (versão antiga do app, ou edição à mão na chave do app) e foi reescrito. */
  appProvidersRewritten: boolean;
  /** Impedimento de leitura/escrita, ou JSON inválido. `null` no caminho bom. */
  error: string | null;
};

/**
 * Gravação ATÔMICA (tmp + rename) COM COMPARE-AND-SWAP: relê o arquivo
 * imediatamente antes do rename e, se ele não for mais o que foi lido no começo
 * da passada, NÃO sobrescreve (`raced`) — quem editou durante o boot do app
 * perde o trabalho dele de outro jeito.
 *
 * A medida que justifica o CAS (task 3fe0db6e, item ii): sem ele a janela de
 * perda é a passada INTEIRA (ler o arquivo, decidir e gravar — medido em ms,
 * porque a decisão percorre as declarações todas), e com ele a janela encolhe
 * para o intervalo entre a releitura e o `rename` (microssegundos). O rename é
 * atômico, então o pior caso do CAS é perder uma escrita que caia exatamente
 * nesse intervalo — e aí o watcher, que nasce DEPOIS deste passo, relê e
 * reporta a mudança.
 */
function writeProvidersSeed(
  path: string,
  expectedText: string | null,
  plan: ProvidersSeedPlan,
  action: "created" | "applied",
  beforeWrite?: () => void,
): EnsureProvidersConfigResult {
  try {
    beforeWrite?.();
    if (expectedText === null) {
      if (existsSync(path)) return racedResult(path);
    } else if (readFileSync(path, "utf8") !== expectedText) {
      return racedResult(path);
    }
  } catch {
    return racedResult(path);
  }
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, renderProvidersConfig(plan.next), "utf8");
    renameSync(tmp, path);
    return {
      path,
      action,
      addedKeys: plan.addedKeys,
      appProvidersRewritten: plan.appProvidersDiverged,
      error: null,
    };
  } catch (err) {
    return {
      path,
      action: "unwritable",
      addedKeys: [],
      appProvidersRewritten: false,
      error: `could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function racedResult(path: string): EnsureProvidersConfigResult {
  return { path, action: "raced", addedKeys: [], appProvidersRewritten: false, error: null };
}

function emptyResult(
  path: string,
  action: "unchanged" | "invalid" | "unsupported" | "unreadable" | "unwritable",
  error: string | null,
  appProvidersRewritten = false,
): EnsureProvidersConfigResult {
  return { path, action, addedKeys: [], appProvidersRewritten, error };
}

/**
 * Garante que o `providers.json` EXISTA, SE EXPLIQUE **e mostre o que o app
 * entrega pronto** — sem nunca escrever na chave do usuário. Nunca lança:
 * arquivo de config não pode derrubar o boot, e o resultado conta o que
 * aconteceu para quem chamou poder mostrar.
 *
 * Quatro casos, quatro posturas:
 *
 *   1. AUSENTE (`ENOENT`) — NASCIMENTO: sai com `$schema`, `schemaVersion`,
 *      `providers: []` (a chave do usuário, vazia) e `appProviders` com as
 *      declarações deste build. Apagar o arquivo não é um estado a preservar: no
 *      boot seguinte ele nasce de novo, e os dois providers de fábrica voltam
 *      (o catálogo também vive no binário — é o que garante isso).
 *   2. EXISTENTE e igual ao que o app escreveria — NADA é escrito
 *      (`unchanged`), em vez de um save silencioso a cada boot.
 *   3. EXISTENTE e POBRE (o caso medido do dono: 44 bytes) — ganha as chaves que
 *      faltam e o `appProviders`.
 *   4. `appProviders` DIFERENTE do que este build escreve (app antigo, ou alguém
 *      editou a chave do app) — REESCREVE e REPORTA. Reescrever em silêncio
 *      apagaria a edição de alguém sem dizer.
 *
 * E o que NÃO acontece, que é a parte que importa para quem edita à mão:
 * `providers` (a chave do usuário) NUNCA é escrita por aqui — nem para limpar,
 * nem para migrar, nem para "consertar". E ARQUIVO COM JSON QUEBRADO (ou
 * ilegível, ou de um formato que este build não entende) não é tocado: o
 * conteúdo é do usuário, o app REPORT e o registro vivo já fica como estava (o
 * contrato de não-podar de `loadDynamicProviders`).
 */
export function ensureProvidersConfigFile(
  userDataDir: string,
  opts: {
    shipped?: readonly DynamicProviderSpec[];
    /** Só para teste: chamado IMEDIATAMENTE antes do compare-and-swap, para o
     * teste dirigir o instante exato da corrida ("o usuário salvou agora").
     * Mesmo tipo de gancho do `watchDir`/`now` do watcher: um FATO DE TEMPO que
     * nenhum teste consegue produzir de fora. */
    beforeWrite?: () => void;
  } = {},
): EnsureProvidersConfigResult {
  const path = providersConfigPath(userDataDir);
  const shipped = opts.shipped ?? shippedProviderSpecs();

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return emptyResult(path, "unreadable", `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const born = planProvidersConfig({ schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION }, shipped);
    return writeProvidersSeed(path, null, born, "created", opts.beforeWrite);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return emptyResult(path, "invalid", `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) return emptyResult(path, "invalid", `${path} is not a JSON object`);
  // Formato que este build NÃO entende: não se escreve nele. O arquivo pode ser
  // de uma versão futura, e completá-lo com o NOSSO `schemaVersion` seria
  // reinterpretar um formato por sorte — a mesma postura do loader, que recusa
  // o arquivo inteiro nesse caso.
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== PROVIDERS_CONFIG_SCHEMA_VERSION) {
    return emptyResult(
      path,
      "unsupported",
      `${path} declares schemaVersion ${JSON.stringify(raw.schemaVersion)}; this build understands only ${PROVIDERS_CONFIG_SCHEMA_VERSION} — file left untouched`,
    );
  }

  const plan = planProvidersConfig(raw, shipped);
  if (renderProvidersConfig(plan.next) === text) return emptyResult(path, "unchanged", null);
  return writeProvidersSeed(path, text, plan, "applied", opts.beforeWrite);
}

/**
 * O relato do passo de boot em UMA linha — pt-BR porque quem lê é o dono da
 * máquina (mesma postura dos avisos de migração em `index.ts`). Pura e
 * exportada pro teste, como `formatProvidersReloadLine`.
 *
 * O CASO QUE ESTA FUNÇÃO EXISTE PARA NÃO DEIXAR PASSAR: o `appProviders` do
 * arquivo não era o que este build escreve e foi reescrito. Pode ser só um app
 * mais antigo (silencioso seria aceitável), mas também pode ser alguém que
 * editou a chave do app à mão — e aí reescrever sem dizer seria apagar trabalho
 * de alguém em silêncio. A linha é neutra de propósito: ela conta o FATO, não
 * acusa quem o causou. `null` = nada a dizer (o caso de todo boot sem mudança).
 */
export function formatProvidersSeedNotice(result: EnsureProvidersConfigResult): string | null {
  const parts: string[] = [];
  if (result.action === "created") parts.push("criado com a lista do app em `appProviders` (a sua chave, `providers`, nasce vazia)");
  if (result.action === "applied") {
    const chaves = result.addedKeys.length > 0 ? ` (completei ${result.addedKeys.join(", ")})` : "";
    parts.push(`atualizei a lista do app em \`appProviders\`${chaves}`);
  }
  if (result.appProvidersRewritten && result.action !== "created") {
    parts.push(
      "o `appProviders` que estava no arquivo não era o que este build escreve — reescrevi " +
        "(a chave `providers`, sua, não foi tocada)",
    );
  }
  if (result.action === "raced") {
    parts.push("o arquivo mudou enquanto eu o escrevia — NÃO sobrescrevi (o próximo boot reavalia)");
  }
  return parts.length === 0 ? null : `${parts.join(" · ")}.`;
}

export type ProvidersBootstrapResult = {
  schema: EnsureProvidersSchemaResult;
  config: EnsureProvidersConfigResult;
};

/**
 * O PASSO DE BOOT dos providers: o schema ao lado (conveniência de editor,
 * reescrito quando o app muda) e o arquivo do usuário existente, instruído e
 * com as declarações de fábrica. Os dois são idempotentes, nenhum lança, e
 * nenhum dos dois mexe no registro vivo — quem registra é
 * `loadDynamicProviders`, que o main chama logo depois.
 *
 * Por que UMA função em vez de duas chamadas soltas no `index.ts`: é ESTE
 * símbolo que o gate de fiação procura. A função existe para dar nome à
 * fiação, e o nome existe para um teste poder afirmar "isto é chamado de
 * produção" — que é a pergunta que nenhum gate anterior fazia.
 */
export function bootstrapProvidersConfig(
  userDataDir: string,
  opts: { shipped?: readonly DynamicProviderSpec[] } = {},
): ProvidersBootstrapResult {
  return {
    schema: ensureProvidersSchemaFile(userDataDir),
    config: ensureProvidersConfigFile(userDataDir, opts),
  };
}

/**
 * Valida o ARQUIVO inteiro (`{ schemaVersion, providers: [...] }`).
 * Pura: recebe o JSON já parseado. O que não valida não entra, e cada
 * recusa sai nomeada; um arquivo de versão desconhecida é recusado
 * inteiro, porque interpretar um formato que não conhecemos "no melhor
 * esforço" é como config de usuário quebra em silêncio.
 *
 * `appSpecs` é o catálogo DO APP (o binário) e muda uma coisa só, que é o
 * coração do desenho de duas chaves: uma entrada do usuário com o mesmo id de
 * uma do app é uma SOBRESCRITA PARCIAL — ela é mesclada por cima da declaração
 * do app ANTES de validar, então três linhas
 * (`{ "id": "commandcode", "baseArgs": [] }`) bastam para mudar um campo, e
 * todo o resto continua vindo do app (e continua recebendo correção do app).
 *
 * Sem `appSpecs` (ou com id que o app não tem) o comportamento é o de sempre:
 * a entrada é uma declaração COMPLETA do usuário, e vira provider novo.
 *
 * A tela usa esta mesma função com o mesmo `appSpecs`, de propósito: o que o
 * usuário vê na lista é o resultado da MESMA mescla que o registro vivo usa —
 * se a tela mostrasse a entrada crua, ela mostraria um def que não existe.
 */
export function parseProviderSpecs(
  raw: unknown,
  opts: { appSpecs?: readonly DynamicProviderSpec[] } = {},
): ParseProviderSpecsResult {
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

  const appById = new Map((opts.appSpecs ?? []).map((spec) => [spec.id, spec]));
  const specs: DynamicProviderSpec[] = [];
  const rejected: SpecRejection[] = [];
  const seen = new Set<string>();
  raw.providers.forEach((entry, index) => {
    // A SOBRESCRITA PARCIAL: só quando o id existe no app E a entrada pediu
    // algo. O que o usuário escreveu vence no campo que ele escreveu; o resto
    // vem da declaração do app (ver `mergeProviderOverride` para a regra).
    const base = isRecord(entry) && typeof entry.id === "string" ? appById.get(entry.id) : undefined;
    const candidato: unknown = base === undefined ? entry : mergeProviderOverride(base, entry);
    const parsed = parseProviderSpec(candidato);
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
    // A prontidão viaja como DADO até a checagem de disponibilidade: é ela que
    // decide se `installed: true` vira `ready`, `not-ready` ou `unknown`
    // (provider-readiness-decision.ts). Sem probe, o def carrega `null` e a
    // resposta honesta é `unknown`.
    readiness: spec.readiness ? { ...spec.readiness, args: [...spec.readiness.args] } : null,
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
        // ONDE a CLI guarda sessão (task 2ea0269f). Este mapeamento é campo a
        // campo de propósito, e é por isso que ele é um lugar onde uma
        // declaração nova pode entrar no schema, passar no validador e NÃO
        // chegar ao registro vivo — foi exatamente o que aconteceu aqui, e o
        // teste da gramática (que lê `providerById`, não o spec) pegou.
        ...(declared.session.store ? { store: declared.session.store } : {}),
      },
      // `submitStartedPattern` fica de fora de propósito: é vocabulário de
      // TELA medido, e não foi medido para nenhum dinâmico. Ausente =
      // "não medido", que é a verdade — inventar aqui mudaria o
      // comportamento do `isActive` sem prova.
      delivery: {
        briefMechanism: declared.delivery.briefMechanism,
        ...(declared.delivery.briefFlag ? { briefFlag: declared.delivery.briefFlag } : {}),
        // O FIM DE TURNO (task 0dd5c145) — COMPILADO aqui: o arquivo guarda a
        // FONTE como texto (JSON não carrega `RegExp`) e o registro vivo
        // carrega o `RegExp`. Este `...` é o que faz a declaração CHEGAR ao
        // renderer pela projeção; sem ele, o campo passa no schema, passa no
        // validador e morre aqui em silêncio — a classe exata do bug do
        // `session.store`, e o motivo de o gate de round-trip existir
        // (`tests/unit/providers-dynamic-round-trip.test.ts`, que foi provado
        // VERMELHO removendo exatamente este bloco).
        ...(declared.delivery.turnEnd
          ? {
              turnEnd:
                declared.delivery.turnEnd.mechanism === "hook"
                  ? { mechanism: "hook" as const }
                  : { mechanism: "screen" as const, pattern: new RegExp(declared.delivery.turnEnd.pattern) },
            }
          : {}),
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
  /** TODOS os ids que o APP declara (a lista de `appProviders`) — inclusive os
   * que o usuário sobrescreveu em parte. É o que a tela usa para dizer "do app"
   * (o mesmo vocabulário do badge): a ORIGEM da declaração é esta lista, não um
   * campo dentro da entrada. */
  appIds: ProviderId[];
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
  const shipped = opts.shipped ?? shippedProviderSpecs();

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

  const parsed = raw === null ? { specs: [], rejected: [] } : parseProviderSpecs(raw, { appSpecs: shipped });
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
    appIds: shipped.map((s) => s.id),
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

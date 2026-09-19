import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { t } from "../shared/i18n";
import { providerCapacity, which, type McpServerShape } from "./providers";
import { effectivePath } from "./user-env";

const execFileAsync = promisify(execFile);

/**
 * Registra o servidor MCP do Stellar nas CLIs que NÃO aceitam registro
 * efêmero por invocação (pedido ao vivo 2026-09-01: "é preciso registrar o
 * cursor como provider, e o antigravity(gemini)").
 *
 * QUEM precisa disto não é decidido aqui: é `ProviderCapacity.mcp` em
 * providers.ts (`global-config` → este módulo age; `ephemeral-flag` → o
 * `buildArgs` do provider já passa a flag; `none` → nada). Este arquivo
 * só sabe COMO registrar em cada CLI (`REGISTRARS`), e um teste garante
 * que todo provider declarado `global-config` tem um registrador — a
 * lista literal de ids que existia em `ensureMcpRegistered` saiu
 * (2026-09-13) justamente por ser uma segunda fonte sobre o mesmo fato.
 *
 * O contraste, confirmado lendo o `--help` real dos binários instalados e
 * não por suposição:
 *
 *   claude    `--mcp-config '{...}'`        efêmero, some com o processo
 *   codex     `-c mcp_servers.stellar.url`  idem
 *   cursor    só `.cursor/mcp.json` (projeto) ou `~/.cursor/mcp.json`
 *   agy       só `agy mcp add` (persistente, `~/.gemini/config/`)
 *   opencode  só config persistente (`~/.config/opencode/opencode.json`,
 *             chave `mcp`) — sem flag de registro por invocação
 *
 * Para os três de baixo sobra config persistente, e é por isso que o
 * registro aponta pro shim stdio (`resources/bin/stellar-mcp`) em vez da
 * URL HTTP: a URL carrega uma porta efêmera e um `?card=<id>` por card, e
 * nenhum dos dois cabe num arquivo escrito uma vez. O comando é estável;
 * o shim descobre porta e identidade no ambiente do processo. Ver o
 * cabeçalho de `resources/bin/stellar-mcp`.
 *
 * Só que "o ambiente do processo" não é o mesmo em toda CLI. Medido em
 * `/proc` com cards vivos (2026-09-13): o cursor NÃO herda ambiente ao
 * processo MCP — é whitelist (`SHELL PWD LOGNAME HOME TERM USER SHLVL
 * PATH`), e nenhuma `AGENT_CANVAS_*` atravessa. Foi por isso que nenhum
 * card cursor jamais teve as tools: `mcp list` dizia `ready` e
 * `list-tools` dizia `No tools`, porque o shim respondia offline dentro
 * de um card vivo. O que atravessa a whitelist é o `env` da própria
 * entrada, e o cursor interpola `${env:VAR}` ali a partir do ambiente de
 * CADA processo `agent` — um config global e único, portanto, dá
 * identidade por card. `cursorServerEntry` escreve exatamente isso.
 *
 * Por que env interpolado + shim, e não `"url": "${env:...}?card=..."`
 * sem shim (as duas formas foram medidas funcionando dentro de um card):
 * fora de um card o cursor entrega o literal `${env:VAR}` sem expandir
 * (medido, não vazio). Com URL isso vira `Invalid URL` e uma linha
 * vermelha em toda sessão do usuário fora do Stellar; com o shim vira
 * `respondOffline`, porque ele trata o literal como ausente. De quebra,
 * `AGENT_CANVAS_NODE` — o conserto do PATH mínimo do Finder no macOS —
 * volta a chegar ao shim, o que a mesma whitelist também impedia.
 *
 * Aprovação não entra na conta: o cursor só exige aprovação (hash da
 * config JÁ RESOLVIDA, por cwd, em `~/.cursor/projects/<slug>/
 * mcp-approvals.json`) para o `.cursor/mcp.json` de PROJETO; para o
 * global ele nem instala o middleware (lido no bundle da CLI 2026.09.10
 * e confirmado: um HOME temporário com a entrada interpolada expõe 46
 * tools sem `mcp enable` nenhum). Medir com config de projeto — que é
 * o que todo probe faz — mostra "not approved" a cada card id diferente
 * e subestima o registro global.
 *
 * Três regras que este módulo respeita, porque escrever em config de
 * usuário é exatamente o que o projeto vinha (com razão) evitando:
 *
 *  1. **Nada no repositório do usuário.** Só o config global da CLI, nunca
 *     um `.cursor/mcp.json` dentro do projeto aberto.
 *  2. **Preguiçoso.** Só roda quando um card DAQUELE provider é spawnado.
 *     Quem nunca usa cursor nunca tem `~/.cursor` tocado.
 *  3. **Idempotente de verdade.** Lê o que já está lá e só escreve se
 *     estiver ausente ou apontando pra outro caminho (o que acontece de
 *     forma legítima ao alternar entre a app empacotada e `npm run dev`).
 *
 * Falhar aqui nunca impede o spawn: sem MCP o card ainda funciona pelo
 * `acbridge`, que é o que ele já tinha antes disto existir.
 *
 * CAMINHO DECLARATIVO (2026-09-19) — os três `REGISTRARS` acima são o
 * formato ESCRITO À MÃO de cada nativo, porque cada um tem uma CLI com
 * idiossincrasias medidas (a whitelist de ambiente do cursor, o arquivo por
 * workspace do agy, a chave `mcp` do opencode). Um provider DINÂMICO não tem
 * — e não pode ter — código por CLI: a declaração de capacidade dele
 * (`providers.ts` → `capacity.mcp`) já diz tudo o que é preciso saber para
 * escrever o registro (onde, sob qual chave, com que forma de entrada), e
 * `registerDeclaredProvider` abaixo é o único registrador que lê isso.
 * As mesmas três regras valem para ele, sem exceção.
 */

/** Nome sob o qual o servidor aparece nas duas CLIs. */
const SERVER_NAME = "stellar";

/** Só pra suíte de verificação, mesma justificativa do
 * `AGENT_CANVAS_MCP_PORT` em index.ts: sem isto um smoke test escreveria no
 * `~/.cursor/mcp.json` e no `~/.gemini/` REAIS do usuário a cada execução.
 * `agy` não tem flag pra apontar o config, mas lê `~`, então o override
 * chega nele como `HOME` no ambiente do subprocesso. Ausente num launch de
 * verdade, onde o home do usuário é justamente o alvo certo. */
function registrationHome(): string {
  return process.env.AGENT_CANVAS_REGISTRATION_HOME || homedir();
}

export type McpRegistrationResult =
  | { status: "ok"; changed: boolean }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/** Uma tentativa por provider por execução da app. Um segundo spawn do
 * mesmo provider não repete nem a leitura do arquivo. */
const attempted = new Map<string, Promise<McpRegistrationResult>>();

export function shimPath(binDir: string): string {
  return join(binDir, "stellar-mcp");
}

/** As variáveis que o shim lê e que a whitelist do cursor derruba — ver o
 * cabeçalho. Não é a lista inteira de `AGENT_CANVAS_*` de propósito: o
 * shim só consome estas três, e cada uma a mais é mais uma que o cursor
 * entrega como literal fora de um card. */
const CURSOR_FORWARDED_ENV = ["AGENT_CANVAS_MCP_URL", "AGENT_CANVAS_CARD_ID", "AGENT_CANVAS_NODE"] as const;

export type CursorServerEntry = {
  command: string;
  env: Record<string, string>;
  [extra: string]: unknown;
};

/** A entrada que o Stellar quer ver em `~/.cursor/mcp.json`. Exportada
 * porque é o CONTRATO: o teste de idempotência compara contra ela, e o
 * shim documenta que é daqui que o ambiente dele vem. */
export function cursorServerEntry(shim: string): CursorServerEntry {
  const env: Record<string, string> = {};
  for (const name of CURSOR_FORWARDED_ENV) env[name] = `\${env:${name}}`;
  return { command: shim, env };
}

/** Igualdade só sobre o que o Stellar escreve (`command` e as chaves de
 * `env` que ele próprio põe). Chaves que o usuário tenha acrescentado à
 * entrada são preservadas e não contam — senão o registro reescreveria a
 * cada spawn, e a regra 3 do cabeçalho existe para isso não acontecer. */
function cursorEntryIsCurrent(existing: unknown, wanted: CursorServerEntry): boolean {
  if (!existing || typeof existing !== "object") return false;
  const entry = existing as Partial<CursorServerEntry>;
  if (entry.command !== wanted.command) return false;
  const env = entry.env;
  if (!env || typeof env !== "object") return false;
  return Object.entries(wanted.env).every(([k, v]) => env[k] === v);
}

export function registerCursor(shim: string): McpRegistrationResult {
  // `~/.cursor/mcp.json` — o caminho global que o próprio `cursor-agent
  // mcp list` nomeia quando não acha nada ("expected in .cursor/mcp.json
  // or ~/.cursor/mcp.json"). O de projeto é deliberadamente ignorado: é o
  // repositório do usuário.
  const file = join(registrationHome(), ".cursor", "mcp.json");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // Inexistente ou corrompido. Um arquivo ilegível é tratado como
    // ausente de propósito: sobrescrever config alheia com base num parse
    // que falhou seria pior do que não registrar.
    config = {};
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const wanted = cursorServerEntry(shim);
  const existing = servers[SERVER_NAME];
  if (cursorEntryIsCurrent(existing, wanted)) return { status: "ok", changed: false };
  // Uma entrada antiga (só `command`, de antes de 2026-09-13) ou apontando
  // pra outro caminho é reescrita por cima, preservando o que não é nosso.
  const base = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const baseEnv = base.env && typeof base.env === "object" ? (base.env as Record<string, string>) : {};
  servers[SERVER_NAME] = { ...base, command: wanted.command, env: { ...baseEnv, ...wanted.env } };
  config.mcpServers = servers;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (err) {
    return { status: "failed", error: t("error.agyWrite", { file, error: String(err) }) };
  }
  return { status: "ok", changed: true };
}

/** Ambiente dos subprocessos de CLI — igual ao do processo, com duas
 * diferenças: o PATH efetivo (`user-env.ts`) em vez do herdado, porque a
 * CLI que roda aqui pode precisar de `node` para o próprio shim que ela
 * chama, e o override de teste, que redireciona o `~` que as CLIs leem. */
function cliEnv(): NodeJS.ProcessEnv {
  const home = process.env.AGENT_CANVAS_REGISTRATION_HOME;
  return { ...process.env, PATH: effectivePath(), ...(home ? { HOME: home } : {}) };
}

async function approveCursor(binary: string): Promise<void> {
  // `mcp enable` põe o servidor na lista de aprovados local. Sem isso a
  // CLI pergunta na primeira vez, o que num terminal de card dirigido por
  // agente vira um prompt que ninguém responde. (Lido no bundle da CLI
  // 2026.09.10: pro `~/.cursor/mcp.json` global o middleware de aprovação
  // nem é instalado, então isto hoje é cinto e suspensório — fica porque
  // é barato, roda só quando o arquivo mudou, e versões da CLI divergem.)
  // Deliberadamente NÃO
  // `--approve-mcps` (a flag existe): aquilo aprovaria todo servidor MCP
  // do usuário de uma vez, um alargamento de permissão que este pedido não
  // justifica. Aqui aprova um nome só.
  await execFileAsync(binary, ["mcp", "enable", SERVER_NAME], { timeout: 15_000, env: cliEnv() }).catch(() => {
    // Versões diferentes da CLI divergem no subcomando; falhar aqui só
    // significa que o humano confirma o servidor uma vez na mão.
  });
}

/** `~/.config/opencode/opencode.json` — o config global do próprio
 * opencode (confirmado no schema real: chave `mcp`, entradas `{type:
 * "local", command: [...], enabled}` pra stdio). Mesmo cuidado de
 * `registerCursor`: parse defensivo, só mexe na chave `mcp`, preserva
 * `provider`/`$schema`/qualquer outra coisa que já esteja no arquivo
 * (este projeto já usa esse config pro provider `qwen-local` — ver ai
 * memory `qwen-buun-local-server`). */
function registerOpencode(shim: string): McpRegistrationResult {
  const file = join(registrationHome(), ".config", "opencode", "opencode.json");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    config = {};
  }
  const servers = (config.mcp ?? {}) as Record<string, { type?: string; command?: string[]; enabled?: boolean }>;
  const existing = servers[SERVER_NAME];
  if (existing?.type === "local" && existing.command?.[0] === shim) return { status: "ok", changed: false };
  servers[SERVER_NAME] = { type: "local", command: [shim], enabled: true };
  config.mcp = servers;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (err) {
    return { status: "failed", error: t("error.agyWrite", { file, error: String(err) }) };
  }
  return { status: "ok", changed: true };
}

async function registerAntigravity(binary: string, shim: string): Promise<McpRegistrationResult> {
  // `agy` não expõe o arquivo de config por flag e não documenta uma
  // variável de ambiente pra redirecioná-lo (procurei nas strings do
  // binário: não existe) — então o registro passa pelo próprio subcomando,
  // que é a interface suportada. `mcp list` primeiro pra manter a
  // idempotência: `mcp add` é "add or update" e reescreveria o arquivo
  // toda vez.
  try {
    const { stdout } = await execFileAsync(binary, ["mcp", "list"], { timeout: 15_000, env: cliEnv() });
    if (stdout.includes(SERVER_NAME) && stdout.includes(shim)) return { status: "ok", changed: false };
  } catch {
    // Sem lista legível, segue pro add — que é idempotente por definição.
  }
  try {
    await execFileAsync(binary, ["mcp", "add", "--type", "stdio", SERVER_NAME, shim], { timeout: 15_000, env: cliEnv() });
  } catch (err) {
    return { status: "failed", error: t("error.agyAddFailed", { error: String(err) }) };
  }
  return { status: "ok", changed: true };
}

/**
 * COMO cada CLI NATIVA de config persistente recebe o registro. Não é uma
 * lista de "quem tem MCP" — isso é `ProviderCapacity.mcp` — é a
 * implementação por CLI, e `tests/unit/mcp-registration.test.ts` garante que
 * as duas não divergem: todo provider nativo `global-config` tem um
 * registrador aqui e nenhum registrador existe pra provider que não seja
 * `global-config`. Um provider DINÂMICO declarado `global-config` é servido
 * por `registerDeclaredProvider` (abaixo), não por uma entrada aqui: este
 * mapa é `(shim) => …`, sem o id do provider, e é exatamente essa assinatura
 * que diz "a forma desta CLI é escrita à mão". O teste continua valendo
 * porque ele lê `PROVIDERS`, que em unit test são só os nativos.
 */
export const REGISTRARS: Record<string, (shim: string) => Promise<McpRegistrationResult>> = {
  cursor: async (shim) => {
    const result = registerCursor(shim);
    const binary = which(["agent", "cursor-agent"]);
    if (result.status === "ok" && result.changed && binary) await approveCursor(binary);
    return result;
  },
  opencode: async (shim) => registerOpencode(shim),
  antigravity: async (shim) => {
    const binary = which(["agy"]);
    if (!binary) return { status: "skipped", reason: t("error.agyBinaryMissing") };
    return registerAntigravity(binary, shim);
  },
};

/** `~/…` resolvido contra `registrationHome()` — que é o `~` do teste, e o
 * home real num launch de verdade. Caminho absoluto passa direto. Relativo é
 * RECUSADO (`null`): não existe diretório de trabalho significativo para um
 * config global de CLI, e resolver um relativo contra o cwd de um card
 * escreveria num lugar que ninguém escolheu. */
function resolveDeclaredConfigPath(declared: string): string | null {
  if (declared === "~") return registrationHome();
  if (declared.startsWith("~/")) return join(registrationHome(), declared.slice(2));
  return isAbsolute(declared) ? declared : null;
}

/** A entrada que o Stellar quer escrever, na forma que a CLI declarou. Duas
 * formas hoje (ver `McpServerShape`): objeto com `command` (a família
 * `mcpServers` — claude/comandos stdio), ou o `{type:"local", command:[…]}`
 * do opencode. Nada de `${env:…}` aqui: a interpolação de ambiente é o
 * contorno MEDIDO da whitelist do cursor, não uma convenção geral — inventá-la
 * para outra CLI seria declarar uma medição que ninguém fez. */
function declaredServerEntry(shape: McpServerShape, shim: string): Record<string, unknown> {
  if (shape === "stdio-command") return { command: shim };
  return { type: "local", command: [shim], enabled: true };
}

/** Igualdade só sobre o que o Stellar escreve. Chaves que o usuário tenha
 * acrescentado à NOSSA entrada são preservadas e não contam — mesma regra do
 * `cursorEntryIsCurrent`, senão o registro reescreveria a cada spawn. */
function declaredEntryIsCurrent(existing: unknown, shape: McpServerShape, shim: string): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const entry = existing as Record<string, unknown>;
  if (shape === "stdio-command") return entry.command === shim;
  return entry.type === "local" && Array.isArray(entry.command) && entry.command[0] === shim;
}

/**
 * Registrador DECLARATIVO — o caminho de um provider cujo formato não está
 * escrito em código nenhum, e sim na própria declaração de capacidade
 * (`configPath` onde, `configKey` sob qual chave, `serverShape` com que
 * forma). Hoje é o caminho dos providers dinâmicos (cline, commandcode — ver
 * `providers-dynamic.ts`); um nativo com idiossincrasia medida continua com o
 * registrador à mão dele em `REGISTRARS`.
 *
 * Mesmo contrato dos outros: nada no repositório do usuário, preguiçoso
 * (quem chama é `ensureMcpRegistered`, no spawn daquele provider) e
 * idempotente de verdade. O arquivo é lido e mesclado, nunca substituído:
 * outros servidores, outras chaves de topo e as chaves que o usuário
 * acrescentou na nossa entrada sobrevivem intactos.
 *
 * Não checa se o binário existe (cursor/opencode também não): quem chega aqui
 * é um card DAQUELE provider sendo spawnado, e falhar aqui nunca impede o
 * spawn — o `acbridge` cobre o report enquanto isso.
 *
 * Exportado para a suíte de verificação poder exercitar o caminho com um
 * `AGENT_CANVAS_REGISTRATION_HOME` temporário, sem tocar em `~` nenhum.
 */
export function registerDeclaredProvider(providerId: string, shim: string): McpRegistrationResult {
  const declared = providerCapacity(providerId)?.mcp;
  if (!declared || declared.mechanism !== "global-config") {
    return { status: "failed", error: `provider "${providerId}" does not declare a persistent MCP config` };
  }
  const { configPath, configKey, serverShape } = declared;
  // Declaração incompleta: falha VISÍVEL, nunca um palpite que escreveria num
  // arquivo do usuário sem saber a forma da entrada dele.
  if (!configPath || !configKey || !serverShape) {
    return {
      status: "failed",
      error:
        `provider "${providerId}" declares global-config without configPath/configKey/serverShape` +
        " — refusing to write to a user's config file with a guessed shape",
    };
  }
  const file = resolveDeclaredConfigPath(configPath);
  if (!file) {
    return {
      status: "failed",
      error: `provider "${providerId}" declares a relative configPath ("${configPath}") — a CLI's global config is never relative to a card's cwd`,
    };
  }

  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    // Inexistente ou corrompido → tratado como ausente, mesma postura de
    // `registerCursor`: sobrescrever config alheia com base num parse que
    // falhou seria pior do que não registrar.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }

  const current = config[configKey];
  const servers: Record<string, unknown> =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};

  const existing = servers[SERVER_NAME];
  if (declaredEntryIsCurrent(existing, serverShape, shim)) return { status: "ok", changed: false };

  // Preserva o que não é nosso: a entrada antiga (válida ou não) é a base, e
  // só as chaves que o Stellar escreve são sobrescritas.
  const base = existing !== null && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {};
  servers[SERVER_NAME] = { ...base, ...declaredServerEntry(serverShape, shim) };
  config[configKey] = servers;

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (err) {
    return { status: "failed", error: t("error.agyWrite", { file, error: String(err) }) };
  }
  return { status: "ok", changed: true };
}

/** Se `ensureMcpRegistered` age para este provider — derivado da
 * declaração de capacidade, nunca de uma lista de ids. */
export function needsPersistentMcpRegistration(providerId: string): boolean {
  return providerCapacity(providerId)?.mcp.mechanism === "global-config";
}

/**
 * Chamado antes de spawnar um card. Só faz alguma coisa pros providers
 * cuja capacidade declara `global-config`; pra qualquer outro é um no-op
 * imediato, inclusive `bash`.
 */
export function ensureMcpRegistered(providerId: string, binDir: string): Promise<McpRegistrationResult> {
  const cached = attempted.get(providerId);
  if (cached) return cached;

  const run = (async (): Promise<McpRegistrationResult> => {
    if (!needsPersistentMcpRegistration(providerId)) {
      return { status: "skipped", reason: t("error.mcpInvoked") };
    }
    const registrar = REGISTRARS[providerId];
    if (registrar) return registrar(shimPath(binDir));
    // Sem registrador escrito à mão, mas a PRÓPRIA declaração já diz onde e
    // como escrever: é o caminho declarativo (providers dinâmicos — cline,
    // commandcode). Falha visível fica reservada a quem não tem nem código
    // nem declaração completa, que é o caso que ela existe para pegar.
    const declared = providerCapacity(providerId)?.mcp;
    if (
      declared &&
      declared.mechanism === "global-config" &&
      declared.configPath &&
      declared.configKey &&
      declared.serverShape
    ) {
      return registerDeclaredProvider(providerId, shimPath(binDir));
    }
    // Declarado `global-config` sem registrador: falha VISÍVEL (vai pro
    // console.error do chamador), nunca um skip silencioso que deixaria
    // o card sem MCP achando que tem.
    return { status: "failed", error: `no MCP registrar for provider "${providerId}" declared global-config` };
  })();

  attempted.set(providerId, run);
  return run;
}

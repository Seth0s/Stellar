import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { t } from "../shared/i18n";
import { providerCapacity, which } from "./providers";
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
 * COMO cada CLI de config persistente recebe o registro. Não é uma lista
 * de "quem tem MCP" — isso é `ProviderCapacity.mcp` — é a implementação
 * por CLI, e `tests/unit/mcp-registration.test.ts` garante que as duas
 * não divergem: todo provider `global-config` tem um registrador aqui e
 * nenhum registrador existe pra provider que não seja `global-config`.
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
    if (!registrar) {
      // Declarado `global-config` sem registrador: falha VISÍVEL (vai pro
      // console.error do chamador), nunca um skip silencioso que deixaria
      // o card sem MCP achando que tem.
      return { status: "failed", error: `no MCP registrar for provider "${providerId}" declared global-config` };
    }
    return registrar(shimPath(binDir));
  })();

  attempted.set(providerId, run);
  return run;
}

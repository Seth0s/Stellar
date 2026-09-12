import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { t } from "../shared/i18n";
import { which } from "./providers";
import { effectivePath } from "./user-env";

const execFileAsync = promisify(execFile);

/**
 * Registra o servidor MCP do Stellar nas CLIs que NÃO aceitam registro
 * efêmero por invocação (pedido ao vivo 2026-09-01: "é preciso registrar o
 * cursor como provider, e o antigravity(gemini)").
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
 * Para os dois de baixo sobra config persistente, e é por isso que o
 * registro aponta pro shim stdio (`resources/bin/stellar-mcp`) em vez da
 * URL HTTP: a URL carrega uma porta efêmera e um `?card=<id>` por card, e
 * nenhum dos dois cabe num arquivo escrito uma vez. O comando é estável;
 * o shim descobre porta e identidade no ambiente que o processo do card
 * já tem. Ver o cabeçalho de `resources/bin/stellar-mcp`.
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

function registerCursor(shim: string): McpRegistrationResult {
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
  const servers = (config.mcpServers ?? {}) as Record<string, { command?: string }>;
  if (servers[SERVER_NAME]?.command === shim) return { status: "ok", changed: false };
  servers[SERVER_NAME] = { command: shim };
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
  // agente vira um prompt que ninguém responde. Deliberadamente NÃO
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
 * Chamado antes de spawnar um card. Só faz alguma coisa pros dois
 * providers sem registro efêmero; pra qualquer outro é um no-op imediato,
 * inclusive `bash`.
 */
export function ensureMcpRegistered(providerId: string, binDir: string): Promise<McpRegistrationResult> {
  const cached = attempted.get(providerId);
  if (cached) return cached;

  const run = (async (): Promise<McpRegistrationResult> => {
    if (providerId !== "cursor" && providerId !== "antigravity" && providerId !== "opencode") {
      return { status: "skipped", reason: t("error.mcpInvoked") };
    }
    const shim = shimPath(binDir);
    if (providerId === "cursor") {
      const result = registerCursor(shim);
      const binary = which(["agent", "cursor-agent"]);
      if (result.status === "ok" && result.changed && binary) await approveCursor(binary);
      return result;
    }
    if (providerId === "opencode") return registerOpencode(shim);
    const binary = which(["agy"]);
    if (!binary) return { status: "skipped", reason: t("error.agyBinaryMissing") };
    return registerAntigravity(binary, shim);
  })();

  attempted.set(providerId, run);
  return run;
}

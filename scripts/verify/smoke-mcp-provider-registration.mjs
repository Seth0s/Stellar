// Pedido ao vivo (2026-09-01): "é preciso registrar o cursor como
// provider, e o antigravity(gemini)".
//
// `mcp-registration.ts` faz isso apontando pro shim stdio, uma vez por
// provider, preguiçosamente (só no primeiro spawn daquele provider) e de
// forma idempotente. Este arquivo checa as três propriedades contra o
// disco de verdade — não contra um mock de fs.
//
// `AGENT_CANVAS_REGISTRATION_HOME` redireciona o `~` que as duas CLIs
// leem, pelo mesmo motivo que `AGENT_CANVAS_MCP_PORT` existe: sem isso
// cada execução deste teste escreveria no `~/.cursor/mcp.json` e no
// `~/.gemini/` REAIS do usuário.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9573;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-provider-registration", import.meta.url).pathname;
const FAKE_HOME = new URL("../../.verify-tmp/smoke-mcp-provider-registration-home", import.meta.url).pathname;
const SHIM = new URL("../../resources/bin/stellar-mcp", import.meta.url).pathname;
const CURSOR_CONFIG = join(FAKE_HOME, ".cursor", "mcp.json");

rmSync(FAKE_HOME, { recursive: true, force: true });
mkdirSync(join(FAKE_HOME, ".cursor"), { recursive: true });
// Um servidor pré-existente do usuário: o registro tem que MERGEAR, nunca
// substituir o arquivo. Foi por medo exatamente disso que o projeto vinha
// evitando escrever em config alheia, então é a checagem que mais importa.
writeFileSync(
  CURSOR_CONFIG,
  JSON.stringify({ mcpServers: { outro: { command: "algum-outro-servidor" } } }, null, 2),
  "utf8",
);

/** Mesma busca em PATH que providers.ts faz — o teste não deve falhar
 * numa máquina sem `agy` instalado. */
function which(names) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

function readCursorConfig() {
  return JSON.parse(readFileSync(CURSOR_CONFIG, "utf8"));
}

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_REGISTRATION_HOME: FAKE_HOME },
});
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Registro MCP");
  await new Promise((r) => setTimeout(r, 600));

  check("o shim existe no lugar em que o registro vai apontar", existsSync(SHIM), true);

  const before = readCursorConfig();
  check("um card bash não toca em config de CLI nenhuma", before.mcpServers.stellar, undefined);

  // Spawna um card cursor pela mesma IPC que a UI usa. O binário pode nem
  // existir na máquina — o registro acontece ANTES do spawn de propósito
  // (a CLI lê o config na subida), então o resultado abaixo não depende de
  // a CLI do Cursor estar instalada.
  // Aguarda a IPC: `pty:spawn` só resolve DEPOIS do registro (é await lá
  // no handler, de propósito — a CLI lê o config na subida). Sem esperar,
  // a leitura abaixo correria antes da escrita.
  await page.evalJs(
    `window.pty.spawn("cursor-probe", "cursor", ${JSON.stringify(FAKE_HOME)}, 80, 24).then(r => JSON.stringify(r))`,
  );
  await new Promise((r) => setTimeout(r, 2500));

  const after = readCursorConfig();
  check("spawnar um card cursor registra o stellar no config global", after.mcpServers?.stellar?.command, SHIM);
  check("...apontando pro shim stdio, não pra uma URL com porta efêmera", /stellar-mcp$/.test(after.mcpServers?.stellar?.command ?? ""), true);
  check("...e MERGEIA: o servidor que o usuário já tinha continua lá", after.mcpServers?.outro?.command, "algum-outro-servidor");

  // Idempotência: um segundo card não deve reescrever nada. Um marcador
  // fora de `mcpServers` sobrevive se (e só se) ninguém regravou o arquivo.
  const marked = readCursorConfig();
  marked.__marcadorDoTeste = 1;
  writeFileSync(CURSOR_CONFIG, JSON.stringify(marked, null, 2), "utf8");
  await page.evalJs(`window.pty.spawn("cursor-probe-2", "cursor", ${JSON.stringify(FAKE_HOME)}, 80, 24)`);
  await new Promise((r) => setTimeout(r, 2000));
  check("um segundo card cursor não reescreve o arquivo", readCursorConfig().__marcadorDoTeste, 1);

  // --- antigravity: sem arquivo conhecido, o registro passa pelo próprio
  // subcomando `agy mcp add`. Só roda se o binário existir na máquina.
  if (which(["agy"])) {
    await page.evalJs(
      `window.pty.spawn("agy-probe", "antigravity", ${JSON.stringify(FAKE_HOME)}, 80, 24).then(r => JSON.stringify(r))`,
    );
    await new Promise((r) => setTimeout(r, 3000));
    // Lido pela própria CLI, com o mesmo HOME redirecionado — é o que o
    // `agy` de verdade enxergaria, não um arquivo que este teste adivinhou.
    const listed = execFileSync("agy", ["mcp", "list"], {
      encoding: "utf8",
      env: { ...process.env, HOME: FAKE_HOME },
      timeout: 20_000,
    });
    check("spawnar um card antigravity registra o stellar no agy", /stellar/.test(listed), true);
    check("...apontando pro mesmo shim stdio", listed.includes(SHIM), true);
  } else {
    console.error("agy não instalado — pulando a perna do antigravity");
  }

  // --- opencode: config próprio (~/.config/opencode/opencode.json, chave
  // `mcp`), lido por fs direto (mesmo padrão do cursor acima) — precisa
  // mergear com o que já está lá (o provider `qwen-local` já configurado
  // nesta máquina, ver ai memory `qwen-buun-local-server`) e ser idempotente.
  const OPENCODE_CONFIG = join(FAKE_HOME, ".config", "opencode", "opencode.json");
  mkdirSync(join(FAKE_HOME, ".config", "opencode"), { recursive: true });
  writeFileSync(
    OPENCODE_CONFIG,
    JSON.stringify({ provider: { "outro-provider": { npm: "@ai-sdk/openai-compatible" } } }, null, 2),
    "utf8",
  );
  function readOpencodeConfig() {
    return JSON.parse(readFileSync(OPENCODE_CONFIG, "utf8"));
  }

  if (which(["opencode"])) {
    await page.evalJs(
      `window.pty.spawn("opencode-probe", "opencode", ${JSON.stringify(FAKE_HOME)}, 80, 24).then(r => JSON.stringify(r))`,
    );
    await new Promise((r) => setTimeout(r, 2500));

    const afterOpencode = readOpencodeConfig();
    check("spawnar um card opencode registra o stellar no config global do opencode", afterOpencode.mcp?.stellar?.type, "local");
    check("...apontando pro shim stdio (command é um array de 1 elemento com o path do shim)", afterOpencode.mcp?.stellar?.command?.[0], SHIM);
    check("...e MERGEIA: o provider `qwen-local` que já estava configurado continua lá", afterOpencode.provider?.["outro-provider"]?.npm, "@ai-sdk/openai-compatible");

    // Idempotência: um segundo card não deve reescrever nada.
    const markedOpencode = readOpencodeConfig();
    markedOpencode.__marcadorDoTeste = 1;
    writeFileSync(OPENCODE_CONFIG, JSON.stringify(markedOpencode, null, 2), "utf8");
    await page.evalJs(`window.pty.spawn("opencode-probe-2", "opencode", ${JSON.stringify(FAKE_HOME)}, 80, 24)`);
    await new Promise((r) => setTimeout(r, 2000));
    check("um segundo card opencode não reescreve o arquivo", readOpencodeConfig().__marcadorDoTeste, 1);
  } else {
    console.error("opencode não instalado — pulando a perna do opencode");
  }
} finally {
  finish();
  await stopApp(app);
}

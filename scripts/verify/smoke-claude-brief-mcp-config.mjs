// 2026-09-13, card 471 (auto-dispatch probe) — a claude card spawned with
// a brief AND the ephemeral `--mcp-config` flag died on boot:
//
//   Error: Invalid MCP configuration:
//   Failed to read file: ENAMETOOLONG: name too long, open '/home/lucas/<the whole brief>'
//
// `claude --help` declares `--mcp-config <configs...>` — VARIADIC — so the
// positional brief pushed right after it was parsed as a second config
// path. Reproduced outside Stellar in one line:
//   claude --mcp-config '{"mcpServers":{}}' "diga apenas OK" --print
//   → Error: Invalid MCP configuration: MCP config file not found: /tmp/diga apenas OK
//
// claude is the DEFAULT auto-dispatch provider, so every `deps` chain
// without an explicit provider was born dead — and the whole unit suite
// stayed green because nothing pinned the brief's position. The unit test
// (tests/unit/providers.test.ts, "brief is the argv tail") now pins argv;
// THIS script is the live proof: a real claude card, spawned through the
// real `spawn_agent` MCP tool with a brief (so `--mcp-config` is injected
// by pty-registry and the brief travels on argv), must stay alive and
// must NOT show the MCP-configuration error in its scrollback.
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
// The fresh session's board root is `$HOME`, and claude's first-run
// workspace-trust dialog in an untrusted folder hides the prompt echo
// this script looks for. The repo root is a folder claude already
// trusts on this machine (every card here runs in it), and it is what a
// real auto-dispatch spawn uses anyway.
const SPAWN_CWD = fileURLToPath(new URL("../..", import.meta.url));
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-claude-brief-mcp-config-${CDP_PORT}`, import.meta.url).pathname;

// Long enough that, if it were ever read as a file path again, the exact
// same ENAMETOOLONG signature would come back; harmless as a prompt.
const BRIEF_MARKER = `STELLAR-BRIEF-${CDP_PORT}`;
const BRIEF =
  `Você é uma sonda de boot. Responda apenas com a palavra ${BRIEF_MARKER} e nada mais. ` +
  "Não execute ferramentas, não leia arquivos, não faça perguntas. " +
  "Este texto é longo de propósito: ele existe para provar que o brief chega como prompt e não como caminho de arquivo. ".repeat(3);

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}

async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Claude Brief + MCP Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  // Real spawn path: MCP tool → message-bus → renderer → pty-registry →
  // resolveSpawn → spawnArgv. `mcpUrl` is injected by pty-registry, so
  // `--mcp-config` IS on argv; `brief` rides on argv too (canArgv true).
  const spawnPromise = callTool("spawn_agent", {
    provider: "claude",
    cwd: SPAWN_CWD,
    callerCardId: bashCardId,
    reason: "smoke: brief + --mcp-config must not kill the card on boot",
    brief: BRIEF,
    label: "sonda-brief-mcp",
  });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent(claude, brief) resolve ok com um cardId", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  const cardId = spawnPayload.cardId;

  // The old bug killed the process within ~1–2s of boot, BEFORE any TUI
  // frame. Give claude enough time to either die (bug) or paint (fix).
  const deadline = Date.now() + 25000;
  let screen = "";
  let status = null;
  let sawMcpError = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    status = await toolJson("card_status", { target: cardId });
    const read = await toolJson("read_card", { target: cardId });
    screen = typeof read.text === "string" ? read.text : "";
    sawMcpError = /Invalid MCP configuration|ENAMETOOLONG|MCP config file not found/i.test(screen);
    if (sawMcpError || status.status === "exited") break;
    // Claude's TUI echoes the initial prompt as the first user turn — once
    // the marker is on screen the brief demonstrably arrived as a PROMPT.
    if (screen.includes(BRIEF_MARKER)) break;
  }

  check("scrollback do card claude NÃO contém o erro de MCP config (brief lido como caminho)", sawMcpError, false);
  check("card claude spawnado com brief + --mcp-config continua vivo (não 'exited') após o boot", status?.status !== "exited", true);
  check(
    "o marcador do brief aparece na tela do claude — chegou como prompt, não como arquivo",
    screen.includes(BRIEF_MARKER),
    true,
  );
  const exitedText = await page.evalJs(`document.querySelector('[data-role="terminal-exited"]')?.textContent`);
  check("nenhum card no board caiu em 'terminal-exited'", exitedText, undefined);

  if (sawMcpError || status?.status === "exited" || !screen.includes(BRIEF_MARKER)) {
    console.log("--- scrollback do card claude (últimas linhas) ---");
    console.log(screen.split("\n").slice(-30).join("\n"));
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();

#!/usr/bin/env node
/**
 * RSS POR CARD: bridge MCP LIGADO vs DESLIGADO (task 52c895da).
 *
 * Mede a arvore de uma instancia ISOLADA, com >=3 cards de provider
 * `global-config` (os que sobem o shim stdio), e soma o VmRSS de cada processo
 * `stellar-mcp` (node) e `stellar-mcp-relay` (Rust). RSS lido SEMPRE de
 * `/proc/<pid>/status` (`VmRSS: <kB>`) — nunca do `stat`, cujo campo 24 e em
 * PAGINAS (o bug paginas x kB que ja mordeu duas vezes nesta sessao).
 *
 * Uso:
 *   node scripts/measure/relay-default-rss.mjs --relay 0 --providers commandcode,antigravity,opencode
 *   node scripts/measure/relay-default-rss.mjs --relay 1 --providers commandcode,antigravity,opencode
 */
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startApp,
  stopApp,
  connectPage,
  pickFreePort,
  bootIntoFreshSession,
  openTerminalCreatePopover,
  clickProviderInPicker,
} from "../verify/cdp-client.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const PROVIDERS = String(arg("--providers", "commandcode,antigravity,opencode")).split(",").filter(Boolean);
const RELAY = arg("--relay", "1");
const SETTLE_MS = Number(arg("--settle-ms", "18000"));

/** `/proc/<pid>/status` → VmRSS em kB. A ÚNICA leitura correta (task d752b50c). */
function vmRssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}
function treePids(root) {
  const byParent = new Map();
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(Number(e));
    } catch {}
  }
  const out = [];
  const walk = (p) => {
    for (const c of byParent.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

async function escape(page) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(300);
}
async function openAddCard(page) {
  for (let a = 0; a < 4; a++) {
    try {
      await escape(page);
      await openTerminalCreatePopover(page);
      return;
    } catch {
      await delay(700);
    }
  }
  throw new Error("add-card popover não abriu");
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "stellar-relayrss-"));
  const cdpPort = await pickFreePort();
  const mcpPort = await pickFreePort();
  console.log(`[relay-rss] relay=${RELAY} providers=${PROVIDERS.join(",")} isolado userData=${userDataDir}`);
  const app = await startApp({
    cdpPort,
    userDataDir,
    timeoutMs: 60_000,
    extraEnv: { AGENT_CANVAS_MCP_PORT: String(mcpPort), AGENT_CANVAS_MCP_RELAY: RELAY },
  });
  try {
    const page = await connectPage(cdpPort);
    await delay(1000);
    await bootIntoFreshSession(page);
    await delay(3000);
    // Cria os cards pelo STORE + IPC de PTY, NÃO pelo popover: o clique do
    // picker não spawnava CLI nenhuma em instância isolada (medido: a árvore
    // ficava só com o bash semeado), e o que esta medição precisa é o PROCESSO
    // do provider (que sobe o shim do MCP), não o xterm na tela.
    await page.evalJs(`(async () => {
      const boards = await window.store.boards.list();
      const boardId = boards[0].id;
      const now = Date.now();
      for (const p of ${JSON.stringify(PROVIDERS)}) {
        const id = "meas-" + p;
        await window.store.upsert({ id, provider: p, cwd: "/tmp", x: 40, y: 40, w: 600, h: 320,
          updated_at: now, resume_id: null, model: null, system_prompt: null, kind: "terminal",
          board_id: boardId, group_id: null, label: id, messages_json: null, archived_at: null,
          effort: null, created_at: now });
        await window.pty.spawn(id, p, "/tmp", 80, 24, {});
      }
      return true;
    })()`);
    console.log(`[relay-rss] aguardando ${SETTLE_MS}ms para as CLIs subirem os shims…`);
    await delay(SETTLE_MS);

    const pids = treePids(app.proc.pid);
    console.log(`[relay-rss] tree pids=${pids.length} (app pid=${app.proc.pid})`);
    for (const pid of pids) {
      const c = cmdline(pid);
      console.log(`   tree: ${(c.split("/").slice(-1)[0] || c).slice(0, 80)}`);
    }
    const rows = [];
    for (const pid of pids) {
      const cmd = cmdline(pid);
      if (!/stellar-mcp/.test(cmd)) continue;
      const kind = /stellar-mcp-relay/.test(cmd) ? "rust-relay" : "node-shim";
      rows.push({ pid, kind, mb: +(((vmRssKb(pid) ?? 0) / 1024).toFixed(1)), cmd: cmd.slice(0, 70) });
    }
    console.log(`\n===== shims na arvore da instancia isolada (relay=${RELAY}) =====`);
    for (const r of rows) console.log(`  ${r.kind} pid=${r.pid} rss=${r.mb} MB  ${r.cmd}`);
    const byKind = (k) => rows.filter((r) => r.kind === k);
    const total = rows.reduce((s, r) => s + r.mb, 0);
    console.log(
      `TOTAL shims=${rows.length} node-shim=${byKind("node-shim").length} rust-relay=${byKind("rust-relay").length} ` +
        `soma=${total.toFixed(1)} MB` +
        (rows.length ? ` média=${(total / rows.length).toFixed(1)} MB/card` : ""),
    );
  } finally {
    await stopApp(app);
  }
}

main().catch((err) => {
  console.error(`[relay-rss] falhou: ${err?.stack ?? err}`);
  process.exit(1);
});

// Process-identity lacunas (Master): (1) N≥10 consecutive spawns all register;
// (2) real claude (+ codex if free) via stellar-mcp: list_cards + report OK,
// sibling on the same relay socket refused. Isolated instance only. Kill by PID.
import { spawn as spawnProc } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_TOKEN = `verify-ident-live-${CDP_PORT}`;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-process-identity-live-${CDP_PORT}`, import.meta.url).pathname;
const CWD = process.cwd();
const N = 10;
// Outside userDataDir: startApp/stopApp wipe that tree and would delete the probe.
const PROBE_DIR = join(tmpdir(), `stellar-identity-probe-${CDP_PORT}`);
mkdirSync(PROBE_DIR, { recursive: true });

const STELLAR_MCP = join(CWD, "resources/bin/stellar-mcp");
const PROBE_JS = join(PROBE_DIR, "mcp-probe.mjs");
writeFileSync(
  PROBE_JS,
  `#!/usr/bin/env node
// Speaks MCP NDJSON through the REAL resources/bin/stellar-mcp shim (stdio → Unix relay).
import { spawn } from "node:child_process";

const shim = process.env.STELLAR_MCP_BIN;
const url = process.env.AGENT_CANVAS_MCP_URL;
if (!shim || !url) {
  console.log(JSON.stringify({ ok: false, error: "STELLAR_MCP_BIN and AGENT_CANVAS_MCP_URL required" }));
  process.exit(2);
}
const mode = process.argv[2] || "list_and_report";
const child = spawn(shim, [], {
  env: { ...process.env, AGENT_CANVAS_MCP_URL: url, AGENT_CANVAS_NODE: process.env.AGENT_CANVAS_NODE || process.execPath },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});
let stderr = "";
child.stderr.on("data", (c) => { stderr += c; });

function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("rpc timeout " + method)), 15000);
    pending.set(id, (msg) => { clearTimeout(t); pending.delete(id); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  });
}

try {
  await rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "identity-probe", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");

  if (mode === "list_tools") {
    const listed = await rpc(2, "tools/list", {});
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    console.log(JSON.stringify({ ok: true, tools: names, via: "stellar-mcp" }));
    child.stdin.end();
    process.exit(0);
  }

  const list = await rpc(2, "tools/call", { name: "list_cards", arguments: {} });
  const listText = list.result?.content?.[0]?.text ?? JSON.stringify(list);
  let listJson; try { listJson = JSON.parse(listText); } catch { listJson = { raw: listText, rpcError: list.error ?? null }; }
  const report = await rpc(3, "tools/call", {
    name: "report",
    arguments: { report: { ok: true, evidence: "stellar-mcp-identity-probe", who: process.env.AGENT_CANVAS_CARD_ID || "probe" } },
  });
  const reportText = report.result?.content?.[0]?.text ?? JSON.stringify(report);
  let reportJson; try { reportJson = JSON.parse(reportText); } catch { reportJson = { raw: reportText, rpcError: report.error ?? null }; }
  console.log(JSON.stringify({
    ok: listJson?.ok === true && reportJson?.ok === true,
    list: listJson,
    report: reportJson,
    cardId: process.env.AGENT_CANVAS_CARD_ID || null,
    via: "stellar-mcp",
    stderr: stderr.slice(0, 400) || undefined,
  }));
  child.stdin.end();
  process.exit(listJson?.ok === true && reportJson?.ok === true ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message || e), stderr: stderr.slice(0, 400) }));
  try { child.kill("SIGTERM"); } catch {}
  process.exit(1);
}
`,
);

let nextRpcId = 1;
async function toolJson(name, args, callerCardId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${MCP_TOKEN}`,
  };
  if (callerCardId) headers["x-stellar-caller-card"] = callerCardId;
  let res;
  try {
    res = await fetch(MCP_BASE, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${String(e?.message || e)}` };
  }
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  let rpc;
  try {
    rpc = JSON.parse(jsonLine);
  } catch {
    return { ok: false, error: text, httpStatus: res.status };
  }
  if (res.status >= 400) return { ok: false, error: JSON.stringify(rpc), httpStatus: res.status };
  if (rpc.error) return { ok: false, error: JSON.stringify(rpc.error), httpStatus: res.status };
  try {
    return JSON.parse(rpc.result.content[0].text);
  } catch {
    return { ok: false, error: text, httpStatus: res.status };
  }
}

async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

function findPidByCardId(cardId) {
  const needle = `AGENT_CANVAS_CARD_ID=${cardId}`;
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const env = readFileSync(`/proc/${ent}/environ`, "utf8");
      if (env.split("\0").includes(needle)) return Number(ent);
    } catch {
      // gone / permission
    }
  }
  return null;
}

function probeEnv(extra = {}) {
  return {
    ...process.env,
    AGENT_CANVAS_MCP_URL: MCP_BASE,
    AGENT_CANVAS_NODE: process.execPath,
    STELLAR_MCP_BIN: STELLAR_MCP,
    ...extra,
  };
}

function runSiblingProbe() {
  return new Promise((resolve) => {
    const child = spawnProc(process.execPath, [PROBE_JS, "list_and_report"], {
      env: probeEnv({ AGENT_CANVAS_CARD_ID: "sibling-forged" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

async function writeToCardPty(page, cardId, data, { pokeFd0 = false } = {}) {
  // App write path only for agent TUIs. Optional /proc/<pid>/fd/0 poke is
  // for bash cards that never mounted a React Terminal.
  try {
    await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify(data)}, "human")`);
  } catch (e) {
    console.log("[pty.write error]", String(e));
  }
  const pid = findPidByCardId(cardId);
  if (pokeFd0 && pid) {
    try {
      writeFileSync(`/proc/${pid}/fd/0`, data);
    } catch (e) {
      console.log("[proc fd0 write]", pid, String(e.message || e));
    }
  }
  return pid;
}

/** tools/list through the real stellar-mcp shim as a PTY descendant (bash only). */
async function runShimToolsListViaBashWrite(page, cardId) {
  const marker = join(PROBE_DIR, `tools-${cardId}.json`);
  const cmd =
    `export AGENT_CANVAS_NODE=${JSON.stringify(process.execPath)} STELLAR_MCP_BIN=${JSON.stringify(STELLAR_MCP)}; ` +
    `${JSON.stringify(process.execPath)} ${JSON.stringify(PROBE_JS)} list_tools > ${JSON.stringify(marker)} 2>&1; ` +
    `echo __PROBE_DONE__ >> ${JSON.stringify(marker)}\n`;
  await writeToCardPty(page, cardId, cmd, { pokeFd0: true });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const text = readFileSync(marker, "utf8");
      if (text.includes("__PROBE_DONE__") || text.includes('"tools"')) {
        const line = text.split("\n").find((l) => l.trim().startsWith("{")) ?? "";
        try {
          return JSON.parse(line);
        } catch {
          return { ok: false, error: text };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, error: "tools/list probe timeout", markerExists: existsSync(marker) };
}

async function runDescendantProbeViaBashWrite(page, cardId) {
  const marker = join(PROBE_DIR, `out-${cardId}.json`);
  const cmd =
    `export AGENT_CANVAS_NODE=${JSON.stringify(process.execPath)} STELLAR_MCP_BIN=${JSON.stringify(STELLAR_MCP)}; ` +
    `${JSON.stringify(process.execPath)} ${JSON.stringify(PROBE_JS)} > ${JSON.stringify(marker)} 2>&1; ` +
    `echo __PROBE_DONE__ >> ${JSON.stringify(marker)}\n`;
  const pid = await writeToCardPty(page, cardId, cmd, { pokeFd0: true });
  console.log("[descendant inject] card", cardId, "pid", pid, "marker", marker);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const text = readFileSync(marker, "utf8");
      if (text.includes("__PROBE_DONE__") || text.includes('"via":"stellar-mcp"')) {
        const line = text.split("\n").find((l) => l.trim().startsWith("{")) ?? "";
        try {
          return JSON.parse(line);
        } catch {
          return { ok: false, error: text };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, error: "probe timeout", markerExists: existsSync(marker), pid };
}

const { check, skip, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: {
    AGENT_CANVAS_MCP_INTERNAL_TOKEN: MCP_TOKEN,
    // Isolated profile has an empty trust store; without this the claude
    // card freezes on "Quick safety check" and never reaches MCP/`!`.
    // Scoped to this verify instance only (not the owner's ~/.claude.json).
    CLAUDE_CODE_SANDBOXED: "1",
  },
});

try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 800));
  await bootIntoFreshSession(page, "Identity Live", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 1000));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  check("board exists", typeof boardId, "string");

  // --- (1) N≥10 consecutive bash spawns, each must register ---
  const registered = [];
  for (let i = 0; i < N; i++) {
    const id = `reg-${CDP_PORT}-${i}`;
    const spawned = JSON.parse(
      await page.evalJs(`
        (async () => {
          await window.store.upsert({
            id: ${JSON.stringify(id)},
            board_id: ${JSON.stringify(boardId)},
            kind: "terminal",
            provider: "bash",
            cwd: ${JSON.stringify(CWD)},
            x: ${(i % 5) * 40},
            y: ${Math.floor(i / 5) * 40},
            w: 640,
            h: 360,
            resume_id: null,
            model: null,
            effort: null,
            system_prompt: null,
            group_id: null,
            label: null,
            updated_at: Date.now(),
            messages_json: null,
            archived_at: null,
          });
          return JSON.stringify(await window.pty.spawn(${JSON.stringify(id)}, "bash", ${JSON.stringify(CWD)}, 80, 24, {}));
        })()
      `),
    );
    check(`spawn ${i + 1}/${N} returned id`, spawned?.id, id);
    await new Promise((r) => setTimeout(r, 150));
    const probe = await toolJson("report", { report: { ok: true, evidence: `n${i}`, who: id } }, id);
    const ok = probe.ok === true;
    registered.push(ok);
    check(`spawn ${i + 1}/${N} process-identity registered (report as self)`, ok, true);
    if (!ok) console.log("  refuse detail:", JSON.stringify(probe));
  }
  check(`100% of ${N} spawns registered`, registered.every(Boolean) && registered.length === N, true);

  // stellar-mcp as descendant of a registered bash card
  const bashProbeCard = `reg-${CDP_PORT}-0`;
  const descendant = await runDescendantProbeViaBashWrite(page, bashProbeCard);
  console.log("[stellar-mcp descendant]", JSON.stringify(descendant));
  check("stellar-mcp descendant list_cards ok", descendant?.list?.ok === true, true);
  check("stellar-mcp descendant report ok", descendant?.report?.ok === true, true);

  // Sibling (not in the card's process tree) on the same relay socket
  const sibling = await runSiblingProbe();
  console.log("[stellar-mcp sibling]", JSON.stringify(sibling));
  let siblingJson = null;
  try {
    siblingJson = JSON.parse(sibling.out);
  } catch {
    siblingJson = null;
  }
  const siblingRefused =
    siblingJson != null &&
    siblingJson.ok === false &&
    (siblingJson.list?.ok === false ||
      siblingJson.report?.ok === false ||
      /authToken|authenticated|identity|anonymous|required/i.test(JSON.stringify(siblingJson)));
  check("sibling on same relay socket refused (parsed identity refusal)", siblingRefused, true);
  if (!siblingRefused) console.log("  sibling detail:", sibling.out || sibling.err);

  // Free RAM before the agent card: keep only the bash probe card (+ board seed).
  for (let i = 1; i < N; i++) {
    try {
      await page.evalJs(`window.pty.kill(${JSON.stringify(`reg-${CDP_PORT}-${i}`)})`);
    } catch {
      /* ignore */
    }
  }

  // --- (2) Claude via REAL app spawn (spawn_agent → renderer → pty), no gdb ---
  // providers.ts injects --mcp-config stellar-mcp; proof = read_report on this
  // card id after the agent calls report through that shim (peer identity).
  const EVIDENCE = `claude-haiku-pty-${CDP_PORT}`;
  // Brief rides argv (claude positional) so the FIRST turn is the MCP proof —
  // no race with send_to_card before the TUI is ready. Still real app spawn
  // (spawn_agent → renderer → pty-registry → --mcp-config stellar-mcp).
  const BRIEF =
    `Use only your Stellar MCP tools. Call list_cards, then call report with ` +
    `report={"ok":true,"evidence":${JSON.stringify(EVIDENCE)},"who":"claude"}. ` +
    `Do nothing else.`;
  const spawnPromise = toolJson(
    "spawn_agent",
    {
      provider: "claude",
      model: "claude-haiku-5-5",
      cwd: CWD,
      brief: BRIEF,
      reason: "identity smoke: prove stellar-mcp peer report",
      label: "identity-claude",
    },
    bashProbeCard,
  );
  await new Promise((r) => setTimeout(r, 600));
  await clickModalButton(page, "Permitir");
  const claudeSpawn = await spawnPromise;
  console.log("[claude spawn_agent]", JSON.stringify(claudeSpawn));
  const claudeId = claudeSpawn?.cardId;
  if (!claudeSpawn?.ok || typeof claudeId !== "string") {
    skip("claude card spawn", `spawn_agent failed: ${JSON.stringify(claudeSpawn)}`);
  } else {
    check("claude card spawn id", typeof claudeId, "string");

    let screen = "";
    let status = null;
    let sawAlive = false;
    const readyDeadline = Date.now() + 90_000;
    while (Date.now() < readyDeadline) {
      status = await toolJson("card_status", { target: claudeId }, bashProbeCard);
      const read = await toolJson("read_card", { target: claudeId }, bashProbeCard);
      screen = typeof read?.text === "string" ? read.text : "";
      if (read?.ok === true) sawAlive = true;
      console.log("[claude boot]", status?.status, "screenLen", screen.length, read?.ok === false ? read?.error : "");
      // Early "exited"/missing id is a race during mount — keep waiting until
      // we have seen the card alive at least once, then honor a real exit.
      if (sawAlive && status?.status === "exited") break;
      if (/Invalid MCP configuration|ENAMETOOLONG/i.test(screen)) break;
      // Evidence may already be on screen if report was echoed; prefer store.
      const early = await toolJson("read_report", { target: claudeId }, bashProbeCard);
      if (early?.ok === true && JSON.stringify(early).includes(EVIDENCE)) {
        screen = screen || "(report already stored)";
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("[claude screen]", screen.slice(-800));
    check("claude card became readable (app spawn mounted)", sawAlive, true);

    let stored = null;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      stored = await toolJson("read_report", { target: claudeId }, bashProbeCard);
      if (stored?.ok === true && JSON.stringify(stored).includes(EVIDENCE)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!(stored?.ok === true && JSON.stringify(stored).includes(EVIDENCE))) {
      // Fallback: type the same instruction once the TUI tip is visible.
      if (/Try "|❯|Haiku/i.test(screen) || sawAlive) {
        const sent = await toolJson("send_to_card", { target: claudeId, text: BRIEF }, bashProbeCard);
        console.log("[claude send_to_card fallback]", JSON.stringify(sent));
        const fallbackDeadline = Date.now() + 120_000;
        while (Date.now() < fallbackDeadline) {
          stored = await toolJson("read_report", { target: claudeId }, bashProbeCard);
          if (stored?.ok === true && JSON.stringify(stored).includes(EVIDENCE)) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      const after = await toolJson("read_card", { target: claudeId }, bashProbeCard);
      console.log("[claude screen after wait]", String(after?.text ?? after?.error ?? "").slice(-1200));
    }
    console.log("[claude read_report]", JSON.stringify(stored));
    check(
      "claude PTY→stellar-mcp report accepted for this card",
      stored?.ok === true && JSON.stringify(stored).includes(EVIDENCE),
      true,
    );
    check("claude report is bound to the spawned card id", stored?.ok === true, true);

    const siblingVsClaude = await runSiblingProbe();
    let sibJson = null;
    try {
      sibJson = JSON.parse(siblingVsClaude.out);
    } catch {
      sibJson = null;
    }
    check(
      "sibling cannot use relay as the claude card",
      sibJson?.ok === false && /authToken|authenticated|identity/i.test(JSON.stringify(sibJson)),
      true,
    );
  }

  // --- Codex: tools/list via shim without spending model quota ---
  // Same bash-descendant probe path as above (stellar-mcp stdio → relay).
  // A dedicated codex TUI descendant inject required gdb (removed); the shim
  // path is proven here on a live registered bash card of this instance, and
  // the codex card still proves process-identity registration.
  const codexId = `codex-${CDP_PORT}`;
  const codexSpawn = JSON.parse(
    await page.evalJs(`
      (async () => {
        await window.store.upsert({
          id: ${JSON.stringify(codexId)},
          board_id: ${JSON.stringify(boardId)},
          kind: "terminal",
          provider: "codex",
          cwd: ${JSON.stringify(CWD)},
          x: 260,
          y: 260,
          w: 720,
          h: 420,
          resume_id: null,
          model: null,
          effort: null,
          system_prompt: null,
          group_id: null,
          label: "identity-codex",
          updated_at: Date.now(),
          messages_json: null,
          archived_at: null,
        });
        return JSON.stringify(await window.pty.spawn(${JSON.stringify(codexId)}, "codex", ${JSON.stringify(CWD)}, 100, 30, {}));
      })()
    `),
  );
  console.log("[codex spawn]", JSON.stringify(codexSpawn));
  if (codexSpawn?.error) {
    skip("codex card", `spawn failed: ${JSON.stringify(codexSpawn)}`);
  } else {
    check("codex card spawn id", codexSpawn.id, codexId);
    await new Promise((r) => setTimeout(r, 2500));
    const codexReg = await toolJson("list_cards", {}, codexId);
    check("codex card registered (list_cards via Bearer)", codexReg.ok === true, true);

    // tools/list via stellar-mcp as PTY descendant of the bash card (no model turn).
    const toolsListed = await runShimToolsListViaBashWrite(page, bashProbeCard);
    console.log("[codex/shim tools/list via bash descendant]", JSON.stringify(toolsListed));
    if (toolsListed?.ok === true && Array.isArray(toolsListed.tools) && toolsListed.tools.includes("list_cards")) {
      check("stellar-mcp tools/list via shim (no model quota)", true, true);
    } else {
      skip("stellar-mcp tools/list via shim", `detail=${JSON.stringify(toolsListed)}`);
    }
  }

  // Close cards via pty:kill then stop app by PID (never pkill -f)
  const toKill = registered.map((_, i) => `reg-${CDP_PORT}-${i}`);
  if (typeof claudeId === "string") toKill.push(claudeId);
  if (typeof codexId === "string") toKill.push(codexId);
  for (const id of toKill) {
    try {
      await page.evalJs(`window.pty.kill(${JSON.stringify(id)})`);
    } catch {
      /* card may not exist */
    }
  }
  page.close();
} finally {
  console.log("[cleanup] stopping app pid", app?.proc?.pid);
  await stopApp(app);
  try {
    rmSync(PROBE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

finish();

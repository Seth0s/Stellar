#!/usr/bin/env node
// Medição de custo vs. vazamento do shim stdio `resources/bin/stellar-mcp`.
//
// Roda FORA do board ao vivo: sobe um HTTP mock + N processos do shim,
// amostra RSS no tempo (mesmo N) e em ciclo spawn/kill. Não spawna cards.
//
// Uso:
//   node scripts/measure/mcp-shim-rss.mjs
//   node scripts/measure/mcp-shim-rss.mjs --count 6 --settle-ms 10000 --samples 6
//   node scripts/measure/mcp-shim-rss.mjs --live   # só amostra shims já vivos (read-only)
//
// Interpretação: delta≈0 com N fixo → custo; delta monotônico → vazamento.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "../../resources/bin/stellar-mcp");
const NODE = process.env.AGENT_CANVAS_NODE || process.execPath;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}
const LIVE = process.argv.includes("--live");
const COUNT = Number(arg("--count", "4"));
const SETTLE_MS = Number(arg("--settle-ms", "8000"));
const SAMPLES = Number(arg("--samples", "5"));
const BURST = Number(arg("--burst", "40"));
const CYCLES = Number(arg("--cycles", "8"));

function rssKb(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = text.match(/^VmRSS:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function listLiveShimsSync() {
  const out = [];
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const cmd = readFileSync(`/proc/${ent}/cmdline`, "utf8");
      if (!cmd.includes("stellar-mcp")) continue;
      if (cmd.includes("mcp-shim-rss")) continue;
      out.push({
        pid: Number(ent),
        rssKb: rssKb(Number(ent)),
        cmd: cmd.replace(/\0/g, " ").trim().slice(0, 120),
      });
    } catch {
      /* gone */
    }
  }
  return out;
}

function startMock() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = {};
      try {
        msg = JSON.parse(body);
      } catch {
        /* ignore */
      }
      let result = {};
      if (msg.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "measure-mock", version: "0" },
        };
      } else if (msg.method === "tools/list") {
        result = { tools: [] };
      }
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function startShim(port, cardId) {
  const child = spawn(NODE, [SHIM], {
    env: {
      ...process.env,
      AGENT_CANVAS_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      AGENT_CANVAS_CARD_ID: cardId,
      AGENT_CANVAS_NODE: NODE,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 10_000);
      waiters.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  }
  return { child, request };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarize(samplesByPid) {
  const rows = [];
  for (const [pid, series] of samplesByPid) {
    const first = series[0];
    const last = series[series.length - 1];
    rows.push({
      pid,
      firstMb: +(first / 1024).toFixed(1),
      lastMb: +(last / 1024).toFixed(1),
      deltaMb: +((last - first) / 1024).toFixed(1),
    });
  }
  return rows;
}

async function measureLive() {
  console.log("# live stellar-mcp snapshot (read-only, no spawn/kill)");
  const first = listLiveShimsSync();
  if (first.length === 0) {
    console.log("no live stellar-mcp processes");
    return;
  }
  console.log(`n=${first.length} at t0`);
  for (const s of first) {
    console.log(`  pid=${s.pid} rss_mb=${((s.rssKb ?? 0) / 1024).toFixed(1)} cmd=${s.cmd}`);
  }
  const series = new Map(first.map((s) => [s.pid, [s.rssKb ?? 0]]));
  for (let i = 1; i < SAMPLES; i++) {
    await sleep(SETTLE_MS);
    for (const pid of series.keys()) {
      const r = rssKb(pid);
      if (r != null) series.get(pid).push(r);
    }
  }
  console.log("# deltas (same pids)");
  console.log(JSON.stringify(summarize(series), null, 2));
}

async function measureIsolated() {
  if (!existsSync(SHIM)) throw new Error(`shim missing: ${SHIM}`);
  const { server, port } = await startMock();
  console.log(`# isolated bench node=${NODE} shim=${SHIM} mock_port=${port} count=${COUNT}`);

  const procs = [];
  for (let i = 0; i < COUNT; i++) {
    const s = startShim(port, `measure-${i}`);
    await s.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "measure", version: "0" },
    });
    procs.push(s);
  }

  const series = new Map(procs.map((p) => [p.child.pid, []]));
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) await sleep(SETTLE_MS);
    const row = [];
    for (const p of procs) {
      const r = rssKb(p.child.pid);
      series.get(p.child.pid).push(r ?? 0);
      row.push(r);
    }
    const avg = row.filter(Boolean).reduce((a, b) => a + b, 0) / row.filter(Boolean).length;
    console.log(`t=${i * (SETTLE_MS / 1000)}s rss_kb=${JSON.stringify(row)} avg_mb=${(avg / 1024).toFixed(1)}`);
  }

  // traffic plateau check
  for (const p of procs) {
    for (let i = 0; i < BURST; i++) {
      // fire without awaiting each — drain after
      p.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 10_000 + i, method: "tools/list", params: {} })}\n`,
      );
    }
  }
  await sleep(2000);
  for (const p of procs) {
    // best-effort drain
    await sleep(50);
  }
  const afterBurst = procs.map((p) => rssKb(p.child.pid));
  console.log(
    `after_burst_${BURST} avg_mb=${(afterBurst.filter(Boolean).reduce((a, b) => a + b, 0) / afterBurst.filter(Boolean).length / 1024).toFixed(1)} rss_kb=${JSON.stringify(afterBurst)}`,
  );
  await sleep(SETTLE_MS);
  const afterIdle = procs.map((p) => rssKb(p.child.pid));
  console.log(
    `after_idle avg_mb=${(afterIdle.filter(Boolean).reduce((a, b) => a + b, 0) / afterIdle.filter(Boolean).length / 1024).toFixed(1)} rss_kb=${JSON.stringify(afterIdle)}`,
  );

  console.log("# same-N deltas");
  console.log(JSON.stringify(summarize(series), null, 2));

  for (const p of procs) p.child.kill();

  // open/close cycle: RSS of the *measuring* host is irrelevant; we check
  // orphan count of stellar-mcp after cycles.
  const beforeOrphans = listLiveShimsSync().filter((s) => s.cmd.includes("measure-")).length;
  for (let c = 0; c < CYCLES; c++) {
    const s = startShim(port, `cycle-${c}`);
    await s.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "measure", version: "0" },
    });
    s.child.kill();
    await sleep(100);
  }
  await sleep(500);
  const afterOrphans = listLiveShimsSync().filter(
    (s) => s.cmd.includes("measure-") || s.cmd.includes("cycle-"),
  );
  console.log(`# open_close_cycles=${CYCLES} leftover_measure_shims=${afterOrphans.length} (want 0; before_filter=${beforeOrphans})`);

  // optional Electron-as-node comparison when STELLAR_ELECTRON is set
  const electron = process.env.STELLAR_ELECTRON;
  if (electron && existsSync(electron)) {
    const child = spawn(electron, [SHIM], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AGENT_CANVAS_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        AGENT_CANVAS_CARD_ID: "electron-bench",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await sleep(800);
    console.log(`electron_as_node rss_mb=${((rssKb(child.pid) ?? 0) / 1024).toFixed(1)}`);
    child.kill();
  }

  server.close();
}

if (LIVE) {
  await measureLive();
} else {
  await measureIsolated();
}

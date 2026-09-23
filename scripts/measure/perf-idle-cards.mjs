#!/usr/bin/env node
/**
 * CUSTO POR CARD OCIOSO QUE REPINTA (task 27e13021, "MEASURE FIRST").
 *
 * O sintoma do dono: ~10 fps, CPU alto, GPU ~0%, RAM+swap esgotados com cards de
 * agente OCIOSOS abertos. Este harness mede a parte que é ATRIBUÍVEL ao Stellar —
 * o custo por card ocioso que continua emitindo bytes — sem agente real, sem
 * login e sem quota:
 *
 *   · instância ISOLADA (userData em tmp, destruída e verificada no fim);
 *   · N cards de bash rodando `fixtures/idle-tui.mjs`, que repinta na taxa pedida
 *     e REPORTA os bytes/s que ofereceu (o denominador do custo);
 *   · amostragem de CPU%/RSS por PROCESSO do Stellar (main/renderer/gpu/zygote),
 *     lida de /proc — nunca do processo do dono.
 *
 * Como ler o resultado (a razão do "--cards 0"): o número que interessa não é o
 * total, é o MARGINAL. Rode com --cards 0 (linha de base) e com --cards N, e passe
 * o JSON da primeira em --baseline: o harness imprime o custo POR CARD.
 *
 * Uso:
 *   node scripts/measure/perf-idle-cards.mjs --cards 0  --seconds 30 --json /tmp/base.json
 *   node scripts/measure/perf-idle-cards.mjs --cards 5  --seconds 30 --baseline /tmp/base.json
 *   node scripts/measure/perf-idle-cards.mjs --cards 5  --browser        # + 1 card de navegador
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, pickFreePort } from "../verify/cdp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "idle-tui.mjs");
const CLK_TCK = 100; // Linux: _SC_CLK_TCK. O harness é Linux-only por ora.

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const CARDS = Number(arg("--cards", "5"));
const SECONDS = Number(arg("--seconds", "30"));
const RATE = Number(arg("--rate", "10"));
const JSON_OUT = arg("--json", null);
const BASELINE = arg("--baseline", null);
const WITH_BROWSER = process.argv.includes("--browser");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lê utime+stime (ticks), RSS (kB) e o `--type=` do cmdline de um pid. */
function readProc(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rssKb = Number(fields[21]);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? "main";
    return { pid, cpuTicks: utime + stime, rssKb, type };
  } catch {
    return null;
  }
}

/** Todos os descendentes do pid raiz (o app é `detached`, então o grupo é dele). */
function treePids(rootPid) {
  const byParent = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(Number(entry));
    } catch {
      // processo morreu entre o readdir e o read: ignora.
    }
  }
  const out = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(rootPid);
  return out;
}

async function main() {
  if (!existsSync(FIXTURE)) throw new Error(`fixture ausente: ${FIXTURE}`);
  const userDataDir = join(tmpdir(), `stellar-perf-${process.pid}`);
  const cdpPort = await pickFreePort();
  console.log(`[perf] instância ISOLADA: userData=${userDataDir} cdp=${cdpPort} cards=${CARDS} rate=${RATE}fps`);

  const app = await startApp({ cdpPort, userDataDir, timeoutMs: 60_000 });
  let page = null;
  try {
    page = await connectPage(cdpPort);
    // Uma instância nova não tem board nenhum (o app cria quando o humano abre
    // uma sessão). Aqui o board é criado pela MESMA API da UI, sem clique: o
    // benchmark não pode depender de coordenadas de tela para medir CPU.
    const boardId = await page.evalJs(`(async () => {
      const existentes = await window.store.boards.list();
      if (existentes.length > 0) return existentes[0].id;
      const now = Date.now();
      const id = "perf-board";
      await window.store.boards.upsert({ id, name: "Perf", project: "Perf", cwd: "/tmp", created_at: now, updated_at: now,
        last_accessed_at: now, autonomous: 0, concurrency_cap: null, orchestrator_card_id: null });
      const depois = await window.store.boards.list();
      return depois.length > 0 ? depois[0].id : null;
    })()`);
    if (!boardId) throw new Error("board não pôde ser criado na instância isolada");

    // Cards: o MESMO caminho da UI (persistir a linha + subir o PTY), pela API do
    // renderer — sem consentimento de agente e sem passar pelo bus de mensagens.
    for (let i = 0; i < CARDS; i += 1) {
      const id = `perf-card-${i}`;
      await page.evalJs(`(async () => {
        const now = Date.now();
        await window.store.upsert({ id: ${JSON.stringify(id)}, provider: "bash", cwd: "/tmp", x: 40 + ${i} * 30, y: 40, w: 700, h: 360,
          updated_at: now, resume_id: null, model: null, system_prompt: null, kind: "terminal", board_id: ${JSON.stringify(boardId)},
          group_id: null, label: ${JSON.stringify(id)}, messages_json: null, archived_at: null, effort: null, created_at: now });
        await window.pty.spawn(${JSON.stringify(id)}, "bash", "/tmp", 80, 24);
        return true;
      })()`);
    }

    if (WITH_BROWSER) {
      await page.evalJs(`(async () => {
        const now = Date.now();
        await window.store.upsert({ id: "perf-browser", provider: "browser", cwd: "/tmp", x: 40, y: 420, w: 700, h: 360,
          updated_at: now, resume_id: null, model: null, system_prompt: null, kind: "browser", board_id: ${JSON.stringify(boardId)},
          group_id: null, label: "perf-browser", messages_json: null, archived_at: null, effort: null, created_at: now });
        return true;
      })()`);
    }

    await delay(4000); // os shells sobem
    for (let i = 0; i < CARDS; i += 1) {
      const cmd = `node ${FIXTURE} ${RATE}`;
      await page.evalJs(`window.pty.write("perf-card-${i}", ${JSON.stringify(cmd + "\r")}, "human").then(() => true)`);
    }
    await delay(4000); // a TUI sintética começa a repintar

    if (process.env.PERF_DEBUG) {
      console.log(`[perf:debug] main=${app.proc.pid} vivos=${app.proc.exitCode === null} arvore=${treePids(app.proc.pid).length}`);
    }
    const pids = treePids(app.proc.pid);
    const before = new Map();
    for (const pid of pids) {
      const proc = readProc(pid);
      if (proc) before.set(pid, proc);
    }
    const t0 = Date.now();
    await delay(SECONDS * 1000);
    const elapsed = (Date.now() - t0) / 1000;

    const rows = [];
    for (const pid of treePids(app.proc.pid)) {
      const now = readProc(pid);
      const prev = before.get(pid);
      if (!now) continue;
      rows.push({
        pid,
        type: now.type,
        cpuPct: prev ? ((now.cpuTicks - prev.cpuTicks) / (elapsed * CLK_TCK)) * 100 : 0,
        rssMb: now.rssKb / 1024,
      });
    }
    const byType = new Map();
    for (const row of rows) {
      const acc = byType.get(row.type) ?? { type: row.type, cpuPct: 0, rssMb: 0, count: 0 };
      acc.cpuPct += row.cpuPct;
      acc.rssMb += row.rssMb;
      acc.count += 1;
      byType.set(row.type, acc);
    }
    const totalCpu = [...byType.values()].reduce((s, r) => s + r.cpuPct, 0);
    const totalRss = [...byType.values()].reduce((s, r) => s + r.rssMb, 0);

    console.log(`\n[perf] ${CARDS} card(s) ociosos repintando a ${RATE} fps, ${elapsed.toFixed(1)}s de amostra`);
    console.log("processo        n   cpu%    rss(MB)");
    for (const row of [...byType.values()].sort((a, b) => b.cpuPct - a.cpuPct)) {
      console.log(`${row.type.padEnd(14)} ${String(row.count).padStart(2)}  ${row.cpuPct.toFixed(1).padStart(5)}  ${row.rssMb.toFixed(0).padStart(7)}`);
    }
    console.log(`${'TOTAL'.padEnd(14)} ${String(rows.length).padStart(2)}  ${totalCpu.toFixed(1).padStart(5)}  ${totalRss.toFixed(0).padStart(7)}`);

    const result = { cards: CARDS, rate: RATE, seconds: elapsed, withBrowser: WITH_BROWSER, totalCpuPct: totalCpu, totalRssMb: totalRss, byType: [...byType.values()] };
    if (BASELINE && existsSync(BASELINE)) {
      const base = JSON.parse(readFileSync(BASELINE, "utf8"));
      const dCards = CARDS - base.cards;
      const dCpu = totalCpu - base.totalCpuPct;
      const dRss = totalRss - base.totalRssMb;
      console.log(`\n[perf] MARGINAL vs baseline (${base.cards} card(s)): Δcpu=${dCpu.toFixed(1)}pp para ${dCards} card(s)`);
      if (dCards > 0) {
        console.log(`[perf] CUSTO POR CARD OCIOSO: cpu=${(dCpu / dCards).toFixed(2)}pp  rss=${(dRss / dCards).toFixed(0)} MB`);
        result.perCard = { cpuPct: dCpu / dCards, rssMb: dRss / dCards };
      }
    }
    if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await stopApp(app);
    console.log(`[perf] userData isolado destruído: ${!existsSync(userDataDir)}`);
  }
}

main().catch((err) => {
  console.error(`[perf] falhou: ${err?.stack ?? err}`);
  process.exit(1);
});

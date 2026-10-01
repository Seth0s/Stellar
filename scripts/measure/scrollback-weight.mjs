#!/usr/bin/env node
/**
 * PESO DO `scrollback: 10000` POR CARD (task 5d24ada3).
 *
 * Mede, num card de TERMINAL real (xterm.js no renderer), quanto o buffer de
 * scrollback custa de HEAP ao encher. Estratégia: imprime o buffer em ESTÁGIOS
 * crescentes e amostra `JSHeapUsedSize` (CDP `Performance.getMetrics`) depois de
 * cada estágio — a INCLINAÇÃO (bytes por linha) é o número que interessa, e ela
 * projeta o custo do teto de 10.000 linhas do `useTerminal.ts`.
 *
 * Linhas longas de propósito (~200 chars): produção real (logs, diffs, TUIs de
 * agente) tem linhas longas, e um buffer de 10.000 linhas CURTAS subestima.
 *
 * Uso: node scripts/measure/scrollback-weight.mjs [--stage 2000] [--stages 5]
 */
import {
  startApp,
  stopApp,
  connectPage,
  pickFreePort,
  bootIntoFreshSession,
} from "../verify/cdp-client.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback;
};
const STAGE = Number(arg("--stage", "2000"));
const STAGES = Number(arg("--stages", "5"));
const LINE_CHARS = Number(arg("--line-chars", "200"));

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/scrollback-weight-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, timeoutMs: 60_000 });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Scrollback Weight");

  // Espera o primeiro terminal registrar no xterm (mesmo gate do harness).
  let termId = null;
  for (let i = 0; i < 60 && !termId; i += 1) {
    await delay(250);
    termId = await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        if (!boards.length) return null;
        const cards = await window.store.list(boards[0].id);
        return cards.filter((c) => c.kind === "terminal" && window.__getTerminalDims?.(c.id)).map((c) => c.id)[0] ?? null;
      })()
    `);
  }
  if (!termId) throw new Error("nenhum terminal registrado no xterm");
  console.log(`[scrollback] terminal ${termId}; estágios de ${STAGE} linhas × ${STAGES} (~${LINE_CHARS} chars/linha)`);

  await page.send("Performance.enable");
  const sample = async () => {
    const metrics = (await page.send("Performance.getMetrics")).metrics;
    const v = (k) => Number((metrics.find((m) => m.name === k) ?? { value: 0 }).value);
    return { heap: v("JSHeapUsedSize"), nodes: v("Nodes") };
  };

  const base = await sample();
  const rows = [];
  let printed = 0;
  for (let s = 1; s <= STAGES; s += 1) {
    const n = STAGE;
    const cmd =
      `node -e "for(let i=0;i<${n};i++)console.log(String(i).padStart(6,'0')+' '+'x'.repeat(${LINE_CHARS}))"`;
    printed += n;
    await page.evalJs(`window.pty.write(${JSON.stringify(termId)}, ${JSON.stringify(cmd + "\r")}, "human")`);
    // Espera a saída drenar (o eco de 2000 linhas é rápido; folga real).
    await delay(3500);
    const s2 = await sample();
    rows.push({ printed, heapMb: (s2.heap - base.heap) / 1024 / 1024, nodes: s2.nodes - base.nodes });
    console.log(`[scrollback] +${n} linhas (total ${printed}): heap +${rows[rows.length - 1].heapMb.toFixed(1)} MB, nodes +${rows[rows.length - 1].nodes}`);
  }

  // Inclinação por linha entre o primeiro e o último estágio (ignora o custo
  // fixo do ciclo anterior já drenado).
  const first = rows[0];
  const last = rows[rows.length - 1];
  const perLineBytes = ((last.heapMb - first.heapMb) * 1024 * 1024) / (last.printed - first.printed);
  const projected10kMb = ((base ? 0 : 0) + perLineBytes * 10000) / 1024 / 1024;
  console.log(`\n[scrollback] INCLINAÇÃO: ${perLineBytes.toFixed(1)} bytes/linha`);
  console.log(`[scrollback] PROJEÇÃO scrollback=10000 cheio: ~${projected10kMb.toFixed(1)} MB por card`);
  console.log(`[scrollback] (heap foi ${(base.heap / 1024 / 1024).toFixed(1)} MB → ${(last.heapMb + base.heap / 1024 / 1024).toFixed(1)} MB com ${last.printed} linhas)`);

  page.close();
} finally {
  await stopApp(app);
}

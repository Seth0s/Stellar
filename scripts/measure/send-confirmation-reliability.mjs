#!/usr/bin/env node
/**
 * MATRIZ DE CONFIABILIDADE DA CONFIRMAÇÃO DE ENTREGA (task e1aa745d).
 *
 * Mede, por provider REAL, o veredito que o app dá a um `send_to_card`
 * (`delivered`/`unconfirmed`/`failed`/`parked`) CONTRA o fato "o texto chegou?",
 * verificado pelo scrollback (`read_card`). Duas taxas:
 *
 *   FALSO POSITIVO — o app diz entregue (`delivered`) e o texto NÃO chegou.
 *   FALSO NEGATIVO — o app diz `unconfirmed`/`failed` e o texto CHEGOU.
 *
 * Como: instância ISOLADA (`userData` em tmp), cards criados pela UI (o mesmo
 * par de helpers dos smokes), e as ações pelo endpoint MCP REAL do app
 * (`send_to_card` / `get_delivery` / `read_card`) — nada de mock no caminho da
 * confirmação; o que se mede é o `deliverCard` de produção.
 *
 * Uso:
 *   node scripts/measure/send-confirmation-reliability.mjs                 # claude,cursor,commandcode,opencode,antigravity
 *   node scripts/measure/send-confirmation-reliability.mjs --providers claude,commandcode --n 2
 *
 * HONESTIDADE: um provider que não sobe (login, picker, TUI que não desenha) é
 * reportado como NÃO MEDIDO — nunca inferido.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
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
const PROVIDERS = String(arg("--providers", "claude,cursor,commandcode,opencode,antigravity")).split(",").filter(Boolean);
const N = Number(arg("--n", "2"));
// `--long`: corpo multi-linha >=120 chars — é o caminho do CHIP `[Pasted text]`,
// onde moraram os relatos de duplicada/triplicada e de falso negativo.
const LONG = process.argv.includes("--long");

/** Chama uma tool MCP no endpoint HTTP do app (stateless: um POST por mensagem). */
async function mcpCall(url, cardId, name, args) {
  const res = await fetch(`${url}?card=${encodeURIComponent(cardId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  const content = payload?.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : payload;
}

async function waitFor(fn, { timeoutMs = 20000, everyMs = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await delay(everyMs);
  }
  return null;
}

/** Um texto único o bastante para o scrollback distinguir sem ambiguidade. */
function token(provider, i) {
  return `MEASURE-${provider.toUpperCase()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Fecha um popover aberto (o add-card FICA aberto depois do 1º card, e abrir
 * de novo TOGGLA em vez de abrir — foi o que fez o 2º provider falhar). */
async function escape(page) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(300);
}

async function measureProvider(page, url, provider, rows) {
  await escape(page);
  await openTerminalCreatePopover(page);
  await clickProviderInPicker(page, provider);
  const cardId = await waitFor(async () => {
    const ids = JSON.parse(
      await page.evalJs(`
        (async () => {
          const boards = await window.store.boards.list();
          if (!boards.length) return JSON.stringify([]);
          const cards = await window.store.list(boards[0].id);
          return JSON.stringify(cards.filter((c) => c.kind === "terminal" && window.__getTerminalDims?.(c.id)).map((c) => c.id));
        })()
      `),
    );
    return Array.isArray(ids) && ids.length > 0 ? ids[ids.length - 1] : null;
  }, { timeoutMs: 20000 });
  if (!cardId) {
    rows.push({ provider, cardId: null, note: "card não registrou no xterm" });
    return;
  }
  // A TUI precisa desenhar antes de medir confirmação de TEXTO.
  await delay(8000);

  // `--midturn`: primeiro põe o agente num turno LONGO, e só então mede — é o
  // regime do relato do orquestrador ("unconfirmed enquanto o agente
  // trabalhava"). Sem isto, todo envio mede o caminho OCIOSO (o fácil).
  if (process.argv.includes("--midturn")) {
    await mcpCall(url, "harness", "send_to_card", {
      target: cardId,
      text: "Execute no shell: sleep 60; depois responda apenas DONE.",
      steer: false,
    });
    await delay(9000);
  }

  for (let i = 0; i < N; i++) {
    const tok = token(provider, i);
    const text = LONG
      ? [tok, ...Array.from({ length: 8 }, (_, k) => `linha ${k} ${"x".repeat(40)}`)].join("\n")
      : tok;
    const sent = await mcpCall(url, "harness", "send_to_card", { target: cardId, text, steer: false });
    if (!sent?.id) {
      rows.push({ provider, cardId, i, verdict: `send-failed:${sent?.error ?? "?"}`, arrived: null });
      continue;
    }
    // Espera o FIFO assentar (o delivery settle é o que gera o veredito).
    const settled = await waitFor(async () => {
      const rec = await mcpCall(url, "harness", "get_delivery", { id: sent.id });
      return rec && rec.delivery && rec.delivery !== "queued" ? rec : null;
    }, { timeoutMs: 40000, everyMs: 500 });
    const verdict = settled?.delivery ?? "no-settle";
    const confirm = settled?.confirm ?? null;
    const back = await mcpCall(url, "harness", "read_card", { target: cardId, lines: 200 });
    const screen = typeof back?.text === "string" ? back.text : JSON.stringify(back);
    // A chegada é medida pelo TOKEN (1ª linha), não pelo corpo inteiro: o
    // scrollback quebra linha e um multi-linha nunca casaria literal.
    const arrived = screen.includes(tok);
    rows.push({ provider, cardId, i, verdict, confirm, arrived });
    await delay(1500);
  }
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "stellar-sendrel-"));
  const cdpPort = await pickFreePort();
  const mcpPort = await pickFreePort();
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  console.log(`[sendrel] isolado userData=${userDataDir} cdp=${cdpPort} mcp=${mcpPort} providers=${PROVIDERS.join(",")} n=${N}`);

  const app = await startApp({
    cdpPort,
    userDataDir,
    timeoutMs: 60_000,
    extraEnv: { AGENT_CANVAS_MCP_PORT: String(mcpPort) },
  });
  const rows = [];
  try {
    const page = await connectPage(cdpPort);
    await delay(1000);
    await bootIntoFreshSession(page);
    await delay(3000);
    for (const provider of PROVIDERS) {
      try {
        await measureProvider(page, url, provider, rows);
      } catch (err) {
        rows.push({ provider, note: `medição falhou: ${err?.message ?? err}` });
      }
    }
  } finally {
    await stopApp(app);
  }

  console.log("\n===== MATRIZ (veredito do app × o texto CHEGOU) =====");
  for (const p of PROVIDERS) {
    const rs = rows.filter((r) => r.provider === p);
    if (rs.length === 0) {
      console.log(`${p}: NÃO MEDIDO`);
      continue;
    }
    if (rs[0].note && rs.length === 1) {
      console.log(`${p}: NÃO MEDIDO (${rs[0].note})`);
      continue;
    }
    const got = rs.filter((r) => r.arrived === true);
    const delivered = rs.filter((r) => r.verdict === "delivered");
    const fp = rs.filter((r) => r.verdict === "delivered" && r.arrived === false);
    const fn = rs.filter((r) => (r.verdict === "unconfirmed" || r.verdict === "failed") && r.arrived === true);
    console.log(
      `${p}: n=${rs.length} chegaram=${got.length} delivered=${delivered.length} ` +
        `FALSO_POS=${fp.length} FALSO_NEG=${fn.length}`,
    );
    for (const r of rs) console.log(`    #${r.i} verdict=${r.verdict} arrived=${r.arrived} confirm=${JSON.stringify(r.confirm)}`);
  }
  writeFileSync(join(tmpdir(), "stellar-sendrel-matrix.json"), JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(`[sendrel] falhou: ${err?.stack ?? err}`);
  process.exit(1);
});

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

/**
 * Abre o popover de add-card de forma ROBUSTA. O add-card FICA aberto depois
 * do 1º card e um novo clique na rail TOGGLA (fecha) — era a causa do
 * "terminal option not found" na rodada 1 (e do opencode não criar card).
 */
async function openAddCard(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await escape(page);
      await openTerminalCreatePopover(page);
      return;
    } catch {
      await delay(700);
    }
  }
  throw new Error("add-card popover não abriu após 4 tentativas");
}

async function measureProvider(page, url, provider, rows) {
  await openAddCard(page);
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

  // `--midturn`: primeiro PÕE o agente num turno longo e PROVA que há turno —
  // só então mede. A rodada 1 usou `sleep 60` (permissão de ferramenta,
  // provavelmente não engajou) e mediu sem prova: o confirm saiu attempts=1/
  // "sent", que é o caminho OCIOSO. Aqui o turno é uma GERAÇÃO longa (sem
  // ferramenta, sem permissão) e a prova é a TELA MUDAR: um card ocioso tem
  // tela estática; um card em turno REPINTA. Sem >=4 telas distintas, o
  // regime NÃO foi atingido e o provider é declarado — nunca medido no escuro.
  let turnActive = null;
  if (process.argv.includes("--midturn")) {
    await mcpCall(url, "harness", "send_to_card", {
      target: cardId,
      text: "Escreva um ensaio longo (pelo menos 1500 palavras) sobre a história da computação, em português. Não use ferramentas.",
      steer: false,
    });
    const distinct = new Set();
    for (let k = 0; k < 24; k++) {
      await delay(1000);
      const r = await mcpCall(url, "harness", "read_card", { target: cardId, lines: 200 });
      if (typeof r?.text === "string") distinct.add(r.text.slice(-4000));
      if (distinct.size >= 4) break;
    }
    turnActive = distinct.size >= 4;
    console.log(`[sendrel] ${provider}: turno ativo=${turnActive} (${distinct.size} telas distintas em ~24s)`);
    if (!turnActive) {
      rows.push({ provider, cardId, note: `mid-turn NÃO atingido (${distinct.size} telas distintas)` });
      return;
    }
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
    rows.push({ provider, cardId, i, verdict, confirm, arrived, turnActive });
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

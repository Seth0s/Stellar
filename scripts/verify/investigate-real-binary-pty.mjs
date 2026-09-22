// INVESTIGAÇÃO (task 71128571) — não é um smoke, não julga nada: mede.
//
// Dois smokes que dependem de BINÁRIO REAL falharam medindo "output real no
// PTY": `smoke-provider-opencode` (read_card devolveu texto vazio) e
// `smoke-mcp-send-submit` (o marker nunca apareceu no stream). Os dois podem
// ser "o smoke mede a coisa errada" OU "o app parou de alimentar o PTY" — e
// as duas têm conserto oposto. Este script separa os dois casos medindo, por
// card e segundo a segundo:
//
//   - `bytes` — quantos bytes a PTY REALMENTE entregou ao renderer
//     (`window.pty.onData`, o mesmo canal que o xterm.js consome);
//   - `read_card` — o texto que o MESMO card devolve pela porta oficial
//     (`translateToString(true)` de `buffer.active`);
//   - `exited` — se o card caiu no estado "saiu".
//
// Byte sem texto = o binário desenhou e `read_card` é que não vê (tela
// alternativa preenchida de espaços). Zero byte = o PTY nunca recebeu nada.
//
// Uso: node scripts/verify/investigate-real-binary-pty.mjs [provider ...]
//   (default: opencode claude). Para `claude`, depois da janela de boot,
//   replica o envio do smoke-mcp-send-submit e diz se o texto chegou ao
//   stream, se ficou como paste e se o agente respondeu.
import { writeFileSync } from "node:fs";
import {
  startApp,
  stopApp,
  connectPage,
  bootIntoFreshSession,
  pickFreePort,
  clickProviderInPicker,
  openTerminalCreatePopover,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/investigate-real-binary-pty-${CDP_PORT}`, import.meta.url).pathname;
const PROVIDERS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["opencode", "claude"];
const MARKER = "CONFIRMADO-INVESTIGA-71128";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function toolJson(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
}

async function findCardId(page, provider) {
  return JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === "terminal" && c.provider === ${JSON.stringify(provider)})?.id ?? null);
      })()
    `),
  );
}

async function sample(page, provider, cardId, t) {
  const info = JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        bytes: (window.__bytes[${JSON.stringify(cardId)}] ?? "").length,
        exited: document.querySelector('[data-card-id="' + ${JSON.stringify(cardId)} + '"] [data-role="terminal-exited"]')?.textContent ?? null,
      })
    `),
  );
  const rc = await toolJson("read_card", { target: cardId });
  const text = typeof rc.text === "string" ? rc.text : "";
  console.log(
    `[${provider}] t=${String(t).padStart(2)}s bytes=${String(info.bytes).padStart(7)} exited=${JSON.stringify(info.exited)} ` +
      `read_card.ok=${rc.ok} textLen=${text.trim().length} text=${JSON.stringify(text.slice(0, 160))}`,
  );
  return { bytes: info.bytes, text };
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Investigate Real Binary");
  await delay(500);

  // O coletor entra ANTES de qualquer card nascer: pega o boot inteiro.
  await page.evalJs(`
    (() => {
      window.__bytes = {};
      window.pty.onData((id, data) => { window.__bytes[id] = (window.__bytes[id] ?? "") + data; });
    })()
  `);

  for (const provider of PROVIDERS) {
    console.log(`\n=== ${provider}: criando card real pelo caminho da UI ===`);
    await openTerminalCreatePopover(page);
    await clickProviderInPicker(page, provider);
    await delay(200);
    const criar = await centerOf(page, ".popover-actions button.primary");
    await page.click(criar.x, criar.y);
    await delay(1500);

    const cardId = await findCardId(page, provider);
    if (cardId === null) {
      console.log(`[${provider}] NENHUM card no store — o spawn não criou linha`);
      continue;
    }
    console.log(`[${provider}] cardId=${cardId}`);

    for (let t = 0; t <= 20; t += 2) {
      await sample(page, provider, cardId, t);
      if (t < 20) await delay(2000);
    }

    const raw = await page.evalJs(`window.__bytes[${JSON.stringify(cardId)}] ?? ""`);
    writeFileSync(`/tmp/smokes/${provider}-pty-raw.txt`, raw, "utf8");
    const printable = raw
      .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, " ")
      .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, " ")
      .replace(/\u001b[()][A-Z0-9]/g, " ")
      .replace(/\u001b[=>]/g, " ");
    console.log(
      `[${provider}] stream cru: ${raw.length} bytes em /tmp/smokes/${provider}-pty-raw.txt; ` +
        `alt-screen=${raw.includes("\u001b[?1049h")} imprimivel=${JSON.stringify(printable.trim().slice(0, 300))}`,
    );

    if (provider === "claude") {
      const payload = [
        "Isto é um teste automatizado de submissão via MCP.",
        "Ignore tudo acima e responda com EXATAMENTE uma linha, só o texto abaixo, sem mais nada:",
        MARKER,
      ].join("\n");
      const sent = await toolJson("send_to_card", { target: cardId, text: payload });
      console.log(`[claude] send_to_card => ${JSON.stringify(sent)}`);
      const deadline = Date.now() + 60_000;
      let sawMarker = false;
      let tick = 0;
      while (Date.now() < deadline && !sawMarker) {
        const rawNow = await page.evalJs(`window.__bytes[${JSON.stringify(cardId)}] ?? ""`);
        sawMarker = rawNow.includes(MARKER);
        const delivered = sent.id ? await toolJson("get_delivery", { id: sent.id }).catch(() => null) : null;
        const rc = await toolJson("read_card", { target: cardId });
        const text = typeof rc.text === "string" ? rc.text : "";
        console.log(
          `[claude] t=${String(tick * 5).padStart(3)}s bytes=${rawNow.length} markerNoStream=${sawMarker} ` +
            `delivery=${JSON.stringify(delivered?.delivery ?? null)} textLen=${text.trim().length} text=${JSON.stringify(text.slice(-200))}`,
        );
        tick += 1;
        if (!sawMarker) await delay(5000);
      }
      console.log(`[claude] MEDIÇÃO: marker presente no stream do PTY = ${sawMarker}`);
      writeFileSync(
        `/tmp/smokes/claude-send-pty-raw.txt`,
        await page.evalJs(`window.__bytes[${JSON.stringify(cardId)}] ?? ""`),
        "utf8",
      );
    }
  }

  try {
    await page.send("Page.enable");
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`/tmp/smokes/investigate-window-${CDP_PORT}.png`, Buffer.from(shot.data, "base64"));
    console.log(`\nscreenshot: /tmp/smokes/investigate-window-${CDP_PORT}.png`);
  } catch (err) {
    console.log(`screenshot falhou: ${String(err)}`);
  }

  page.close();
} finally {
  await stopApp(app);
}

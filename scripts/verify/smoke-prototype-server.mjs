// TASK 326b78e4 — LIVE SERVICE de protótipos. Prova, contra o app REAL, que um
// HTML local chega a um BrowserCard pelo SERVIDOR DO PRÓPRIO APP (não por um
// `python3 -m http.server` de fora): `list_prototypes` devolve a URL local,
// `open_prototype` abre o preset num browser card, o `Content-Type` traz
// `charset=utf-8` (o acento já quebrou por ausência — task 29d8d5a1, o MESMO
// corpo sem charset vira mojibake), a página REAGE a um clique real, e uma
// travessia de path é recusada.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
  enableAutonomousMode,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-prototype-server-${CDP_PORT}`, import.meta.url).pathname;

const ACCENT = "Ação, coração, ção, ã, é, ü";
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>proto</title>
<style>body{margin:0;font-family:sans-serif}#btn{position:absolute;top:40px;left:20px;width:160px;height:44px}</style>
</head><body>
  <h1 id="accent">${ACCENT}</h1>
  <button id="btn" onclick="document.title='proto-clicked'">Salvar</button>
</body></html>`;

// Um projeto de teste: <proj>/prototypes/{index.html,prototypes.json}
const PROJ = mkdtempSync(join(tmpdir(), "stellar-prototype-smoke-"));
mkdirSync(join(PROJ, "prototypes"), { recursive: true });
writeFileSync(join(PROJ, "prototypes", "index.html"), HTML, "utf8");
writeFileSync(
  join(PROJ, "prototypes", "prototypes.json"),
  JSON.stringify({ presets: [{ name: "demo", file: "index.html", description: "protótipo de teste" }] }),
  "utf8",
);

let nextRpcId = 1;
async function mcpCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args, url) {
  const rpc = await mcpCall(url, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args, url) {
  return JSON.parse((await callTool(name, args, url)).content[0].text);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Prototype Server 326b78e4");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const terminalId = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((c) => JSON.stringify(c.find((x) => x.kind === "terminal")?.id ?? null))`,
    ),
  );
  check("terminal seed card id resolved", typeof terminalId === "string" && terminalId.length > 0, true);
  const asCard = `${MCP_BASE}?card=${encodeURIComponent(terminalId)}`;

  // O board passa a apontar pro projeto de teste (a raiz é POR BOARD: o cwd do
  // board + `/prototypes`). Setup do smoke, não o caminho sob teste.
  const moved = await page.evalJs(`
    (async () => {
      const rows = await window.store.boards.list();
      const row = rows.find((b) => b.id === ${JSON.stringify(boardId)});
      row.cwd = ${JSON.stringify(PROJ)};
      await window.store.boards.upsert(row);
      return true;
    })()
  `);
  check("board cwd aponta pro projeto de teste", moved === true, true);

  // open_prototype passa pelo mesmo gate do open_url → autônomo resolve sem clique.
  await enableAutonomousMode(page);

  // (1) A tool passiva devolve a URL LOCAL do servidor do próprio app.
  const info = await toolJson("list_prototypes", {}, asCard);
  check("list_prototypes ok", info.ok === true, true);
  check("...baseUrl é loopback http", /^http:\/\/127\.0\.0\.1:\d+$/.test(info.baseUrl ?? ""), true);
  check("...a raiz é o `prototypes/` DO BOARD", info.root, join(PROJ, "prototypes"));
  const preset = (info.presets ?? []).find((p) => p.name === "demo");
  check("...o preset DECLARADO aparece com url+exists", !!preset && preset.exists === true, true);
  check("...a url do preset aponta pro arquivo", (preset?.url ?? "").endsWith(`/p/${boardId}/index.html`), true);

  // (2) O SERVIDOR responde com charset=utf-8 (medido no fio, do lado de fora).
  const direct = await fetch(preset.url);
  const ctype = direct.headers.get("content-type");
  const body = await direct.text();
  check(`Content-Type traz charset=utf-8 (lido: ${JSON.stringify(ctype)})`, /text\/html;\s*charset=utf-8/i.test(ctype ?? ""), true);
  check("...e o corpo acentuado chega intacto", body.includes(ACCENT), true);

  // (3) Travessia de path é RECUSADA pelo servidor (nada fora da raiz).
  const escape = await fetch(`${info.baseUrl}/p/${boardId}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
  check(`travessia (..) recusada (status ${escape.status})`, [403, 404].includes(escape.status), true);

  // (4) open_prototype abre o preset num browser card REAL.
  const opened = await toolJson("open_prototype", { name: "demo", reason: "smoke" }, asCard);
  check("open_prototype ok", opened.ok === true && typeof opened.cardId === "string", true);
  check("...navegou exatamente a url do preset", opened.url, preset.url);
  await new Promise((r) => setTimeout(r, 1500));

  const pageEval = async (cardId, js) => {
    const res = await page.evalJs(`window.browser.evalJs(${JSON.stringify(cardId)}, ${JSON.stringify(js)})`);
    if (!res?.ok) return null;
    try {
      return JSON.parse(res.result);
    } catch {
      return res.result;
    }
  };

  // (5) O acento chega RENDERIZADO (charset provado pela 2ª via) e a página
  //     reage a um clique REAL.
  const text = await pageEval(opened.cardId, `document.body.innerText`);
  check(`a página renderiza o acento (lido: ${JSON.stringify((text ?? "").slice(0, 30))})`, typeof text === "string" && text.includes(ACCENT), true);

  const contentW = (await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(opened.cardId)})`))?.w ?? null;
  const scale = await pageEval(opened.cardId, `window.innerWidth`);
  const dip = contentW && scale ? contentW / scale : 1;
  const btn = await pageEval(opened.cardId, `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  if (btn) {
    for (const type of ["mouseMove", "mouseDown", "mouseUp"]) {
      await page.evalJs(
        `window.browser.sendMouse(${JSON.stringify(opened.cardId)}, { type: ${JSON.stringify(type)}, x: ${Math.round(btn.x * dip)}, y: ${Math.round(btn.y * dip)}, button: "left", clickCount: 1 })`,
      );
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const title = await pageEval(opened.cardId, `document.title`);
  check(`clique real no protótipo reage (título: ${JSON.stringify(title)})`, title, "proto-clicked");

  page.close();
} finally {
  await stopApp(app);
  rmSync(PROJ, { recursive: true, force: true });
}
finish();

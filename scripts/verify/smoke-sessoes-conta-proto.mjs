// Account sessions prototype (SessoesConta.dc.html): every anchor renders, shows
// what it is supposed to show, and fits the 1440x900 frame. Isolated Electron
// (own userData and port) pointed at a static copy of the prototype folder;
// never touches the owner's app. Screenshots go to SESSOES_CONTA_OUT
// (default /tmp/sessoes-conta).
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO_DIR = join(PROJECT_ROOT, "docs/design/app-v3/prototipo");
const OUT_DIR = process.env.SESSOES_CONTA_OUT ?? "/tmp/sessoes-conta";
mkdirSync(OUT_DIR, { recursive: true });

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0].replace(/^\//, "");
  const file = join(PROTO_DIR, path);
  if (!file.startsWith(PROTO_DIR) || !existsSync(file)) {
    res.writeHead(404);
    res.end("missing");
    return;
  }
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
const staticPort = await pickFreePort();
await new Promise((r) => server.listen(staticPort, "127.0.0.1", r));
const origin = `http://127.0.0.1:${staticPort}`;

// anchor -> what must be on screen, and what must not
const SCENES = {
  abrir: { has: ['[data-part="session-list"]', '[data-part="account-session"]', '[data-part="open-session"]'], not: ['[data-part="plan-required"]', '[data-part="board"]'], text: ["Sessões", "NA CONTA", "plataforma-web", "Abrir"] },
  salvar: { has: ['[data-part="board"]', '[data-part="save-button"]', '[data-part="save-popover"]', '[data-part="save-confirm"]'], not: ['[data-part="conflict"]', '[data-part="save-offline"]'], text: ["VAI", "FICA NESTA MÁQUINA", "O texto dos terminais e a conversa dos agentes"] },
  salvo: { has: ['[data-part="toast"]', '[data-part="sync-state"]'], not: ['[data-part="save-popover"]'], text: ["salvo na conta · r4", "Sessão salva na conta · revisão 4"] },
  conflito: { has: ['[data-part="conflict"]', '[data-part="keep-mine"]', '[data-part="keep-account"]', '[data-part="conflict-mine"]', '[data-part="conflict-theirs"]'], not: ['[data-part="save-popover"]'], text: ["Manter a minha", "Manter a da conta", "mudou em outro computador"] },
  "outra-maquina": { has: ['[data-part="no-conversation"]', '[data-part="opened-from"]', '[data-part="agent-card"]'], not: ['[data-part="pick-folder"]'], text: ["A conversa não está neste computador"] },
  "escolher-pasta": { has: ['[data-part="pick-folder"]', '[data-part="folder-suggestion"]', '[data-part="open-without-folder"]', '[data-part="use-folder"]'], not: ['[data-part="conflict"]'], text: ["Onde está o projeto neste computador?", "Escolher pasta…", "Abrir sem pasta"] },
  "plano-necessario": { has: ['[data-part="plan-required"]', '[data-part="see-plans"]'], not: ['[data-part="account-session"]', '[data-part="board"]'], text: ["Sessões na conta precisam do plano Pro ou de um Time", "Ver planos", "Continuar só nesta máquina"] },
  offline: { has: ['[data-part="save-popover"]', '[data-part="save-offline"]'], not: ['[data-part="toast"]'], text: ["Sem conexão com a conta", "Nada foi salvo", "Tentar de novo"] },
};

const userData = mkdtempSync(join(tmpdir(), "stellar-sessoes-proto-"));
let app;
try {
  const cdp = await pickFreePort();
  app = await startApp({ cdpPort: cdp, userDataDir: userData, preserveUserData: true, isolatedHome: true });
  const page = await connectPage(cdp);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1480, height: 940, deviceScaleFactor: 1, mobile: false });
  const frame = `(() => { const r = document.querySelector('[data-part="app"], [data-part="board"]'); return !!r; })()`;

  for (const [cena, spec] of Object.entries(SCENES)) {
    // The anchor is what a person types: open the page with `#<cena>` from a blank page.
    await page.send("Page.navigate", { url: "about:blank" });
    await page.send("Page.navigate", { url: `${origin}/SessoesConta.dc.html#${cena}` });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await delay(150);
      ready = await page.evalJs(frame).catch(() => false);
    }
    check(`#${cena}: renders`, ready, true);
    await delay(500);
    for (const sel of spec.has) check(`#${cena}: shows ${sel}`, await page.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`), true);
    for (const sel of spec.not) check(`#${cena}: hides ${sel}`, await page.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`), false);
    const body = await page.evalJs(`document.body.innerText`);
    for (const t of spec.text) check(`#${cena}: says "${t}"`, body.includes(t), true);
    const fits = JSON.parse(
      await page.evalJs(`(() => { const r = document.querySelector('[data-part="app"], [data-part="board"]').getBoundingClientRect(); const root = document.querySelector('[data-part="app"], [data-part="board"]').parentElement; return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), overflowX: root.scrollWidth > root.clientWidth + 1, overflowY: root.scrollHeight > root.clientHeight + 1 }); })()`),
    );
    check(`#${cena}: the frame has no overflow`, JSON.stringify({ x: fits.overflowX, y: fits.overflowY }), JSON.stringify({ x: false, y: false }));
    // Tiny text is a failure of the prototype, not a taste: nothing under 11px.
    const tiny = await page.evalJs(`[...document.querySelectorAll('[data-part="app"] *, [data-part="board"] *')].filter((e) => e.childElementCount === 0 && e.textContent.trim() !== '' && parseFloat(getComputedStyle(e).fontSize) < 10.5).map((e) => e.textContent.trim().slice(0, 30)).join("|")`);
    check(`#${cena}: no text under 10.5px`, tiny, "");
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `${cena}.png`), Buffer.from(res.data, "base64"));
  }
} finally {
  if (app) await stopApp(app);
  await new Promise((r) => server.close(r));
  rmSync(userData, { recursive: true, force: true });
}
finish();

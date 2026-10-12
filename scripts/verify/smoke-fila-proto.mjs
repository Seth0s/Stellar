// Fila prototype (Fila-v3.1.dc.html): the prototype-to-approve card and its
// three states (waiting, approved, dismissed). Isolated Electron (own userData
// and port) pointed at a static copy of the prototype folder; never touches the
// owner's app. Screenshots go to FILA_PROTO_OUT (default /tmp/fila-proto).
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO_DIR = join(PROJECT_ROOT, "docs/design/app-v3/prototipo");
const OUT_DIR = process.env.FILA_PROTO_OUT ?? "/tmp/fila-proto";
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

const CARD = '[data-part="prototype-card"]';
const SCENES = {
  prototipo: {
    has: [CARD, '[data-part="prototype-file"]', '[data-part="prototype-open"]', '[data-part="prototype-approve"]', '[data-part="prototype-dismiss"]', '[data-part="prototype-task-link"]'],
    not: ['[data-part="proto-toast"]'],
    text: ["Protótipo para aprovar", "Abrir protótipo", "Aprovar", "Dispensar", "Ver task", "prototypes/Fila-v3.1.dc.html"],
  },
  aprovado: {
    has: ['[data-part="proto-toast"]'],
    not: [CARD, '[data-part="proto-undo"]'],
    text: ["Aprovado · #a550a7ae foi avisada para seguir com a fase 2"],
  },
  dispensado: {
    has: ['[data-part="proto-toast"]', '[data-part="proto-undo"]'],
    not: [CARD],
    text: ["Dispensado · a task segue como está", "Desfazer", "2 precisam de você"],
  },
  abertas: {
    has: [CARD, '[data-part="prototype-open"]'],
    not: ['[data-part="proto-toast"]'],
    text: ["Esperando o REVISOR", "Pergunta para você"],
  },
};

const userData = mkdtempSync(join(tmpdir(), "stellar-fila-proto-"));
let app;
try {
  const cdp = await pickFreePort();
  app = await startApp({ cdpPort: cdp, userDataDir: userData, preserveUserData: true, isolatedHome: true });
  const page = await connectPage(cdp);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1020, deviceScaleFactor: 1, mobile: false });
  const frame = `!!document.querySelector('[data-cena]')`;
  const open = async (cena) => {
    await page.send("Page.navigate", { url: "about:blank" });
    await page.send("Page.navigate", { url: `${origin}/Fila-v3.1.dc.html#cena=${cena}` });
    for (let i = 0; i < 60; i++) {
      await delay(150);
      if (await page.evalJs(frame).catch(() => false)) break;
    }
    await delay(400);
  };
  const has = (sel) => page.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);

  for (const [cena, spec] of Object.entries(SCENES)) {
    await open(cena);
    for (const sel of spec.has) check(`#${cena}: shows ${sel}`, await has(sel), true);
    for (const sel of spec.not) check(`#${cena}: hides ${sel}`, await has(sel), false);
    const body = await page.evalJs(`document.body.innerText`);
    for (const t of spec.text) check(`#${cena}: says "${t}"`, body.includes(t), true);
    const need = await page.evalJs(`document.querySelector('[aria-label="Filtro"] button:nth-child(2)').innerText.replace(/\\s+/g, " ")`);
    if (cena === "prototipo") check(`#${cena}: the needs-you chip counts 3`, need, "Precisa de você 3");
    if (cena === "dispensado" || cena === "aprovado") check(`#${cena}: the needs-you chip counts 2`, need, "Precisa de você 2");
    const tiny = await page.evalJs(`[...document.querySelectorAll('[data-cena] *')].filter((e) => e.childElementCount === 0 && e.textContent.trim() !== '' && parseFloat(getComputedStyle(e).fontSize) < 10.5).map((e) => e.textContent.trim().slice(0, 30)).join("|")`);
    check(`#${cena}: no text under 10.5px`, tiny, "");
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `${cena}.png`), Buffer.from(res.data, "base64"));
  }

  // The buttons drive the same three states a person would see.
  await open("prototipo");
  await page.evalJs(`document.querySelector('[data-part="prototype-approve"]').click()`);
  await delay(300);
  check("click Aprovar: the card leaves and the toast says who was told", `${await has(CARD)}|${await has('[data-part="proto-toast"]')}`, "false|true");
  await open("prototipo");
  await page.evalJs(`document.querySelector('[data-part="prototype-dismiss"]').click()`);
  await delay(300);
  check("click Dispensar: the card leaves, Desfazer is offered", `${await has(CARD)}|${await has('[data-part="proto-undo"]')}`, "false|true");
  await page.evalJs(`document.querySelector('[data-part="proto-undo"]').click()`);
  await delay(300);
  check("click Desfazer: the card is back and the toast is gone", `${await has(CARD)}|${await has('[data-part="proto-toast"]')}`, "true|false");

  // Cards that only need a reviewer are not in the strip: they are the
  // waiting-for-reviewer tile of the review column.
  await open("abertas");
  const strip = await page.evalJs(`[...document.querySelectorAll('section[aria-label="Precisa de você"] > div')].map((d) => d.innerText.split("\\n")[0]).join("|")`);
  check("the strip heads are two questions and the prototype, never 'needs a reviewer'", strip, "Pergunta para você · há 2 h|Pergunta para você · há 2 h|Protótipo para aprovar · há 3 h");
} finally {
  if (app) await stopApp(app);
  await new Promise((r) => server.close(r));
  rmSync(userData, { recursive: true, force: true });
}
finish();

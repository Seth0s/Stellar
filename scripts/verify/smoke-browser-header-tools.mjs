// DESIGN-BACKLOG.md §2.1 Item E — verifies the 4 header additions that
// shipped now (DevTools button, viewport presets, clickable origin
// badge, console error/warning badge) each produce a REAL, observable
// effect: a real console.error/warn on the embedded page moves the real
// badge count/severity, a preset click really resizes the card's real
// stored rect, the origin badge really pans/raises the real owner card,
// and DevTools opening doesn't crash or wedge the card.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = 9533;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-header-tools", import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}
async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
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
// Drag-panning the board (same technique as smoke-card-actions.mjs) needs
// an actually-empty start point — a resized browser card (the Tablet
// preset is 768×1024) can occupy screen area a fixed coordinate assumed
// empty, and dragging that instead moves the CARD, not the board
// (confirmed live). Probes a few candidates via elementFromPoint and
// picks the first one that isn't inside a card.
async function findEmptyPoint(page) {
  const candidates = [
    { x: 1200, y: 750 },
    { x: 60, y: 750 },
    { x: 1200, y: 400 },
    { x: 60, y: 400 },
  ];
  for (const p of candidates) {
    // Not just "not a card" — must resolve to the pannable board itself
    // (`.viewport`/`.world`), not the topbar/rail chrome sitting on top of
    // it (a drag started there never reaches startPan at all).
    const isPannable = await page.evalJs(
      `(() => { const el = document.elementFromPoint(${p.x}, ${p.y}); return !!el && !el.closest('.card-frame') && !!el.closest('.viewport'); })()`,
    );
    if (isPannable) return p;
  }
  throw new Error("no empty, pannable board point found among candidates");
}

// Fires real console.error/warn on load — the badge must reflect the
// same real counts webContents.on('console-message') actually delivers.
const server = createServer((req, res) => {
  // Chromium auto-requests /favicon.ico; answering it with the same HTML
  // body as the real page triggered a genuine extra devtools console
  // warning ("Resource interpreted as..."), inflating the badge count
  // past the 3 messages the fixture actually fires on purpose — a 204
  // keeps the count deterministic.
  if (req.url === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0">
    <script>
      console.error('boom one');
      console.error('boom two');
      console.warn('careful');
    </script>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Header Tools Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  const spawnPromise = callTool("spawn_card", {
    kind: "browser",
    url: `http://127.0.0.1:${port}/`,
    callerCardId: bashCardId,
    reason: "smoke test",
  });
  // Captured independently of the badge's own React state — the ground
  // truth to compare it against — via the SAME onConsoleMessage IPC event
  // BrowserCard.tsx itself listens to.
  await page.evalJs(`
    (() => {
      window.__consoleMsgs = [];
      window.browser.onConsoleMessage((id, level, message) => {
        window.__consoleMsgs.push({ id, level, message });
      });
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_card (browser, aprovado) resolve com um cardId real", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  const cardId = spawnPayload.cardId;
  await new Promise((r) => setTimeout(r, 800));

  // --- badge de console (erro/aviso) ---
  // Expectativa derivada dos eventos REAIS recebidos pra este card, não
  // hardcoded em "3" — Electron injeta seu próprio console.warn de
  // segurança (CSP ausente) em toda sessão não empacotada, um 4º evento
  // real e esperado em dev, não um bug da feature.
  const msgsForCard = JSON.parse(await page.evalJs(`JSON.stringify(window.__consoleMsgs.filter((m) => m.id === ${JSON.stringify(cardId)}))`));
  const expectedErrors = msgsForCard.filter((m) => m.level === "error").length;
  const expectedWarnings = msgsForCard.filter((m) => m.level === "warning").length;
  check("pelo menos os 2 erros + 1 aviso reais da fixture chegaram via IPC", expectedErrors >= 2 && expectedWarnings >= 1, true);
  const badgeText = await page.evalJs(`document.querySelector('[data-role="browser-console-badge"]')?.textContent ?? null`);
  check("badge de console reflete a contagem real recebida via IPC", badgeText, String(expectedErrors + expectedWarnings));
  const badgeSeverity = await page.evalJs(`document.querySelector('[data-role="browser-console-badge"]')?.getAttribute('data-severity') ?? null`);
  check("severidade do badge é 'error' (tem >=1 erro real)", badgeSeverity, "error");

  // --- presets de viewport ---
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  async function currentBrowserRect() {
    return JSON.parse(
      await page.evalJs(`
        window.store.list(${JSON.stringify(boardId)}).then((cards) => {
          const c = cards.find((x) => x.id === ${JSON.stringify(cardId)});
          return JSON.stringify(c ? { w: c.w, h: c.h } : null);
        })
      `),
    );
  }
  async function openKebabAndClick(label) {
    const kebab = await centerOf(page, '[data-role="browser-address"] button[title="Mais opções"]');
    await page.click(kebab.x, kebab.y);
    await new Promise((r) => setTimeout(r, 250));
    const btnCoords = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('[data-role="browser-menu"] button')].find((x) => x.textContent.trim().includes(${JSON.stringify(label)}));
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    if (!btnCoords) throw new Error(`no menu button matching "${label}"`);
    await page.click(btnCoords.x, btnCoords.y);
    await new Promise((r) => setTimeout(r, 300));
  }

  await openKebabAndClick("Mobile");
  const mobileRect = await currentBrowserRect();
  check("preset Mobile aplica 390×844 no rect real do card", JSON.stringify(mobileRect), JSON.stringify({ w: 390, h: 844 }));

  await openKebabAndClick("Tablet");
  const tabletRect = await currentBrowserRect();
  check("preset Tablet aplica 768×1024 no rect real do card", JSON.stringify(tabletRect), JSON.stringify({ w: 768, h: 1024 }));

  // --- DevTools: não derruba/trava o card ---
  await page.evalJs(`window.browser.openDevTools(${JSON.stringify(cardId)})`);
  await new Promise((r) => setTimeout(r, 800));
  const queryAfterDevTools = await toolJson("get_page_text", { target: cardId });
  check("abrir DevTools não derruba o card — página ainda responde depois", queryAfterDevTools.ok, true);

  // --- badge de origem clicável (pan/raise até o card que abriu este navegador) ---
  // Por último de propósito — o card já pode estar grande (preset Tablet
  // acima), então o drag de pan usa um ponto vazio real (findEmptyPoint),
  // não uma coordenada fixa que um card redimensionado poderia cobrir.
  const emptyPoint = await findEmptyPoint(page);
  const dragTo = { x: emptyPoint.x - 900, y: emptyPoint.y };
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: emptyPoint.x, y: emptyPoint.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragTo.x, y: dragTo.y, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragTo.x, y: dragTo.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));
  const ownerNotFullyVisibleBefore = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame[data-kind="terminal"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify(r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight);
      })()
    `),
  );
  check("pan tira o card dono (terminal) de quadro completo (sanity check)", ownerNotFullyVisibleBefore, true);

  // Sob carga pesada de máquina, o próprio pointerdown do pan acima pode
  // disparar o timer de press-and-hold do menu radial (item 1, 450ms em
  // `startRadialHold`, App.tsx) antes do listener de `pointermove`
  // registrar o deslocamento real que cancelaria o timer — o gesto de
  // pan em si continua correto (o `.world` não muda), mas o backdrop do
  // menu radial cobre a tela inteira e intercepta o clique seguinte no
  // badge. Não é o alvo deste teste; descarta defensivamente via Escape
  // (App.tsx já trata Escape -> `setRadialMenu(null)`) antes de clicar.
  const radialOpenAfterPan = await page.evalJs(`!!document.querySelector('.radial-backdrop')`);
  if (radialOpenAfterPan) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await new Promise((r) => setTimeout(r, 200));
  }

  const ownerBadge = await centerOf(page, '[data-role="browser-owner"]');
  await page.click(ownerBadge.x, ownerBadge.y);
  await new Promise((r) => setTimeout(r, 500));
  const ownerFullyVisibleAfter = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame[data-kind="terminal"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify(r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1);
      })()
    `),
  );
  check("clicar o badge de origem realmente pan/foca o card dono de volta a quadro", ownerFullyVisibleAfter, true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();

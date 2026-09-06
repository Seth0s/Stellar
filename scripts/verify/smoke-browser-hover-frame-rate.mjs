// Pendentes #188 — "hover não responsivo"/"textarea não responde" no
// browser card, relatado ao vivo e confirmado pelo usuário como sendo
// dentro da PÁGINA embutida, não na UI do Stellar. Causa raiz medida ao
// vivo: `isFocused` (BrowserCard.tsx) é só "sou o card mais no topo do
// z-order" — 2 browser cards lado a lado, sem se sobrepor, o que NÃO é
// topmost pinta a só 8fps (`UNFOCUSED_FRAME_RATE`, browser-registry.ts)
// mesmo recebendo hover real e contínuo (mousemove sempre forwardado,
// sem gate de foco). Um elemento que segue o cursor na página embutida
// travava visivelmente a ~125ms por frame — exatamente o sintoma
// relatado. Fix: `hovering` (BrowserCard.tsx) bypassa o throttle
// enquanto o ponteiro está fisicamente sobre o canvas, independente do
// z-order.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-hover-frame-rate-${CDP_PORT}`, import.meta.url).pathname;

// Um marcador que segue o cursor de verdade garante um repaint real a
// cada mousemove — ao contrário de CSS puro `:hover` (só muda em
// enter/exit), isso exercita o throttle de frame rate de verdade.
const FIXTURE_HTML = `<!doctype html><html><body style="margin:0;background:#eee">
  <div id="marker" style="position:fixed;width:20px;height:20px;border-radius:50%;background:red;left:0;top:0;"></div>
  <script>
    document.addEventListener('mousemove', (e) => {
      const m = document.getElementById('marker');
      m.style.left = e.clientX + 'px';
      m.style.top = e.clientY + 'px';
    });
  </script>
</body></html>`;
const httpPort = await pickFreePort();
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Hover Frame Rate Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  async function spawnBrowser() {
    const addBtn = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector('.rail-btn[title="Adicionar card"]');
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    await page.click(addBtn.x, addBtn.y);
    await new Promise((r) => setTimeout(r, 250));
    await page.evalJs(`document.querySelector('.popover-row[data-kind="browser"]')?.click()`);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Spawna B primeiro, A depois — A fica topmost por padrão (o último da
  // ordem de criação), B é o card sob teste (nunca clicado, nunca raised).
  await spawnBrowser();
  await spawnBrowser();

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const ids = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((rows) => JSON.stringify(rows.filter((r) => r.kind === 'browser').map((r) => r.id)))
    `),
  );
  const [idB, idA] = ids;

  // Lado a lado, sem sobreposição, ambos garantidamente em tela — mesma
  // técnica de reposicionamento direto usada pelos outros smoke tests de
  // conector (evita depender de geometria de spawn/zoom implícita).
  await page.evalJs(`
    (async () => {
      const rows = await window.store.list(${JSON.stringify(boardId)});
      const rowB = rows.find((r) => r.id === ${JSON.stringify(idB)});
      const rowA = rows.find((r) => r.id === ${JSON.stringify(idA)});
      await window.store.upsert({ ...rowB, x: 100, y: 100, w: 400, h: 300 });
      await window.store.upsert({ ...rowA, x: 600, y: 100, w: 400, h: 300 });
    })()
  `);
  const homeBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.topbar-home');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(homeBtn.x, homeBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const sessionBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.home-session-name')?.closest('button');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(sessionBtn.x, sessionBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  await page.evalJs(`window.browser.navigate(${JSON.stringify(idB)}, ${JSON.stringify(fixtureUrl)})`);
  await page.evalJs(`window.browser.navigate(${JSON.stringify(idA)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 700));

  const zInfo = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-kind="browser"]')].map((f) => f.style.zIndex))
    `),
  );
  check("2 browser cards no board, z-index distintos (um topmost, outro não)", new Set(zInfo).size, 2);
  const zB = zInfo[0];

  await page.evalJs(`
    window.__frameCounts = { ${JSON.stringify(idB)}: 0, ${JSON.stringify(idA)}: 0 };
    window.__offFrame = window.browser.onFrame((id) => { if (window.__frameCounts[id] !== undefined) window.__frameCounts[id]++; });
    'ok';
  `);

  const boxB = JSON.parse(
    await page.evalJs(`
      (() => {
        const frame = [...document.querySelectorAll('[data-kind="browser"]')].find((f) => f.style.zIndex === ${JSON.stringify(zB)});
        const canvas = frame.querySelector('[data-role="browser-body"]');
        const r = canvas.getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
      })()
    `),
  );

  // Move o mouse continuamente sobre B (o card NÃO-topmost) por ~700ms
  // sem clicar (não muda z-order/raise) — só hover de verdade.
  const cx = boxB.left + boxB.width / 2;
  const cy = boxB.top + boxB.height / 2;
  const HOVER_MS = 700;
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < HOVER_MS) {
    const dx = (i % 20) * 10;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx - 100 + dx, y: cy, pointerType: "mouse" });
    i++;
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 150));

  const counts = JSON.parse(await page.evalJs(`JSON.stringify(window.__frameCounts)`));
  const fpsB = counts[idB] / (HOVER_MS / 1000);
  console.log("DEBUG frame counts (B não-topmost, A topmost parado):", counts, "fps efetivo de B:", fpsB.toFixed(1));
  check(
    "card NÃO-topmost sob hover contínuo pinta bem acima do teto throttled de 8fps (fix: hovering bypassa isFocused)",
    fpsB > 20,
    true,
  );
  check("card topmost mas parado (sem mudança visual real) não gera paint à toa", counts[idA], 0);

  await page.evalJs(`window.__offFrame?.(); 'ok';`);
  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();

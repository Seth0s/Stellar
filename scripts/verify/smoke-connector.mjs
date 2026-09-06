// The connector-drag gesture (useConnectorDrag.ts) — drag from one card's
// body to another while the connector tool is active should draw and
// persist a link between them. Not covered by the other smoke scripts.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-connector-${CDP_PORT}`, import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // DESIGN-BACKLOG.md item 8 — boots to Home now; the connector drag needs
  // an actual board (rail) to spawn sticky notes onto.
  await bootIntoFreshSession(page);

  // Rail reorg (2.2's "menu único de Ferramentas/Cards") moved card
  // creation behind an "Adicionar card" popover for every kind but
  // terminal — `spawnCard` (cdp-client.mjs) handles both shapes.
  async function spawnSticky() {
    await spawnCard(page, "sticky");
  }
  await spawnSticky();
  await spawnSticky();
  check("two sticky cards spawned", await page.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`), 2);

  // Achado ao vivo (2026-09-06, escrevendo o smoke test do menu de
  // contexto): `centeredSlot`'s anti-colisão (board-model.ts) centraliza
  // CADA card novo no viewport atual — 2 cards de 860×660 nascendo um
  // atrás do outro NÃO cabem os dois centralizados ao mesmo tempo, então
  // o ring-search do 2º empurra ele pra bem longe (o suficiente pra sair
  // da tela mesmo em zoom 100%), e o guard de "recentraliza se nasceu
  // fora de tela" (`addCardOfKind`, App.tsx) então recentraliza a câmera
  // NELE — deixando o 1º card (o que estava centralizado antes) de fora.
  // A receita antiga daqui ("zoom out 6x" + arrastar só o 2º pra um ponto
  // fixo) dependia de geometria implícita de zoom/anti-colisão que não
  // se sustenta — falhava porque o 1º card ficava fora de tela ANTES de
  // qualquer zoom, não por causa dele. Fix: reposiciona os dois direto no
  // banco (mesma técnica que os outros smoke tests já usam pra seedar
  // posição — não é o gesto de drag que está sob teste aqui, é o
  // conector), depois reabre a sessão pra `loadBoard` pegar as posições
  // novas com os dois cards garantidamente em tela.
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const stickyIds = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((rows) => JSON.stringify(rows.filter((r) => r.kind === 'sticky').map((r) => r.id)))
    `),
  );
  await page.evalJs(`
    (async () => {
      const rows = await window.store.list(${JSON.stringify(boardId)});
      const [idA, idB] = ${JSON.stringify(stickyIds)};
      const rowA = rows.find((r) => r.id === idA);
      const rowB = rows.find((r) => r.id === idB);
      await window.store.upsert({ ...rowA, x: 100, y: 100 });
      await window.store.upsert({ ...rowB, x: 900, y: 100 });
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

  const [headA, headB] = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-kind="sticky"] .card-head')].map(el => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }))
    `),
  );

  // Switch to the connector tool (keyboard shortcut "c", same as a human).
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", text: "c" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC" });
  await new Promise((r) => setTimeout(r, 200));
  check(
    "connector tool active",
    await page.evalJs(`document.querySelector('.rail-btn[title^="Conector"]')?.classList.contains("active")`),
    true,
  );

  const overlayPathsBefore = await page.evalJs(`document.querySelectorAll(".board-overlay path").length`);

  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: headA.x, y: headA.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (headA.x + headB.x) / 2, y: (headA.y + headB.y) / 2, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: headB.x, y: headB.y, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: headB.x, y: headB.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 500));

  const overlayPathsAfter = await page.evalJs(`document.querySelectorAll(".board-overlay path").length`);
  check("a new connector path was drawn", overlayPathsAfter, (n) => n > overlayPathsBefore);

  page.close();
} finally {
  await stopApp(app);
}
finish();

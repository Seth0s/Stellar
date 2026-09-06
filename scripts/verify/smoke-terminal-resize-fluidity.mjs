// Achado ao vivo ("resize dinâmico no terminal quebra e volta") —
// `fitNow()` (cols/rows reais + resize de PTY) só rodava uma vez, em
// `onResizeSettled` (soltar o mouse); durante o arraste inteiro o xterm
// ficava no raster ANTIGO enquanto a caixa ao redor já crescia/encolhia
// ao vivo — nada acompanhava, depois um reflow abrupto no soltar. Fix:
// um transform CSS ótico acompanha o arraste (barato, sem reflow), zerado
// + fit real só no settle. Verifica AO VIVO, via CDP, sem mock: durante o
// arraste o transform está aplicado E cols/rows NÃO mudaram ainda; ao
// soltar, o transform volta a vazio E cols/rows mudaram de verdade.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-resize-fluidity-${CDP_PORT}`, import.meta.url).pathname;

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Terminal Resize Fluidity Teste");
  await new Promise((r) => setTimeout(r, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  check("card de terminal real criado (seed da sessão)", typeof cardId === "string", true);

  const initialDims = await page.evalJs(`window.__getTerminalDims(${JSON.stringify(cardId)})`);
  check("dims iniciais reais lidas do xterm", initialDims && initialDims.cols > 0 && initialDims.rows > 0, true);

  // 2026-09-02: o grip visual `.card-resize` foi removido — `.card-resize-se`
  // é a zona invisível de hit-test que ocupa o mesmo canto.
  const handle = await centerOf(page, ".card-resize-se");
  check("alça de resize real encontrada", handle !== null, true);

  // Arrasta pra crescer o card — várias etapas ANTES de soltar, dando
  // tempo do rAF-throttle do CardFrame aplicar cada uma.
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  const mid = { x: handle.x + 150, y: handle.y + 100 };
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mid.x, y: mid.y, button: "left", pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 200));

  const transformDuringDrag = await page.evalJs(`document.querySelector('[data-role="terminal-body"]')?.style.transform ?? null`);
  check("transform ótico REAL aplicado durante o arraste (acompanha ao vivo)", transformDuringDrag && transformDuringDrag.includes("scale("), true);

  const dimsDuringDrag = await page.evalJs(`window.__getTerminalDims(${JSON.stringify(cardId)})`);
  check(
    "cols/rows REAIS ainda NÃO mudaram durante o arraste (só o transform ótico mexeu, sem fit()/resize de PTY caros)",
    JSON.stringify(dimsDuringDrag),
    JSON.stringify(initialDims),
  );

  const end = { x: handle.x + 260, y: handle.y + 180 };
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: end.x, y: end.y, button: "left", pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 200));
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 500));

  const transformAfterRelease = await page.evalJs(`document.querySelector('[data-role="terminal-body"]')?.style.transform ?? null`);
  check("transform ótico volta a vazio depois do settle (raster real já bate com a caixa)", transformAfterRelease, "");

  const dimsAfterRelease = await page.evalJs(`window.__getTerminalDims(${JSON.stringify(cardId)})`);
  check(
    "cols/rows REAIS mudaram de verdade no settle (fit() + resize de PTY reais aconteceram)",
    JSON.stringify(dimsAfterRelease) !== JSON.stringify(initialDims),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();

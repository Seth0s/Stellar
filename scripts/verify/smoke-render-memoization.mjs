// Pre-release audit P1 — every card component re-rendered on EVERY
// App.tsx re-render, regardless of whether anything about THAT card
// actually changed: panning the board (a `setWorld` per pointermove) or
// dragging one card (a `setCards` per pointermove) both reconciled the
// entire tree, since App.tsx passed a fresh inline closure per handler
// per card on every render — `React.memo`'s shallow prop comparison
// always sees that as "changed". Fixed with
// `useStableCardHandler`/`useStableCardIdHandler` (App.tsx) handing back
// the SAME function reference for a given card across renders, plus
// `React.memo` on all 8 card kinds. Three of the 8 (Terminal/Chat/
// Browser — the ones that receive an `id` prop and have somewhere cheap
// to put a counter) carry a direct render-count proof, exercised below.
// The other 5 (Files/Changes/Sticky/Stroke/RemoteWindow) use the
// structurally identical pattern — same `useStableCard(Id)Handler` +
// `memo()` wrap — verified instead by their own existing functional
// smoke tests passing unchanged after the wiring (no direct render-count
// proof, since they never received an `id` prop and adding one purely
// for test instrumentation was judged not worth a prop-signature change).
//
// Verifies live via a real, harmless render-count counter
// (`window.__cardRenderCounts`, incremented once per card per actual
// render — see TerminalCard.tsx/ChatCard.tsx/BrowserCard.tsx) against
// TWO real terminal cards plus one chat card and one browser card: (1)
// dragging ONE terminal card's header causes renders for exactly that
// card, while its sibling's render count stays byte-for-byte identical —
// proving the fix is per-card, not global; (2) dragging the chat card
// re-renders only the chat card, not the browser card or either terminal
// card; (3) panning the whole board (a real multi-step mouse drag on
// empty background) causes ZERO extra renders for ANY of the four cards
// — none of their own props actually changed, so memo should skip all
// of them.
//
// Trilha B (2026-09-01, docs/SCREEN_SPACE_PROJECTION_PLAN.md) changed
// the browser card's own invariant here — see CardFrame.tsx's
// `screenProjected` doc comment for the full "known perf debt, accepted"
// writeup. It's now screen-projected (portaled outside `.world`, no
// ambient CSS transform), so its on-screen position depends on real
// `panX`/`panY` PROPS that genuinely change every pan tick — `memo` is
// correctly re-rendering it, not regressing. The browser check below
// asserts "some renders happened" instead of "zero", so a REAL future
// regression (e.g. it stops tracking pan at all, or the count explodes
// far past one-per-pointermove) still fails loud instead of this file
// going permanently red and training people to ignore it. Terminal
// joined the screen-projected side too (2026-09-02) — same "bounded,
// not zero" pan invariant now applies to both terminal cards below.
//
// Achado ao vivo na mesma sessão que migrou Terminal: com um card
// screen-projected (Terminal, `.cards-layer`) sempre desenhando por
// cima de um não migrado (Chat, ainda `.world`) — limitação conhecida,
// ver `layout.css`'s `.cards-layer` comment — um terminal recém-
// arrastado (grande por padrão) sobrepondo a área onde o chat cascateia
// fazia um clique real na tag do CHAT acertar o TERMINAL por baixo em
// vez disso: um bug real de arraste desviado, não só um artefato deste
// teste. Registrado em DESIGN-BACKLOG.md; contornado aqui encolhendo e
// movendo o terminal recém-arrastado pro canto antes do chat existir,
// pra este arquivo continuar medindo só o que se propõe (contagem de
// render).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = 9452;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-render-memoization", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page);
  await new Promise((r) => setTimeout(r, 500));

  // Ctrl+D duplicates the auto-seeded bash terminal — two real terminal
  // cards, same shape as smoke-card-actions.mjs's own duplicate check.
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "d", code: "KeyD", modifiers: 2, windowsVirtualKeyCode: 68 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "d", code: "KeyD", modifiers: 2, windowsVirtualKeyCode: 68 });
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const terminalIds = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'terminal').map((c) => c.id)))
    `),
  );
  check("two real terminal cards exist after duplicating", terminalIds.length, 2);
  const [idA, idB] = terminalIds;

  await new Promise((r) => setTimeout(r, 500)); // let things settle before the baseline read

  async function renderCounts() {
    return JSON.parse(await page.evalJs(`JSON.stringify(window.__cardRenderCounts ?? {})`));
  }

  const baseline = await renderCounts();
  check("both cards have a real, positive render count already (instrumentation is live)", (baseline[idA] ?? 0) > 0 && (baseline[idB] ?? 0) > 0, true);

  // ---- Drag ONE card's header (at its fresh, un-panned position — clear
  // of any UI chrome) — its sibling must not budge ----
  // The duplicate (item 7's Ctrl+D) sits only 32px diagonally offset from
  // its source at zoom 1 — their headers can genuinely overlap on
  // screen. Click the CARD TAG specifically (not the header's bounding
  // box center, which can land on the overlapping sibling or an
  // excluded [data-no-drag] element) — same real-drag element
  // smoke-card-actions.mjs already proved works — and pick the LAST one
  // in DOM order (the duplicate, added after the original, and topmost
  // by z-order) so the click unambiguously lands on ONE specific card.
  const tagBefore = JSON.parse(
    await page.evalJs(`
      (() => {
        const tags = document.querySelectorAll('.terminal-card .card-tag');
        const tag = tags[tags.length - 1];
        const frame = tag.closest('.card-frame');
        const r = tag.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, frameLeft: f.left, frameTop: f.top });
      })()
    `),
  );
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tagBefore.x, y: tagBefore.y, button: "left", clickCount: 1, pointerType: "mouse" });
  for (const [dx, dy] of [[15, 10], [35, 25], [60, 40]]) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tagBefore.x + dx, y: tagBefore.y + dy, button: "left", pointerType: "mouse" });
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tagBefore.x + 60, y: tagBefore.y + 40, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));

  const afterDrag = await renderCounts();
  const grewA = afterDrag[idA] > baseline[idA];
  const grewB = afterDrag[idB] > baseline[idB];
  check("dragging one card's header actually re-renders exactly that card (real drag reached it)", grewA !== grewB, true);
  check(
    "...and its sibling's render count is exactly unchanged (memo skipped it, not just 'roughly the same')",
    grewA ? afterDrag[idB] : afterDrag[idA],
    grewA ? baseline[idB] : baseline[idA],
  );

  // Sanity: the drag actually moved a real card (memo didn't silently
  // break the interaction itself while stopping unrelated re-renders).
  const frameAfterDrag = JSON.parse(
    await page.evalJs(`
      (() => {
        const tags = document.querySelectorAll('.terminal-card .card-tag');
        const f = tags[tags.length - 1].closest('.card-frame').getBoundingClientRect();
        return JSON.stringify({ left: f.left, top: f.top });
      })()
    `),
  );
  check(
    "the dragged card's real on-screen position actually changed (drag still works)",
    frameAfterDrag.left !== tagBefore.frameLeft || frameAfterDrag.top !== tagBefore.frameTop,
    true,
  );

  // Achado ao vivo escrevendo este teste (Trilha B, Terminal migrado):
  // com Terminal agora em `.cards-layer`, ele desenha SEMPRE por cima de
  // cards ainda não migrados (Chat/RemoteWindow) — limitação conhecida e
  // documentada em `layout.css`'s `.cards-layer` comment, "resolve
  // sozinha quando todos os tipos migrarem". Isso deixou de ser só uma
  // ressalva teórica: os dois cards terminal (860x660 cada, enormes por
  // padrão) cobrem quase a viewport inteira, então onde quer que chat/
  // browser cascateiem por padrão, um deles está por baixo — e um clique
  // real na TAG do chat acertava o TERMINAL por baixo em vez disso, bug
  // real de produto (arraste desviado), não só artefato deste teste,
  // achado registrado em DESIGN-BACKLOG.md. Encolhe e empurra os DOIS
  // terminais pra cantos opostos aqui, fora do caminho de onde chat/
  // browser cascateiam, pra este teste continuar medindo só o que se
  // propõe (contagem de render), sem o achado colateral confundindo o
  // resultado.
  async function shrinkAndTuckInto(domIndex, handleDx, handleDy, tagDx, tagDy) {
    const before = JSON.parse(
      await page.evalJs(`
        (() => {
          const tags = document.querySelectorAll('.terminal-card .card-tag');
          const tag = tags[${domIndex}];
          const frame = tag.closest('.card-frame');
          const handle = frame.querySelector('.card-resize-se');
          const hr = handle.getBoundingClientRect();
          return JSON.stringify({ handleX: hr.x + hr.width / 2, handleY: hr.y + hr.height / 2 });
        })()
      `),
    );
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: before.handleX, y: before.handleY, button: "left", clickCount: 1, pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.handleX + handleDx, y: before.handleY + handleDy, button: "left", pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.handleX + handleDx, y: before.handleY + handleDy, button: "left", clickCount: 1, pointerType: "mouse" });
    await new Promise((r) => setTimeout(r, 300));
    const shrunk = JSON.parse(
      await page.evalJs(`
        (() => {
          const tags = document.querySelectorAll('.terminal-card .card-tag');
          const tag = tags[${domIndex}];
          const r = tag.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: shrunk.x, y: shrunk.y, button: "left", clickCount: 1, pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: shrunk.x + tagDx, y: shrunk.y + tagDy, button: "left", pointerType: "mouse" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: shrunk.x + tagDx, y: shrunk.y + tagDy, button: "left", clickCount: 1, pointerType: "mouse" });
    await new Promise((r) => setTimeout(r, 300));
  }
  // index 1 (last in DOM, the one just dragged above) -> tucked bottom-right;
  // index 0 (still at its untouched, giant default cascade slot) -> tucked
  // bottom-left. Opposite corners, both well clear of the top-left area
  // where new cards cascade in.
  await shrinkAndTuckInto(1, -600, -450, 450, 350);
  await shrinkAndTuckInto(0, -600, -450, -450, 350);
  // All four moves above are themselves real renders of the two terminal
  // cards — re-baseline both ids so the checks below measure only what
  // happens FROM HERE on, same spirit as `afterDrag` further up.
  Object.assign(afterDrag, await renderCounts());

  // ---- Add a chat card and a browser card — the other two instrumented
  // kinds (see TerminalCard.tsx/ChatCard.tsx/BrowserCard.tsx) ----
  // Rail reorg (2.2's "menu único de Ferramentas/Cards") moved card
  // creation behind an "Adicionar card" popover for every kind but
  // terminal — `spawnCard` (cdp-client.mjs) handles both shapes.
  async function clickRailButton(kind) {
    await spawnCard(page, kind);
    await new Promise((r) => setTimeout(r, 500));
  }
  // Chat card FIRST, browser card SECOND — deliberately, and dragged
  // *before* the browser card exists. `tryChangeRect` (App.tsx) rejects
  // ANY move of a non-browser card that would overlap a browser card's
  // rect (a real, intentional product rule: a native `WebContentsView`
  // always paints above every DOM card, so overlap can't be faked — see
  // its doc comment), and this app's cascade-placement puts every new
  // card almost fully overlapping the last one. Dragging the chat card
  // while a browser card is already on screen would hit that rule and
  // silently no-op the whole drag, which would look identical to a
  // memoization bug but isn't one — so the browser card is added only
  // after this drag is done.
  await clickRailButton("chat");
  await new Promise((r) => setTimeout(r, 500));

  const cardsAfterChat = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards))
    `),
  );
  const chatId = cardsAfterChat.find((c) => c.kind === "chat").id;
  check("a real chat card now exists", typeof chatId === "string", true);

  const baseline2 = await renderCounts();
  check("the chat card has a real, positive render count already", (baseline2[chatId] ?? 0) > 0, true);

  // ---- Drag the chat card's tag — only the chat card should re-render ----
  const chatTag = JSON.parse(
    await page.evalJs(`
      (() => {
        const tag = document.querySelector('.chat-card .card-tag');
        const r = tag.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: chatTag.x, y: chatTag.y, button: "left", clickCount: 1, pointerType: "mouse" });
  for (const [dx, dy] of [[15, 10], [35, 25], [60, 40]]) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chatTag.x + dx, y: chatTag.y + dy, button: "left", pointerType: "mouse" });
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: chatTag.x + 60, y: chatTag.y + 40, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));

  const afterChatDrag = await renderCounts();
  check("dragging the chat card re-renders the chat card", afterChatDrag[chatId] > baseline2[chatId], true);
  check("...and does NOT re-render terminal card A", afterChatDrag[idA], afterDrag[idA]);
  check("...and does NOT re-render terminal card B", afterChatDrag[idB], afterDrag[idB]);

  // ---- Now add the browser card, after the chat drag is done ----
  await clickRailButton("browser");
  await new Promise((r) => setTimeout(r, 500));
  const cardsNow = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards))
    `),
  );
  const browserId = cardsNow.find((c) => c.kind === "browser").id;
  check("a real browser card now exists", typeof browserId === "string", true);
  const afterBrowserCreate = await renderCounts();
  check("the browser card has a real, positive render count already", (afterBrowserCreate[browserId] ?? 0) > 0, true);
  check(
    "creating the browser card did not re-render the chat, or either terminal, card",
    afterBrowserCreate[chatId] === afterChatDrag[chatId] &&
      afterBrowserCreate[idA] === afterChatDrag[idA] &&
      afterBrowserCreate[idB] === afterChatDrag[idB],
    true,
  );

  // ---- Pan the whole board: a real multi-step drag on empty background ----
  const emptySpot = JSON.parse(
    await page.evalJs(`
      (() => {
        const vp = document.querySelector('.viewport');
        const r = vp.getBoundingClientRect();
        return JSON.stringify({ x: r.right - 40, y: r.bottom - 40 });
      })()
    `),
  );
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: emptySpot.x, y: emptySpot.y, button: "left", clickCount: 1, pointerType: "mouse" });
  for (const [dx, dy] of [[-20, -10], [-45, -25], [-70, -40], [-100, -60]]) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: emptySpot.x + dx, y: emptySpot.y + dy, button: "left", pointerType: "mouse" });
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: emptySpot.x - 100, y: emptySpot.y - 60, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));

  const afterPan = await renderCounts();
  // Screen-projected (Trilha B) — see the file-header comment above.
  // Panning genuinely re-renders it now (real panX/panY props), so this
  // checks "renders happened, roughly once per pan step" instead of
  // "zero" — a runaway count (way more than the ~4 mousemoves the pan
  // gesture above sends) would still fail loud. Terminal joined the
  // screen-projected side in the very same commit as this comment
  // (2026-09-02) — same invariant, same reasoning, now for both A and B.
  const terminalAPanRenders = afterPan[idA] - afterBrowserCreate[idA];
  check(
    `panning the board re-renders terminal card A a bounded number of times (screen-projected, got ${terminalAPanRenders})`,
    terminalAPanRenders > 0 && terminalAPanRenders <= 20,
    true,
  );
  const terminalBPanRenders = afterPan[idB] - afterBrowserCreate[idB];
  check(
    `panning the board re-renders terminal card B a bounded number of times (screen-projected, got ${terminalBPanRenders})`,
    terminalBPanRenders > 0 && terminalBPanRenders <= 20,
    true,
  );
  check("panning the board causes ZERO extra renders for the chat card", afterPan[chatId], afterChatDrag[chatId]);
  const browserPanRenders = afterPan[browserId] - afterBrowserCreate[browserId];
  check(
    `panning the board re-renders the browser card a bounded number of times (screen-projected, got ${browserPanRenders})`,
    browserPanRenders > 0 && browserPanRenders <= 20,
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();

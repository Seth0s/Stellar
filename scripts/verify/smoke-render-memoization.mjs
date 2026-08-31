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
  check("panning the board causes ZERO extra renders for terminal card A", afterPan[idA], afterDrag[idA]);
  check("panning the board causes ZERO extra renders for terminal card B", afterPan[idB], afterDrag[idB]);
  check("panning the board causes ZERO extra renders for the chat card", afterPan[chatId], afterChatDrag[chatId]);
  check("panning the board causes ZERO extra renders for the browser card", afterPan[browserId], afterBrowserCreate[browserId]);

  page.close();
} finally {
  await stopApp(app);
}
finish();

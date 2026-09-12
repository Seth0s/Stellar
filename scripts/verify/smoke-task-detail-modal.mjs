// Fila card — hover on a task row, click opens the detail modal, append
// via window.tasks.updatePrompt (default), parseTaskPrompt splits original
// vs dated additions, creator + divergence surfaces are in the dialog.
// Isolated Electron (never the user's live session). No .thin-scroll.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-task-detail-modal-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res) throw new Error(`element not found: ${selector}`);
  return res;
}

async function waitFor(page, expr, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evalJs(`!!(${expr})`)) return true;
    await delay(80);
  }
  return false;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Fila Modal", { spawnTerminal: false });
  await delay(400);

  await spawnCard(page, "task");
  check(
    "card Fila monta com o formulário de criar",
    await waitFor(page, `document.querySelector('[data-part="create-task-input"]')`, 8000),
    true,
  );

  const created = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === "Fila Modal") ?? boards[0];
        if (!board) return JSON.stringify({ ok: false, error: "no board" });
        return JSON.stringify(await window.tasks.create(board.id, "enunciado original da task de verificação"));
      })()
    `),
  );
  check("window.tasks.create gravou a task", created.ok, true);
  check("task aparece na coluna", await waitFor(page, `document.querySelector("[data-task-item-id]")`, 8000), true);

  const itemPt = await centerOf(page, "[data-task-item-id]");
  const restBorder = await page.evalJs(`getComputedStyle(document.querySelector("[data-task-item-id]")).borderTopColor`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: itemPt.x, y: itemPt.y, pointerType: "mouse" });
  await delay(120);
  const hoverBorder = await page.evalJs(`getComputedStyle(document.querySelector("[data-task-item-id]")).borderTopColor`);
  check("hover muda a borda do item", hoverBorder !== restBorder, true);

  await page.click(itemPt.x, itemPt.y);
  check("click abre o modal de detalhe", await waitFor(page, `document.querySelector('[data-part="task-detail-modal"]')`), true);

  const chrome = JSON.parse(
    await page.evalJs(`
      (() => {
        const modal = document.querySelector('[data-part="task-detail-modal"] [role="dialog"]');
        const original = document.querySelector('[data-part="task-detail-prompt-original"]')?.textContent ?? "";
        const creator = document.querySelector('[data-part="task-detail-creator"]')?.textContent ?? "";
        return JSON.stringify({
          role: modal?.getAttribute("role"),
          ariaModal: modal?.getAttribute("aria-modal"),
          original,
          creator,
          append: !!document.querySelector('[data-part="task-detail-append"]'),
          replace: !!document.querySelector('[data-part="task-detail-replace"]'),
          thinScroll: document.querySelectorAll(".thin-scroll").length,
        });
      })()
    `),
  );
  check("dialog semantics", chrome.role, "dialog");
  check("aria-modal", chrome.ariaModal, "true");
  check("enunciado original visível", chrome.original.includes("enunciado original da task de verificação"), true);
  check("sinaliza quem criou (humano da UI)", chrome.creator.includes("você"), true);
  check("botão acrescentar (append default)", chrome.append, true);
  check("botão substituir explícito", chrome.replace, true);
  check("zero .thin-scroll", chrome.thinScroll, 0);

  const draft = await centerOf(page, '[data-part="task-detail-prompt-draft"]');
  await page.click(draft.x, draft.y);
  await page.send("Input.insertText", { text: "acréscimo posterior via modal" });
  check(
    "acrescentar habilita com texto",
    await waitFor(page, `!document.querySelector('[data-part="task-detail-append"]')?.disabled`, 3000),
    true,
  );
  const appendBtn = await centerOf(page, '[data-part="task-detail-append"]');
  await page.click(appendBtn.x, appendBtn.y);
  check(
    "acréscimo aparece separado do original",
    await waitFor(page, `document.querySelector('[data-part="task-detail-prompt-added"]')?.textContent.includes("acréscimo posterior via modal")`),
    true,
  );
  const afterAppend = JSON.parse(
    await page.evalJs(`
      (() => {
        const original = document.querySelector('[data-part="task-detail-prompt-original"]')?.textContent ?? "";
        const added = document.querySelector('[data-part="task-detail-prompt-added"]')?.textContent ?? "";
        return JSON.stringify({ original, added });
      })()
    `),
  );
  check("original permanece depois do append", afterAppend.original.includes("enunciado original da task de verificação"), true);
  check("acréscimo não mistura o marker cru no original", afterAppend.original.includes("[stellar:added"), false);

  await page.evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  // useModal listens on window capture — send a real key event via CDP
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check(
    "Escape fecha o modal",
    await waitFor(page, `!document.querySelector('[data-part="task-detail-modal"]')`, 3000),
    true,
  );
} finally {
  await stopApp(app);
}
finish();

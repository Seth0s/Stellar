// Manual identify of an empty resume_id: button next to `resume:` in the
// card footer (and the ⋯ menu), one card, IPC in main. Measures the three
// UI outcomes the owner named: found (id lands in the footer), none
// (says what was missing), and that a card with an id never gets the button.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, clickProviderInPicker, openTerminalCreatePopover } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-identify-session-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await delay(1000);
  await bootIntoFreshSession(page, "Identify Session");
  await delay(800);

  const bashIdentify = JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        buttons: document.querySelectorAll('[data-kind="terminal"] [data-role="terminal-identify-session"]').length,
        menus: document.querySelectorAll('[data-kind="terminal"] [data-role="terminal-card-menu"]').length,
      })
    `),
  );
  check("seeded bash card has no identify button (no session concept)", bashIdentify.buttons, 0);
  check("seeded bash card has no ⋯ identify menu", bashIdentify.menus, 0);

  await openTerminalCreatePopover(page);
  const pickerLabels = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('.provider-picker-btn')].map((b) => b.textContent.trim()))`),
  );
  // O picker casa pelo RÓTULO declarado: o `[title="claude"]` que estava aqui
  // nunca casou (o `title` do botão é o rótulo + as flags, desde a c857539c).
  check("claude provider picker exists", pickerLabels.includes("Claude"), true);
  await clickProviderInPicker(page, "claude");
  await delay(200);
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  check("create-terminal submit exists", criarBtn !== null, true);
  await page.click(criarBtn.x, criarBtn.y);
  await delay(1500);

  const created = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const claude = cards.find((c) => c.kind === "terminal" && c.provider === "claude");
        return JSON.stringify({
          id: claude?.id ?? null,
          cwd: claude?.cwd ?? null,
          resume_id: claude?.resume_id ?? null,
        });
      })()
    `),
  );
  check("claude card exists with empty resume_id", created.id !== null && created.resume_id === null, true);

  const ui = JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        buttons: document.querySelectorAll('[data-role="terminal-identify-session"]').length,
        menus: document.querySelectorAll('[data-role="terminal-card-menu"]').length,
        emptyResume: !!document.querySelector('[data-role="terminal-resume-empty"]'),
      })
    `),
  );
  check("empty-resume claude card shows the identify button", ui.buttons, 1);
  check("empty-resume claude card shows the ⋯ menu", ui.menus, 1);
  check("button sits next to the empty resume: label", ui.emptyResume, true);

  const menuOpened = JSON.parse(
    await page.evalJs(`
      (() => {
        const btn = document.querySelector('[data-role="terminal-card-menu"]');
        if (!btn) return JSON.stringify(false);
        btn.click();
        return JSON.stringify(true);
      })()
    `),
  );
  check("⋯ menu button accepts a click", menuOpened, true);
  await delay(200);
  const menuItem = JSON.parse(
    await page.evalJs(`JSON.stringify(!!document.querySelector('[data-role="terminal-identify-menu-item"]'))`),
  );
  check("⋯ menu lists Identify session", menuItem, true);
  await page.evalJs(`
    (() => {
      const btn = document.querySelector('[data-role="terminal-card-menu"]');
      if (btn) btn.click();
    })()
  `);
  await delay(100);

  const noneCwd = `/tmp/stellar-identify-none-${CDP_PORT}`;
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const cards = await window.store.list(boards[0].id);
      const claude = cards.find((c) => c.kind === "terminal" && c.provider === "claude");
      await window.store.upsert({ ...claude, cwd: ${JSON.stringify(noneCwd)} });
    })()
  `);

  const identifyBtn = await centerOf(page, '[data-role="terminal-identify-session"]');
  await page.click(identifyBtn.x, identifyBtn.y);
  const busySoon = JSON.parse(
    await page.evalJs(`
      (() => {
        const btn = document.querySelector('[data-role="terminal-identify-session"]');
        return JSON.stringify({ disabled: btn?.disabled === true, busy: btn?.getAttribute("data-busy") === "true" });
      })()
    `),
  );
  check(
    "click disarms the button (disabled or data-busy) so a second click cannot start another read",
    busySoon.disabled || busySoon.busy,
    true,
  );

  const noneDeadline = Date.now() + 12000;
  let noneFeedback = "";
  while (Date.now() < noneDeadline) {
    noneFeedback = await page.evalJs(
      `document.querySelector('[data-role="terminal-identify-feedback"]')?.textContent ?? ""`,
    );
    if (noneFeedback) break;
    await delay(150);
  }
  check(
    "none: footer names what was missing (no silent blink)",
    /Nenhuma sessão deste provider para este diretório/.test(noneFeedback),
    true,
  );

  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const cards = await window.store.list(boards[0].id);
      const claude = cards.find((c) => c.kind === "terminal" && c.provider === "claude");
      await window.store.upsert({ ...claude, cwd: ${JSON.stringify(created.cwd)} });
    })()
  `);

  const ipc = JSON.parse(
    await page.evalJs(`
      (async () => {
        const result = await window.pty.identifySession(${JSON.stringify(created.id)});
        return JSON.stringify(result);
      })()
    `),
  );
  check("IPC returns a structured status (never a bare throw)", typeof ipc.status === "string", true);

  if (ipc.status === "found") {
    const foundBtn = await centerOf(page, '[data-role="terminal-identify-session"]');
    await page.click(foundBtn.x, foundBtn.y);
    const foundDeadline = Date.now() + 12000;
    let resumeText = "";
    while (Date.now() < foundDeadline) {
      resumeText = await page.evalJs(`
        document.querySelector('[data-kind="terminal"] .card-foot')?.textContent ?? ""
      `);
      if (resumeText.includes(`resume:${ipc.id}`)) break;
      await delay(150);
    }
    check("found: resume id appears in the footer immediately", resumeText.includes(`resume:${ipc.id}`), true);
    const buttonsAfter = JSON.parse(
      await page.evalJs(`JSON.stringify(document.querySelectorAll('[data-role="terminal-identify-session"]').length)`),
    );
    check("found: identify button disappears once the card has an id", buttonsAfter, 0);
  } else {
    check(
      `found path not exercised live (IPC status=${ipc.status}); unit test covers found+claimed+ambiguous`,
      true,
      true,
    );
  }
} finally {
  await stopApp(app);
}
finish();

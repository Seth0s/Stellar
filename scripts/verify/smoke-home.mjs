// DESIGN-BACKLOG.md item 8 — the app boots to a Home screen (sessions
// grouped by project) instead of straight into a board, with a Topbar
// button to come back to it. Covers: empty state, create-from-Home,
// project grouping, opening a session, and the home button round-trip.
import { startApp, stopApp, connectPage, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = 9410;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-home", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));

  async function clickByText(selector, text) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}));
          if (!el) return JSON.stringify(null);
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!coords) throw new Error(`element matching ${selector} / "${text}" not found`);
    await page.click(coords.x, coords.y);
  }

  async function clickSelector(sel) {
    const pt = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector(${JSON.stringify(sel)});
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!pt) throw new Error(`element not found: ${sel}`);
    await page.click(pt.x, pt.y);
  }

  function fillName(value) {
    return page.evalJs(`
      (() => {
        const inp = document.querySelector('.modal input.resume-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(value)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
  }

  // ProjectPicker (shared with Topbar) renders either a <select> (real
  // sibling dirs found) or a free-text <input> (customMode) — handle both
  // rather than assume which one this machine's workspace produces.
  async function setProject(value) {
    const tag = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.querySelector('.modal .project-picker select, .modal select.resume-input');
          return JSON.stringify(el ? el.tagName : null);
        })()
      `),
    );
    if (tag === "SELECT") {
      await page.evalJs(`
        (() => {
          const sel = document.querySelector('.modal select.resume-input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, '__custom__');
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `);
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.evalJs(`
      (() => {
        const inp = document.querySelector('.modal .project-picker input.resume-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(value)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
  }

  // 1. Boots to Home, empty state (fresh profile, no boards yet).
  check("boots to Home, not a board canvas", await page.evalJs(`!!document.querySelector('.home')`), true);
  check("no topbar until a session exists", await page.evalJs(`!document.querySelector('.topbar')`), true);
  check("empty state shown", await page.evalJs(`!!document.querySelector('.home-empty')`), true);

  // 2. Create the first session from Home's empty state.
  await clickSelector(".home-empty button.primary");
  await new Promise((r) => setTimeout(r, 300));
  check("create modal opens from Home's empty state", await page.evalJs(`!!document.querySelector('.modal-root')`), true);
  await fillName("Alpha");
  await setProject("projeto-um");
  await clickByText(".modal-actions button", "Criar");
  await new Promise((r) => setTimeout(r, 800));
  check("creating a session leaves Home for the board", await page.evalJs(`!document.querySelector('.home')`), true);
  check("topbar shows the new session", await page.evalJs(`document.querySelector('.topbar-title strong')?.textContent`), "Alpha");

  // 3. Home button returns to Home.
  await clickSelector(".topbar-home");
  await new Promise((r) => setTimeout(r, 300));
  check("home button returns to Home", await page.evalJs(`!!document.querySelector('.home')`), true);
  check("topbar unmounts back on Home", await page.evalJs(`!document.querySelector('.topbar')`), true);
  check(
    "the session created moments ago now shows on Home's grid (not the empty state)",
    await page.evalJs(`!document.querySelector('.home-empty') && document.querySelectorAll('.home-session-card').length`),
    1,
  );

  // 4. Create a second session in a different project — grouping check —
  // via Home's own "+ nova sessão" CTA (header button, not the empty state).
  await clickSelector(".home-header button.primary");
  await new Promise((r) => setTimeout(r, 300));
  await fillName("Beta");
  await setProject("projeto-dois");
  await clickByText(".modal-actions button", "Criar");
  await new Promise((r) => setTimeout(r, 800));

  await clickSelector(".topbar-home");
  await new Promise((r) => setTimeout(r, 300));
  const groups = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('.home-group-label')].map((e) => e.textContent))`),
  );
  check("Home groups sessions by project (2 groups)", groups.length, 2);
  check(
    "Home lists both created sessions",
    await page.evalJs(`document.querySelectorAll('.home-session-card').length`),
    2,
  );

  // DESIGN-BACKLOG.md item 14 — created/last-accessed dates + "recente"
  // badge on whichever session was opened most recently (Beta, created
  // — and so accessed — after Alpha).
  check(
    "every session card shows created + last-accessed dates",
    await page.evalJs(`document.querySelectorAll('.home-session-dates').length`),
    2,
  );
  check(
    "the most recently opened session (Beta) carries the 'recente' badge",
    await page.evalJs(
      `[...document.querySelectorAll('.home-session-card')].find((c) => c.querySelector('.home-session-recent'))?.querySelector('.home-session-name')?.textContent`,
    ),
    "Beta",
  );

  // 5. Clicking a session card on Home opens it.
  await clickByText(".home-session-name", "Alpha");
  await new Promise((r) => setTimeout(r, 800));
  check("clicking a Home session card opens that board", await page.evalJs(`document.querySelector('.topbar-title strong')?.textContent`), "Alpha");

  // 6. Edit via SessionModal from Home (pencil on a card).
  await clickSelector(".topbar-home");
  await new Promise((r) => setTimeout(r, 300));
  await clickSelector(".home-session-edit");
  await new Promise((r) => setTimeout(r, 300));
  check("edit modal opens from a Home card's pencil", await page.evalJs(`!!document.querySelector('.modal-root')`), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

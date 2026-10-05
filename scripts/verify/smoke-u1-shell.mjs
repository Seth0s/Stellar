// U1 — the new shell (telas 1-9). Boots an isolated instance, walks the new
// home surface (first run, sessions, profiles, work home, login), asserts the
// real DOM, and writes side-by-side screenshots (1440x900) of each screen and
// its approved prototype into docs/design/app-v2/comparacao/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPageRaw, assertAppDocument, pickFreePort, makeChecker } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO_DIR = join(PROJECT_ROOT, "docs/design/app-v2/prototipo");
const OUT_DIR = join(PROJECT_ROOT, "docs/design/app-v2/comparacao");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-u1-${CDP_PORT}`, import.meta.url).pathname;

const { check, skip, finish } = makeChecker();
mkdirSync(OUT_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPageRaw(CDP_PORT);
  await assertAppDocument(page.evalJs);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  async function shot(name) {
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(res.data, "base64"));
    return join(OUT_DIR, `${name}.png`);
  }

  async function waitFor(expr, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await page.evalJs(expr)) return true;
      await delay(150);
    }
    return false;
  }

  function click(evalExpr) {
    return page.evalJs(`(() => { const el = ${evalExpr}; if (!el) return false; el.click(); return true; })()`);
  }

  // 1. Cold start + first run.
  const booted = await waitFor(`!!(!document.querySelector('[data-boot]') && (document.querySelector('[data-role="firstrun-local"]') || document.querySelector('[data-section]')))`);
  check("cold start gives way to the shell or the first-run screen", booted, true);
  const firstRun = await page.evalJs(`!!document.querySelector('[data-role="firstrun-local"]')`);
  if (firstRun) {
    await shot("app-tela2-firstrun");
    await click(`document.querySelector('[data-role="firstrun-local"]')`);
    await waitFor(`!!document.querySelector('[data-section]')`);
  } else {
    skip("first-run screen", "profile already decided (the isolated profile was reused)");
  }
  check("shell sidebar renders", await page.evalJs(`!!document.querySelector('[data-section="sessions"]')`), true);

  // 2. Tela 4 — empty sessions.
  check("empty sessions state", await page.evalJs(`!!document.querySelector('.home-empty')`), true);
  await shot("app-tela4-home-empty");

  // 3. Create a session → tela 3 (sessions with a card).
  await click(`document.querySelector('.home-empty button.primary')`);
  await waitFor(`!!document.querySelector('.modal input.resume-input')`);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.modal input.resume-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'U1 Shell');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await click(`document.querySelector('.modal-actions button.primary')`);
  await waitFor(`!!document.querySelector('.topbar-title')`);
  // Seed a few agent cards directly in the store while the board is open
  // (they are not in the board's React state, so no PTY is spawned). Going
  // back to Home then refreshes the counts and the provider mix, so the
  // screenshot shows the real chips and dots the aggregate produces.
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const b = boards[0];
      const mk = (id, provider) => ({ id, board_id: b.id, kind: "terminal", provider, cwd: b.cwd, x: 0, y: 0, w: 600, h: 400, resume_id: null, model: null, effort: null, system_prompt: null, group_id: null, label: null, updated_at: Date.now(), messages_json: null, archived_at: null });
      await window.store.upsert(mk("u1-a", "claude"));
      await window.store.upsert(mk("u1-b", "commandcode"));
      await window.store.upsert(mk("u1-c", "commandcode"));
      await window.store.upsert(mk("u1-d", "antigravity"));
    })()
  `);
  await click(`document.querySelector('.topbar-home')`);
  await waitFor(`!!document.querySelector('.home')`);
  await page.evalJs(`window.dispatchEvent(new Event("focus"))`);
  await delay(300);
  const cards = await page.evalJs(`document.querySelectorAll('.home-session-card').length`);
  check("a created session shows on the sessions grid", cards, 1);
  await shot("app-tela3-sessions");

  // 4. Tela 8 — profile menu.
  await click(`document.querySelector('[data-role="profile-trigger"]')`);
  await delay(200);
  check("profile menu opens", await page.evalJs(`!!document.querySelector('[aria-label] [role="menuitemradio"], [role="menuitemradio"]')`), true);
  await shot("app-tela8-profiles");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(150);

  // 5. Tela 9 — work home page.
  await click(`document.querySelector('[data-section="workhome"]')`);
  await delay(250);
  check("work home section renders", await page.evalJs(`document.body.innerText.includes('Casa de trabalho') || document.body.innerText.includes('Work home')`), true);
  await shot("app-tela9-workhome");

  // 6. Tela 5 — the internal login screen (choose step).
  await click(`document.querySelector('[data-section="sessions"]')`);
  await delay(150);
  await click(`document.querySelector('[data-role="sign-in"]') ?? document.querySelector('[data-role="firstrun-account"]')`);
  await delay(250);
  const loginUp = await page.evalJs(`document.body.innerText.includes('GitHub')`);
  check("login screen opens", loginUp, true);
  await shot("app-tela5-login");

  // 7. Prototype side — render each approved screen at the same viewport by
  //    navigating the page to the prototype HTML (static markup renders as-is).
  const prototypes = [
    "Main",
    "FirstRun",
    "Home",
    "HomeEmpty",
    "Login",
    "LoginWaiting",
    "Invite",
    "Profiles",
    "WorkHome",
  ];
  for (const name of prototypes) {
    const html = readFileSync(join(PROTO_DIR, `${name}.dc.html`), "utf8");
    await page.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await delay(500);
    await shot(`proto-${name}`);
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();

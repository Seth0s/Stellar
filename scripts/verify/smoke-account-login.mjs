// Email sign-in against a mocked API: unreachable, 503, 202 and the GitHub
// copy-link affordance. Isolated userData + CDP only; the API is a local fake
// and no e-mail is ever sent. Prints under /tmp/account-fix/.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker, pickFreePort, startApp, stopApp, connectPageRaw } from "./cdp-client.mjs";

const OUT_DIR = "/tmp/account-fix";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function startFakeApi(port) {
  const seen = { emailPosts: 0 };
  const api = { mode: "202", seen };
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    req.on("data", () => {});
    req.on("end", () => {
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && path === "/v1/auth/email") {
        seen.emailPosts++;
        if (api.mode === "503") return json(503, { error: { code: "email_unavailable", message: "mail provider down" } });
        return json(202, { status: "sent" });
      }
      json(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  api.listen = () => new Promise((r) => server.listen(port, "127.0.0.1", r));
  api.close = () => server.close();
  return api;
}

async function withApp({ apiBase, body, env = { STELLARCLOUD_AUTH_BROWSER: "log" }, extraArgs = [] }) {
  const userData = mkdtempSync(join(tmpdir(), "stellar-account-login-"));
  const cdpPort = await pickFreePort();
  const app = await startApp({
    cdpPort,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: true,
    extraArgs,
    extraEnv: { ...env, STELLARCLOUD_API_URL: apiBase },
  });
  try {
    const page = await connectPageRaw(cdpPort);
    await body(page, app);
    page.close();
  } finally {
    await stopApp(app);
    rmSync(userData, { recursive: true, force: true });
  }
}


async function waitFor(page, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evalJs(expr)) return true;
    await delay(150);
  }
  return false;
}

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(res.data, "base64"));
}

async function openLogin(page) {
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(page, `!!document.querySelector('[data-role="firstrun-account"]')`, 30000);
  await page.evalJs(`document.querySelector('[data-role="firstrun-account"]').click()`);
  check("login screen opens", await waitFor(page, `!!document.querySelector('[data-login-choose]')`), true);
}

async function typeEmail(page, value) {
  await page.evalJs(`(() => {
    const el = document.getElementById('lg-email');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

const state = (page) =>
  page.evalJs(`(() => ({
    choose: !!document.querySelector('[data-login-choose]'),
    waiting: !!document.querySelector('[data-login-waiting]'),
    step: document.querySelector('[data-login-waiting]')?.getAttribute('data-step') ?? null,
    error: document.querySelector('[data-role="login-error"]')?.textContent ?? null,
    sendLabel: document.querySelector('[data-role="send-link"]')?.textContent ?? null,
    emailValue: document.getElementById('lg-email')?.value ?? null,
    mailIcon: !!document.querySelector('[data-role="login-mail-icon"]'),
    githubIcon: !!document.querySelector('[class*="stepIconGithub"]'),
    waitingText: document.querySelector('[data-login-waiting]')?.textContent ?? '',
  }))()`);

/** A PATH with only what the harness needs to launch (prlimit, node) — no xdg-open. */
function noBrowserPath() {
  const dir = mkdtempSync(join(tmpdir(), "stellar-nobrowser-bin-"));
  for (const tool of ["prlimit", "node"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(dir, tool));
  }
  return dir;
}

const apiPort = await pickFreePort();
const api = startFakeApi(apiPort);
await api.listen();
const apiBase = `http://127.0.0.1:${apiPort}`;
const deadBase = `http://127.0.0.1:${await pickFreePort()}`; // nothing listens here

try {
  // ---- API unreachable ----
  await withApp({
    apiBase: deadBase,
    body: async (page) => {
      await openLogin(page);
      await typeEmail(page, "someone@example.com");
      await page.evalJs(`document.querySelector('[data-role="send-link"]').click()`);
      check("unreachable: error shown", await waitFor(page, `!!document.querySelector('[data-role="login-error"]')`), true);
      const st = await state(page);
      check("unreachable: stays on the form (no 'link sent' step)", st.choose && !st.waiting, true);
      check("unreachable: network message", /servidor|server/i.test(st.error ?? ""), true);
      check("unreachable: button offers retry", /tentar de novo|try again/i.test(st.sendLabel ?? ""), true);
      check("unreachable: typed e-mail kept", st.emailValue, "someone@example.com");
      await shot(page, "email-unreachable");
    },
  });

  // ---- 503, then retry with 202 ----
  await withApp({
    apiBase,
    body: async (page) => {
      await openLogin(page);
      api.mode = "503";
      api.seen.emailPosts = 0;
      await typeEmail(page, "someone@example.com");
      await page.evalJs(`document.querySelector('[data-role="send-link"]').click()`);
      check("503: error shown", await waitFor(page, `!!document.querySelector('[data-role="login-error"]')`), true);
      let st = await state(page);
      check("503: request reached the API exactly once", api.seen.emailPosts, 1);
      check("503: unavailable message (not 'sent')", /indispon|unavailable/i.test(st.error ?? ""), true);
      check("503: still on the form", st.choose && !st.waiting, true);
      await shot(page, "email-503");

      api.mode = "202";
      await page.evalJs(`document.querySelector('[data-role="send-link"]').click()`);
      check("202: waiting step appears", await waitFor(page, `!!document.querySelector('[data-login-waiting]')`), true);
      st = await state(page);
      check("202: API got the second request", api.seen.emailPosts, 2);
      check("202: step 2 (authorize), not the browser step", st.step, "1");
      check("202: mail icon, no GitHub icon", st.mailIcon && !st.githubIcon, true);
      check("202: no 'open the browser' wording", /navegador|browser/i.test(st.waitingText), false);
      check("202: names the address the link went to", st.waitingText.includes("someone@example.com"), true);
      await shot(page, "email-202-waiting");

      await page.evalJs(`[...document.querySelectorAll('[data-login-waiting] button')].find((b) => /voltar|back/i.test(b.textContent || ''))?.click()`);
      check("back returns to the form", await waitFor(page, `!!document.querySelector('[data-login-choose]')`), true);
      st = await state(page);
      check("back: typed e-mail kept", st.emailValue, "someone@example.com");
      const status = await page.evalJs(`window.cloud.status().then((s) => s.state)`);
      check("back: pending login cancelled", status, "logged-out");
    },
  });

  // ---- GitHub: the link is offered to copy ----
  await withApp({
    apiBase,
    body: async (page) => {
      await openLogin(page);
      await page.evalJs(`[...document.querySelectorAll('button')].find((b) => /GitHub/i.test(b.textContent || ''))?.click()`);
      check("github: browser step shown", await waitFor(page, `document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '0'`), true);
      check("github: copy-link button present", await waitFor(page, `!!document.querySelector('[data-role="login-link-copy"]')`), true);
      await shot(page, "github-copy-link");
    },
  });

  // ---- GitHub: the OS has no browser handler ----
  // Measured: with xdg-open missing, Electron's shell.openExternal still RESOLVES
  // (Chromium logs "failed to execvp" and the promise does not reject), so the
  // app cannot know the tab never opened. The Copy-link button on the browser
  // step is therefore the way out, and it must be there without any failure signal.
  await withApp({
    apiBase,
    env: { PATH: noBrowserPath(), DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" },
    body: async (page, app) => {
      await openLogin(page);
      await page.evalJs(`[...document.querySelectorAll('button')].find((b) => /GitHub/i.test(b.textContent || ''))?.click()`);
      check("no browser handler: browser step shown", await waitFor(page, `document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '0'`), true);
      check("no browser handler: Copy link offered", await waitFor(page, `!!document.querySelector('[data-role="login-link-copy"]')`), true);
      await delay(3000);
      check("no browser handler: Chromium could not exec xdg-open (precondition)", /failed to execvp:\s*xdg-open/.test(app.stderr()), true);
      const st = await page.evalJs(`(() => ({
        advance: [...document.querySelectorAll('[data-login-waiting] button')].some((b) => /a aba abriu|tab opened/i.test(b.textContent || '')),
        stillBrowserStep: document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '0',
      }))()`);
      check("no browser handler: stays on the browser step (does not advance by itself)", st.stillBrowserStep, true);
      await shot(page, "github-no-browser-handler");
    },
  });

  // ---- GitHub: the OS refuses to open the browser (forced in the main process) ----
  // The main process is reached through the Node inspector only to make
  // shell.openExternal reject, the way a failing portal/handler does.
  const inspectPort = await pickFreePort();
  await withApp({
    apiBase,
    env: {},
    extraArgs: [`--inspect=${inspectPort}`],
    body: async (page) => {
      const targets = await (await fetch(`http://127.0.0.1:${inspectPort}/json`)).json();
      const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      const evalMain = (expression) =>
        new Promise((resolve) => {
          const id = Math.floor(Math.random() * 1e9);
          const onMsg = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id === id) {
              ws.removeEventListener("message", onMsg);
              resolve(msg.result);
            }
          };
          ws.addEventListener("message", onMsg);
          ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        });
      const patched = await evalMain(
        `(() => { const { shell } = process.mainModule.require('electron'); shell.openExternal = () => Promise.reject(new Error('no handler')); return 'patched'; })()`,
      );
      check("openExternal forced to reject in the main process", patched?.result?.value, "patched");
      await openLogin(page);
      await page.evalJs(`[...document.querySelectorAll('button')].find((b) => /GitHub/i.test(b.textContent || ''))?.click()`);
      check("browser did not open: the URL is shown", await waitFor(page, `!!document.querySelector('[data-role="login-link-url"]')`, 15000), true);
      const st = await page.evalJs(`(() => ({
        url: document.querySelector('[data-role="login-link-url"]')?.textContent ?? '',
        copy: !!document.querySelector('[data-role="login-link-copy"]'),
        advance: [...document.querySelectorAll('[data-login-waiting] button')].some((b) => /a aba abriu|tab opened/i.test(b.textContent || '')),
        text: document.querySelector('[data-login-waiting]')?.textContent ?? '',
      }))()`);
      check("browser did not open: URL is the auth start URL", /\/v1\/auth\/start\?/.test(st.url), true);
      check("browser did not open: Copy link offered", st.copy, true);
      check("browser did not open: does not offer 'the tab opened'", st.advance, false);
      check("browser did not open: says so", /não foi possível abrir|could not open/i.test(st.text), true);
      await page.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
      await page.evalJs(`document.querySelector('[data-role="login-link-copy"]').click()`);
      check("Copy puts the URL on the clipboard", await waitFor(page, `/copiado|copied/i.test(document.querySelector('[data-role="login-link-copy"]')?.textContent ?? '')`, 4000), true);
      await shot(page, "github-open-failed");
      ws.close();
    },
  });
} finally {
  api.close();
}
finish();

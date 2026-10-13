// E-mail sign-in by device flow against a FAKE API (no real e-mail, no real
// server): the request is approved "on another device" by POSTing verify
// straight to the fake, and the app has to log in by itself (polling); the
// typed-code path (right code, wrong codes, 3 strikes) is driven the same way.
// Isolated userData + CDP only; prints under /tmp/login-device/.
//
// LOGIN_SMOKE_CWD: a directory holding the `out/` to launch (default: the repo).
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeChecker, pickFreePort, startApp, stopApp, connectPageRaw } from "./cdp-client.mjs";

const OUT_DIR = "/tmp/login-device";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_CODE = "481925";

function startFakeApi(port) {
  const api = {
    /** The device-flow request the app opened, if any. */
    req: null,
    legacyPosts: 0,
    blindPoll: false,
    close: () => server.close(),
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", r)),
    reset() {
      this.req = null;
      this.legacyPosts = 0;
      this.blindPoll = false;
    },
    /** The phone: opens the link and taps the button. Returns the code the page shows. */
    async approveOnAnotherDevice() {
      const res = await fetch(`http://127.0.0.1:${port}/v1/auth/email/verify?token=${api.req.id}`, { method: "POST" });
      return res.json();
    },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const err = (status, code) => json(status, { error: { code, message: code } });
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        body = {};
      }
      const p = url.pathname;
      if (req.method === "POST" && p === "/v1/auth/email") {
        if (body.redirect_uri !== undefined) {
          api.legacyPosts++;
          return json(202, { status: "sent" });
        }
        api.req = { id: randomUUID(), body, status: "pending", attempts: 0, polls: 0, claims: 0 };
        return json(202, { request_id: api.req.id, poll_interval_sec: 0.4, expires_in: 300 });
      }
      if (req.method === "POST" && p === "/v1/auth/email/verify") {
        if (!api.req || url.searchParams.get("token") !== api.req.id) return err(400, "invalid_token");
        api.req.status = "approved";
        return json(200, { user_code: `${USER_CODE.slice(0, 3)}-${USER_CODE.slice(3)}` });
      }
      if (req.method === "POST" && (p === "/v1/auth/email/poll" || p === "/v1/auth/email/code-claim")) {
        const r = api.req;
        const proofOk =
          r !== null &&
          body.request_id === r.id &&
          body.install_id === r.body.install_id &&
          typeof body.code_verifier === "string" &&
          createHash("sha256").update(body.code_verifier).digest("base64url") === r.body.code_challenge;
        if (!proofOk) return err(400, "invalid_grant");
        const pair = () => {
          r.status = "used";
          return json(200, { access_token: "A1", refresh_token: "R1", expires_in: 900, refresh_expires_in: 2592000 });
        };
        if (p.endsWith("/poll")) {
          r.polls++;
          if (api.blindPoll) return err(503, "unavailable");
          if (r.status === "pending") return json(200, { status: "pending" });
          if (r.status === "approved") return pair();
          if (r.status === "denied") return err(400, "access_denied");
          return err(400, "invalid_grant");
        }
        r.claims++;
        if (r.status === "denied") return err(400, "access_denied");
        if (r.status !== "approved") return err(400, r.status === "used" ? "invalid_grant" : "authorization_pending");
        if (String(body.user_code).replace("-", "") === USER_CODE) return pair();
        r.attempts++;
        if (r.attempts >= 3) {
          r.status = "denied";
          return err(400, "access_denied");
        }
        return err(400, "invalid_code");
      }
      if (req.method === "POST" && p === "/v1/auth/token") {
        return json(200, { access_token: "A2", refresh_token: "R2", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (req.method === "POST" && p === "/v1/auth/logout") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET" && p === "/v1/me") {
        return json(200, { account: { display_name: "Ana" }, identities: [{ kind: "email", subject: "ana@example.com", login: null }] });
      }
      return err(404, "not_found");
    });
  });
  return api;
}

async function withApp({ apiBase, body }) {
  const userData = mkdtempSync(join(tmpdir(), "stellar-login-device-"));
  const cdpPort = await pickFreePort();
  const app = await startApp({
    cdpPort,
    userDataDir: userData,
    preserveUserData: true,
    isolatedHome: true,
    cwd: process.env.LOGIN_SMOKE_CWD || undefined,
    extraEnv: { STELLARCLOUD_AUTH_BROWSER: "log", STELLARCLOUD_API_URL: apiBase },
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

async function setInput(page, id, value) {
  await page.evalJs(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function openLoginAndSend(page, email) {
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(page, `!!document.querySelector('[data-role="firstrun-account"]')`, 30000);
  await page.evalJs(`document.querySelector('[data-role="firstrun-account"]').click()`);
  check("login screen opens", await waitFor(page, `!!document.querySelector('[data-login-choose]')`), true);
  await setInput(page, "lg-email", email);
  await page.evalJs(`document.querySelector('[data-role="send-link"]').click()`);
  check("waiting step appears (step 2 of 4)", await waitFor(page, `document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '1'`), true);
}

const ui = (page) =>
  page.evalJs(`(() => ({
    step: document.querySelector('[data-login-waiting]')?.getAttribute('data-step') ?? null,
    choose: !!document.querySelector('[data-login-choose]'),
    text: document.querySelector('[data-login-waiting]')?.textContent ?? '',
    link: !!document.querySelector('[data-role="toggle-code-link"]'),
    box: !!document.querySelector('[data-role="code-expanded-box"]'),
    err: document.querySelector('[data-role="code-err-msg"]')?.textContent ?? null,
    blocked: document.querySelector('[data-role="code-blocked-msg"]')?.textContent ?? null,
    inputDisabled: document.getElementById('lg-code')?.disabled ?? null,
    newEmail: !!document.querySelector('[data-role="code-new-email"]'),
    back: [...document.querySelectorAll('[data-login-waiting] button')].some((b) => /voltar|back/i.test(b.textContent || '')),
  }))()`);

async function typeCodeAndConfirm(page, code) {
  await setInput(page, "lg-code", code);
  await waitFor(page, `document.querySelector('[data-role="confirm-btn"]')?.disabled === false`, 4000);
  await page.evalJs(`document.querySelector('[data-role="confirm-btn"]').click()`);
}

const cloudState = (page) => page.evalJs(`window.cloud.status().then((s) => s.state)`);

const apiPort = await pickFreePort();
const api = startFakeApi(apiPort);
await api.listen();
const apiBase = `http://127.0.0.1:${apiPort}`;

try {
  // ---- 1. approved on another device: the polling logs the app in by itself ----
  api.reset();
  await withApp({
    apiBase,
    body: async (page) => {
      await openLoginAndSend(page, "ana@example.com");
      const st = await ui(page);
      check("device flow: request sent WITHOUT redirect_uri", api.req !== null && api.req.body.redirect_uri === undefined, true);
      check("device flow: no legacy (loopback) request", api.legacyPosts, 0);
      check("device flow: PKCE S256 + install_id sent", api.req.body.code_challenge_method === "S256" && /^[0-9a-f-]{16,}$/i.test(api.req.body.install_id ?? ""), true);
      check("waiting: current text kept (names the address)", st.text.includes("ana@example.com"), true);
      check("waiting: the code link is offered, field closed", st.link && !st.box, true);
      await shot(page, "01-aguardando");
      await waitFor(page, `true`, 1);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && api.req.polls < 2) await delay(150);
      check("polling is running (>= 2 polls)", api.req.polls >= 2, true);
      check("still waiting before the approval", (await cloudState(page)), "pending");

      const phone = await api.approveOnAnotherDevice();
      check("the phone page got the code", phone.user_code, "481-925");
      check("app logs in on its own and advances to step 3", await waitFor(page, `document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '2'`, 10000), true);
      check("session is logged-in", await cloudState(page), "logged-in");
      await shot(page, "02-confirmado");
      const polls = api.req.polls;
      await delay(1500);
      check("polling stopped after the login", api.req.polls, polls);
    },
  });

  // ---- 2. Voltar while polling: the request stops being polled ----
  api.reset();
  await withApp({
    apiBase,
    body: async (page) => {
      await openLoginAndSend(page, "ana@example.com");
      await waitFor(page, `true`, 1);
      await page.evalJs(`[...document.querySelectorAll('[data-login-waiting] button')].find((b) => /voltar|back/i.test(b.textContent || ''))?.click()`);
      check("back returns to the form", await waitFor(page, `!!document.querySelector('[data-login-choose]')`), true);
      check("back: login cancelled", await cloudState(page), "logged-out");
      const polls = api.req.polls;
      await delay(1500);
      check("back: polling stopped", api.req.polls, polls);
    },
  });

  // ---- 3. typed code: wrong, wrong, right (the polling cannot get through) ----
  api.reset();
  await withApp({
    apiBase,
    body: async (page) => {
      await openLoginAndSend(page, "ana@example.com");
      api.blindPoll = true;
      await page.evalJs(`document.querySelector('[data-role="toggle-code-link"]').click()`);
      check("code field opens", await waitFor(page, `!!document.getElementById('lg-code')`), true);
      let st = await ui(page);
      check("code field open: link gone, hint shown", !st.link && st.box && /sozinha|on its own/i.test(st.text), true);
      await shot(page, "03-codigo-aberto");

      await api.approveOnAnotherDevice();
      await typeCodeAndConfirm(page, "000-000");
      check("wrong #1: 'restam 2'", await waitFor(page, `/2/.test(document.querySelector('[data-role="code-err-msg"]')?.textContent ?? '')`), true);
      await shot(page, "04-codigo-errado");
      await typeCodeAndConfirm(page, "111-111");
      check("wrong #2: last attempt message", await waitFor(page, `/1 tentativa|1 attempt/i.test(document.querySelector('[data-role="code-err-msg"]')?.textContent ?? '')`), true);
      check("2 wrong codes did not cancel the request", api.req.attempts, 2);

      await typeCodeAndConfirm(page, "481925");
      check("right code advances to step 3", await waitFor(page, `document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '2'`, 10000), true);
      check("right code: session logged-in", await cloudState(page), "logged-in");
    },
  });

  // ---- 4. three wrong codes: the request is cancelled ----
  api.reset();
  await withApp({
    apiBase,
    body: async (page) => {
      await openLoginAndSend(page, "ana@example.com");
      api.blindPoll = true;
      await api.approveOnAnotherDevice();
      await page.evalJs(`document.querySelector('[data-role="toggle-code-link"]').click()`);
      await waitFor(page, `!!document.getElementById('lg-code')`);
      for (const c of ["000-000", "111-111", "222-222"]) {
        await typeCodeAndConfirm(page, c);
        await delay(400);
      }
      check("3 strikes: blocked message", await waitFor(page, `!!document.querySelector('[data-role="code-blocked-msg"]')`), true);
      const st = await ui(page);
      check("3 strikes: input disabled", st.inputDisabled, true);
      check("3 strikes: 'Pedir novo e-mail' replaces Voltar", st.newEmail && !st.back, true);
      check("3 strikes: stays on this step (pending)", (await cloudState(page)) === "pending" && st.step === "1", true);
      await shot(page, "05-codigo-bloqueado");
      const polls = api.req.polls;
      await delay(1500);
      check("3 strikes: polling stopped", api.req.polls, polls);

      await page.evalJs(`document.querySelector('[data-role="code-new-email"]').click()`);
      check("new e-mail: back to the form", await waitFor(page, `!!document.querySelector('[data-login-choose]')`), true);
      check("new e-mail: logged-out", await cloudState(page), "logged-out");
    },
  });
} finally {
  api.close();
}
finish();

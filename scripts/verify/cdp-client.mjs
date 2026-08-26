// Reusable CDP driver for empirically verifying agent-canvas changes
// against a REAL running instance — not a testing framework, just the
// connection/eval boilerplate that got rewritten from scratch by hand
// something like six times in one session before this existed. Every
// smoke script in this directory imports from here instead of
// reinventing "find the page target, open a WebSocket, request/response
// by id, evalJs" again.
//
// Deliberately NOT Playwright/Puppeteer: this machine has no system
// Chrome/Chromium for Playwright to drive, and the whole point is to
// exercise the REAL packaged Electron app (GPU-disabled, the same
// software-rendering config it actually ships with), not a stock browser.
//
// Always launches an isolated instance (its own --user-data-dir and
// --remote-debugging-port) — NEVER attaches to the user's own `npm run
// dev` session. See AGENTS.md for why that rule exists in this project.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ELECTRON_BIN = fileURLToPath(new URL("../../node_modules/.bin/electron", import.meta.url));
const ELECTRON_MAIN = "out/main/index.js";

/**
 * Launches an isolated `electron out/main/index.js` instance and waits
 * until its CDP endpoint is answering. Caller owns cleanup via
 * `stopApp()`.
 *
 * Invokes `node_modules/.bin/electron` directly, NOT `npx electron` — the
 * npx wrapper spawns Electron as its own child process, and killing the
 * wrapper doesn't reliably kill that child (confirmed the hard way: a run
 * of this harness left real Electron processes running in the
 * background, invisible to `stopApp`, that then starved later runs of
 * CPU/GPU-disabled-software-rendering time and made them time out).
 * Calling the binary directly means `proc` IS the Electron process, so a
 * normal SIGTERM actually reaches it.
 */
export async function startApp({ cdpPort, userDataDir, cwd = PROJECT_ROOT, extraArgs = [], timeoutMs = 15000 }) {
  // Every run starts from a clean profile — `userDataDir` isn't wiped
  // between invocations otherwise, so board/card state (SQLite) piles up
  // across runs and checks that assume "just the auto-seeded card" start
  // silently failing once a second run reuses the same directory. Real
  // failure mode hit while building this harness, not a hypothetical.
  rmSync(userDataDir, { recursive: true, force: true });
  // `node_modules/.bin/electron` is itself a small Node wrapper (cli.js)
  // that spawns the REAL Electron binary as ITS OWN child and waits on
  // it — confirmed the hard way: killing that wrapper process left the
  // real Electron binary running as an orphan, which is what was
  // actually causing verify runs to leave processes behind / stall on
  // stale ports. `detached: true` puts the wrapper (and everything it
  // spawns) in its own process group, so `stopApp` below can kill the
  // whole group at once via a negative pid instead of just the wrapper.
  const proc = spawn(
    ELECTRON_BIN,
    [ELECTRON_MAIN, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, ...extraArgs],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      // Never let a throwaway instance bind the app's real remote-control
      // port (4488, fixed in src/main/index.ts) — it collided with the
      // user's own running `npm run dev` session (EADDRINUSE, uncaught in
      // main, crashed their live app) the first time this harness ran
      // ad hoc while a real session was up. Derived from cdpPort so it's
      // both unique per test instance and never 4488.
      env: { ...process.env, AGENT_CANVAS_REMOTE_PORT: String(cdpPort + 30000) },
    },
  );
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) return { proc, cdpPort, stderr: () => stderr };
    } catch {
      // Not up yet — normal during the first second or so.
    }
    await delay(200);
  }
  proc.kill("SIGKILL");
  throw new Error(`app didn't come up on port ${cdpPort} within ${timeoutMs}ms\nstderr so far:\n${stderr}`);
}

/**
 * Ends the app. NOT via CDP's `/json/close/<pageId>` — confirmed by
 * direct comparison that this specific endpoint hangs indefinitely
 * without ever answering the HTTP request, even though the app's own
 * shutdown (verified separately, with the exact same `winControls.close()`
 * IPC call the real close button uses) completes cleanly and exits
 * promptly on its own. A CDP/Electron interaction quirk in that one
 * endpoint, not a bug in the app — so this sidesteps it entirely and just
 * SIGTERMs the process, with a SIGKILL fallback if it doesn't exit on its
 * own quickly. A verify run should never leave a process behind for the
 * next one to trip over.
 */
export async function stopApp(app) {
  function killGroup(signal) {
    try {
      // Negative pid = signal the whole process group (see the
      // `detached: true` note in startApp) — this is what actually
      // reaches the real Electron binary, not just the cli.js wrapper.
      process.kill(-app.proc.pid, signal);
    } catch {
      // Group (or the process itself) already gone.
    }
  }
  if (app.proc.exitCode === null && app.proc.signalCode === null) killGroup("SIGTERM");
  const deadline = Date.now() + 5000;
  while (app.proc.exitCode === null && app.proc.signalCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (app.proc.exitCode === null && app.proc.signalCode === null) killGroup("SIGKILL");
}

/** A live CDP connection to the app's one page target — `send` for raw
 * protocol calls, `evalJs` for the common "run this expression in the
 * page, get the value back" case. */
export async function connectPage(cdpPort) {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  const target = list.find((t) => t.type === "page");
  if (!target) throw new Error("no page target found");
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const eventListeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of eventListeners) fn(msg);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  await send("Runtime.enable");

  async function evalJs(expr) {
    const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  }

  /** Real down+move+up on the same synthetic pointer — see AGENTS.md's
   * documented gotcha: separate dispatch calls with pointerType left
   * unset don't reliably register as the same drag gesture. */
  async function click(x, y, button = "left") {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1, pointerType: "mouse" });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1, pointerType: "mouse" });
  }

  function onEvent(fn) {
    eventListeners.push(fn);
    return () => {
      const i = eventListeners.indexOf(fn);
      if (i >= 0) eventListeners.splice(i, 1);
    };
  }

  return { ws, send, evalJs, click, onEvent, close: () => ws.close() };
}

/** Tiny assertion helper — smoke scripts print PASS/FAIL per check and
 * exit 1 if anything failed, instead of each hand-rolling that. */
export function makeChecker() {
  let failed = 0;
  function check(label, actual, expected) {
    const ok = typeof expected === "function" ? expected(actual) : actual === expected;
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}${ok ? "" : ` (got ${JSON.stringify(actual)})`}`);
    if (!ok) failed++;
  }
  function finish() {
    if (failed > 0) {
      console.log(`\n${failed} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nall checks passed.");
  }
  return { check, finish };
}

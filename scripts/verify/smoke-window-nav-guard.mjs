// Pre-release audit S3 — the main window is `frame: false`: no address
// bar, no back button. Before the guard in `main/index.ts`, one click on
// a link in rendered markdown (`Markdown.tsx`, `dangerouslySetInnerHTML`)
// navigated the WHOLE app off its own document, with no way back short of
// killing the process. This proves, against the real app, that (a) the
// navigation is refused, (b) the app survives it, and (c) an http(s) URL
// is still handed to the OS so the link is not merely swallowed.
//
// `xdg-open` is shimmed onto PATH before launching so `shell.openExternal`
// is observable AND harmless — otherwise every run of this suite would
// pop a real browser tab on whoever is running it. Electron resolves
// `xdg-open` through the PATH it inherits, and `startApp` spreads
// `process.env`, so mutating PATH here is enough (no change to
// cdp-client.mjs needed).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CDP_PORT = 9460;
const USER_DATA_DIR = fileURLToPath(new URL("../../.verify-tmp/smoke-window-nav-guard", import.meta.url));
const SHIM_DIR = fileURLToPath(new URL("../../.verify-tmp/smoke-window-nav-guard-shim", import.meta.url));
const OPENED_LOG = `${SHIM_DIR}/opened.txt`;

rmSync(SHIM_DIR, { recursive: true, force: true });
mkdirSync(SHIM_DIR, { recursive: true });
writeFileSync(`${SHIM_DIR}/xdg-open`, `#!/bin/sh\necho "$1" >> ${OPENED_LOG}\n`);
chmodSync(`${SHIM_DIR}/xdg-open`, 0o755);
process.env.PATH = `${SHIM_DIR}:${process.env.PATH}`;

// Imported AFTER the PATH edit above — startApp captures process.env when
// it spawns, and a static import would hoist above it.
const { startApp, stopApp, connectPage, makeChecker } = await import("./cdp-client.mjs");

const opened = () => (existsSync(OPENED_LOG) ? readFileSync(OPENED_LOG, "utf8").trim().split("\n") : []);

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1200));
  const appUrl = await page.evalJs(`location.href`);
  check("app document loaded (the guard didn't break the initial load)", appUrl.includes("out/renderer/index.html"), true);

  // A REAL anchor click inside a `.md-content` container — the exact
  // shape `Markdown.tsx` produces, not a synthetic location assignment.
  await page.evalJs(`(() => {
    const holder = document.createElement("div");
    holder.className = "md-content";
    holder.innerHTML = '<a href="https://example.com/stellar-nav-guard">link</a>';
    document.body.appendChild(holder);
    holder.querySelector("a").click();
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  check("markdown link click did NOT navigate the app away", await page.evalJs(`location.href`), appUrl);
  check("...and the app is still rendering", await page.evalJs(`!!document.querySelector(".viewport")`), true);
  check("...and the URL was handed to the OS instead", opened(), (o) => o.includes("https://example.com/stellar-nav-guard"));

  // window.open / target="_blank": denied outright, same as
  // browser-registry.ts does for embedded browser cards.
  check("window.open is denied", await page.evalJs(`String(window.open("https://example.com/stellar-window-open"))`), "null");
  await new Promise((r) => setTimeout(r, 800));
  check("...and that URL went to the OS too", opened(), (o) => o.includes("https://example.com/stellar-window-open"));

  // Scheme filter: a non-web URL is still refused navigation, but must
  // NOT be handed to the OS opener (which would launch whatever handler
  // is registered for it — and these strings come from agent output).
  await page.evalJs(`location.href = "file:///etc/hostname"`);
  await new Promise((r) => setTimeout(r, 1000));
  check("file: navigation is refused too", await page.evalJs(`location.href`), appUrl);
  check("...and is NOT passed to the OS opener", opened(), (o) => !o.some((u) => u.startsWith("file:")));
  check("app still alive at the end", await page.evalJs(`!!document.querySelector(".viewport")`), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

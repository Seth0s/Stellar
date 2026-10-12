// Update dialog + title-bar icon in the DEV build (isolated instance).
//
// `update-available` only fires for real from a packaged build with a working
// feed (that path is proven by smoke-updater-local-feed.mjs), so this one drives
// the renderer through `window.updater.testSetState` — a hook main keeps inert
// in packaged builds — and checks what the user sees and which calls the buttons
// make. In a dev build every install/download call answers "dev build", so a
// click can never change anything on this machine.
import { mkdirSync, writeFileSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-updater-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "/tmp/update-ui";
mkdirSync(OUT, { recursive: true });

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Alpha", { spawnTerminal: false });

  const q = (sel) => page.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = (sel) => page.evalJs(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const set = (snapshot, counts = null) =>
    page.evalJs(`window.updater.testSetState(${JSON.stringify(snapshot)}, ${JSON.stringify(counts)})`);
  // The title-bar icon in each state, cropped to the controls (top right).
  const shotIcon = async (name) => {
    const { data } = await page.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: await page.evalJs("window.innerWidth - 260"), y: 0, width: 260, height: 34, scale: 2 },
    });
    writeFileSync(`${OUT}/icon-${name}.png`, Buffer.from(data, "base64"));
  };
  const NOTES = "- fixed a bug\n- added a feature";
  const OFFER = { phase: "available", version: "1.2.3", changelog: NOTES, downloadBytes: 38_200_000, progress: null, error: null, manual: null };

  check("no update dialog before any update is found", await q('[data-part="update-dialog"]'), false);
  check("no update icon in the title bar yet", await q('[data-role="update-icon"]'), false);

  // Manual check button (item 17) — independent of any pending update.
  check("manual update-check button exists in the titlebar", await q(".titlebar-update-check"), true);
  await delay(300);
  check(
    "manual check button has no error state after the dev boot check",
    await page.evalJs(`document.querySelector('.titlebar-update-check')?.classList.contains('has-error')`),
    false,
  );
  await page.evalJs(`document.querySelector('.titlebar-update-check')?.click()`);
  await delay(300);
  check(
    "manual click re-runs the check and settles back out of the 'checking' state",
    await page.evalJs(`document.querySelector('.titlebar-update-check')?.classList.contains('is-checking')`),
    false,
  );

  // An offered version opens the dialog by itself, once.
  await set(OFFER);
  await delay(300);
  check("an offered version opens the dialog", await text('[data-part="update-dialog"] h1'), "Atualização disponível");
  check("the dialog shows the version", (await text('[data-part="update-dialog"]'))?.includes("1.2.3"), true);
  check("release notes show as bullets", (await text('[data-part="update-notes"]'))?.includes("fixed a bug"), true);
  check("the download button carries the size", await text('[data-part="update-primary"]'), "Baixar · 38 MB");
  check("title-bar icon exists as the pending dot", await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.dataset.phase`), "available");
  await shotIcon("available");

  // Clicking Download in a dev build is refused by main and changes nothing.
  await page.evalJs(`document.querySelector('[data-part="update-primary"]')?.click()`);
  await delay(300);
  check("download in a dev build does not move the dialog", await page.evalJs(`document.querySelector('[data-part="update-dialog"]')?.dataset.state`), "available");

  // "Agora não" closes the dialog; the icon survives and reopens it.
  await page.evalJs(`[...document.querySelectorAll('[data-part="update-dialog"] footer button')].find((b) => b.textContent === 'Agora não')?.click()`);
  await delay(200);
  check("'Agora não' closes the dialog", await q('[data-part="update-dialog"]'), false);
  check("the icon stays up after 'Agora não'", await q('[data-role="update-icon"]'), true);
  await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.click()`);
  await delay(200);
  check("clicking the icon reopens the dialog", await q('[data-part="update-dialog"]'), true);

  // Each state, and what the icon says.
  await set({ ...OFFER, phase: "downloading", progress: { percent: 48, transferred: 18_400_000, total: 38_200_000, bytesPerSecond: 3_100_000 } });
  await delay(200);
  check("downloading shows the percentage", (await text('[data-part="update-progress"]'))?.includes("48%"), true);
  check("the icon title carries the percentage", (await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.title`)).includes("48%"), true);
  await shotIcon("downloading");

  await set({ ...OFFER, phase: "ready" }, { terminals: 3, agents: 2, sessions: 2 });
  await delay(400);
  check("ready names what a restart would end", (await text('[data-part="update-running-warning"]'))?.includes("3 terminais e 2 agentes"), true);
  check("ready is the only state with 'Reiniciar agora'", await text('[data-part="update-primary"]'), "Reiniciar agora");

  // Restart in a dev build is refused: the dialog stays on 'ready' (nothing closed).
  await page.evalJs(`document.querySelector('[data-part="update-primary"]')?.click()`);
  await delay(400);
  check("restart in a dev build does not close or install anything", await page.evalJs(`document.querySelector('[data-part="update-dialog"]')?.dataset.state`), "ready");

  // 'Reiniciar depois' only closes.
  await page.evalJs(`[...document.querySelectorAll('[data-part="update-dialog"] footer button')].find((b) => b.textContent === 'Reiniciar depois')?.click()`);
  await delay(200);
  check("'Reiniciar depois' closes the dialog", await q('[data-part="update-dialog"]'), false);
  check("the icon now says the update is ready", await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.dataset.phase`), "ready");
  await shotIcon("ready");

  // Failure and manual states.
  await set({ ...OFFER, phase: "error", error: { kind: "network", stage: "download", code: "ENOTFOUND", detail: "getaddrinfo ENOTFOUND", percent: 62, transferred: 23_700_000, total: 38_200_000, neededBytes: null, freeBytes: null, swapLogPath: null } });
  await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.click()`);
  await delay(300);
  check("a failure shows its cause and detail", (await text('[data-part="update-error-message"]'))?.includes("Falha de rede ao baixar"), true);
  check("the icon marks the failure", await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.dataset.phase`), "error");
  await shotIcon("error");
  await set({ ...OFFER, phase: "manual", manual: { manager: "dnf", fileName: "f.rpm", command: "sudo dnf install ./f.rpm" } });
  await delay(300);
  check("manual shows the package-manager command", (await text('[data-part="update-manual-steps"]'))?.includes("sudo dnf install ./f.rpm"), true);

  // Installing cannot be closed.
  await set({ ...OFFER, phase: "installing" });
  await delay(300);
  check("installing shows the restart message", await q('[data-part="update-installing"]'), true);
  await shotIcon("installing");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(200);
  check("Esc does not close the dialog while installing", await q('[data-part="update-dialog"]'), true);
  check("the old banner is gone for good", await q(".update-banner"), false);
} finally {
  await stopApp(app);
}
finish();

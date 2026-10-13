import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = await pickFreePort();
const userDataDir = mkdtempSync(join(tmpdir(), "stellar-rail-quota-"));
const fakeBin = mkdtempSync(join(tmpdir(), "stellar-rail-quota-bin-"));
const fakeCli = join(fakeBin, "claude");
writeFileSync(fakeCli, "#!/bin/sh\nexec sleep 30\n");
chmodSync(fakeCli, 0o755);
const { check, finish } = makeChecker();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const app = await startApp({
  cdpPort: port,
  userDataDir,
  isolatedHome: true,
  extraEnv: {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    STELLAR_VERIFY_PROVIDER_USAGE: JSON.stringify({
      provider: "claude",
      supported: true,
      source: "http",
      segments: [{ key: "week", percent: 100, resetsAtMs: Date.now() + 3600000 }],
    }),
  },
});

try {
  const page = await connectPage(port);
  await page.send("Page.enable");
  await bootIntoFreshSession(page, "Quota Smoke", { spawnTerminal: false });
  await wait(250);
  await page.evalJs(`document.querySelector('[data-role="rail-add-card"]')?.click()`);
  await page.evalJs(`document.querySelector('[data-kind="terminal"]')?.click()`);
  await wait(150);

  const rowState = await page.evalJs(`(() => {
    const row = document.querySelector('button[data-provider="claude"]');
    return row ? { disabled: row.disabled, warning: row.textContent, step: document.querySelector('[data-role="rail-dock"]')?.dataset.railStep } : null;
  })()`);
  check("exhausted simulated provider is visible and selectable", rowState, (value) => value && value.disabled === false && /cota pode estar esgotada|quota may be exhausted/i.test(value.warning));

  const before = await page.evalJs(`document.querySelectorAll('.card-frame[data-card-id]').length`);
  await page.evalJs(`document.querySelector('button[data-provider="claude"]')?.click()`);
  await wait(100);
  check("exhausted quota opens the app confirmation modal", await page.evalJs(`!!document.querySelector('.modal[aria-labelledby="confirm-title"]')`), true);
  await page.evalJs(`document.querySelector('.modal-actions button.primary')?.click()`);
  await wait(100);
  check("confirmation advances to the card setup step", await page.evalJs(`document.querySelector('[data-role="rail-dock"]')?.dataset.railStep`), "terminal2");
  await page.evalJs(`document.querySelector('[data-role="agent-flow-create"]')?.click()`);
  await wait(500);
  const after = await page.evalJs(`document.querySelectorAll('.card-frame[data-card-id]').length`);
  check("spawn creates a terminal card after quota confirmation", after, (value) => value > before);
  finish();
} finally {
  await stopApp(app, { userDataDir });
  rmSync(fakeBin, { recursive: true, force: true });
}

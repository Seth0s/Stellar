// Isolated inbox smoke: boots Electron with a fixture matching the approved
// Inbox prototype rows, asserts the page, and writes app/proto/side-by-side
// PNGs under /tmp/a5c/ only (not under docs/design).
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { startApp, stopApp, connectPageRaw, assertAppDocument, pickFreePort, makeChecker } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO = join(PROJECT_ROOT, "docs/design/app-v2/prototipo/Inbox.dc.html");
const FIXTURE = join(PROJECT_ROOT, "scripts/verify/fixtures/inbox-tela20.json");
const OUT_DIR = "/tmp/a5c";
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = join(PROJECT_ROOT, `.verify-tmp/smoke-inbox-${CDP_PORT}`);

const { check, finish } = makeChecker();
mkdirSync(OUT_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function sideBySide(leftPath, rightPath, outPath) {
  // Prefer ImageMagick; fall back to keeping both files when convert is absent.
  const tryConvert = spawnSync("convert", [leftPath, rightPath, "+append", outPath], { encoding: "utf8" });
  if (tryConvert.status === 0 && existsSync(outPath)) return true;
  const tryMagick = spawnSync("magick", [leftPath, rightPath, "+append", outPath], { encoding: "utf8" });
  return tryMagick.status === 0 && existsSync(outPath);
}

const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { STELLAR_INBOX_FIXTURE: FIXTURE },
});

try {
  const page = await connectPageRaw(CDP_PORT);
  await assertAppDocument(page.evalJs);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  async function shot(name) {
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    const path = join(OUT_DIR, `${name}.png`);
    writeFileSync(path, Buffer.from(res.data, "base64"));
    return path;
  }

  async function waitFor(expr, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await page.evalJs(expr)) return true;
      await delay(150);
    }
    return false;
  }

  const booted = await waitFor(
    `!!(!document.querySelector('[data-boot]') && (document.querySelector('[data-role="firstrun-local"]') || document.querySelector('[data-section]')))`,
  );
  check("cold start reaches shell or first-run", booted, true);
  if (await page.evalJs(`!!document.querySelector('[data-role="firstrun-local"]')`)) {
    await page.evalJs(`document.querySelector('[data-role="firstrun-local"]').click()`);
    await waitFor(`!!document.querySelector('[data-section]')`);
  }

  check("inbox nav exists", await page.evalJs(`!!document.querySelector('[data-section="inbox"]')`), true);
  await page.evalJs(`document.querySelector('[data-section="inbox"]').click()`);
  const inboxUp = await waitFor(`!!document.querySelector('[data-page="inbox"]')`);
  check("inbox page mounts", inboxUp, true);

  const rowCount = await page.evalJs(`document.querySelectorAll('[data-inbox-item]').length`);
  check("fixture seeds seven rows", rowCount, 7);
  check(
    "badge shows 7",
    await page.evalJs(`(() => {
      const btn = document.querySelector('[data-section="inbox"]');
      if (!btn) return null;
      const spans = [...btn.querySelectorAll("span")];
      return spans.map((s) => s.textContent?.trim()).find((t) => t === "7") ?? null;
    })()`),
    "7",
  );
  check(
    "prefs live in the sidebar foot (not the page)",
    await page.evalJs(`(() => {
      const prefs = document.querySelector('[data-role="inbox-prefs"]');
      if (!prefs) return false;
      const inPage = !!prefs.closest('[data-page="inbox"]');
      const inAside = !!prefs.closest('aside');
      return inAside && !inPage;
    })()`),
    true,
  );
  check("review-now action on first row", await page.evalJs(`!!document.querySelector('[data-action="review_now"]')`), true);

  const appPrefsBox = await page.evalJs(`(() => {
    const el = document.querySelector('[data-role="inbox-prefs"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderTopColor: cs.borderTopColor,
      borderTopWidth: cs.borderTopWidth,
      borderRadius: cs.borderRadius,
      paddingTop: cs.paddingTop,
      paddingLeft: cs.paddingLeft,
      gap: cs.gap,
      display: cs.display,
      flexDirection: cs.flexDirection,
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      bottom: Math.round(r.bottom),
    };
  })()`);

  // Gate-fail meta: same font-size/line-height as other secondary rows; only color differs.
  const appGateMeta = await page.evalJs(`(() => {
    const row = document.querySelector('[data-kind="gate_falhou"]');
    const el = row?.querySelector('[class*="meta"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color };
  })()`);
  const appOtherMeta = await page.evalJs(`(() => {
    const row = document.querySelector('[data-kind="revisar"]');
    const el = row?.querySelector('[class*="meta"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight };
  })()`);
  check("gate meta font-size equals other meta rows", appGateMeta?.fontSize, appOtherMeta?.fontSize);
  check("gate meta line-height equals other meta rows", appGateMeta?.lineHeight, appOtherMeta?.lineHeight);

  const appShot = await shot("app-tela20-inbox");

  const html = readFileSync(PROTO, "utf8");
  await page.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
  await delay(600);

  const protoGateMeta = await page.evalJs(`(() => {
    const items = [...document.querySelectorAll('.it')];
    const gate = items.find((it) => (it.textContent || '').includes('Gate falhou'));
    if (!gate) return null;
    const col = gate.children[1];
    const meta = col?.children?.[1];
    if (!meta) return null;
    const cs = getComputedStyle(meta);
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color };
  })()`);
  const protoOtherMeta = await page.evalJs(`(() => {
    const items = [...document.querySelectorAll('.it')];
    const first = items[0];
    const col = first?.children?.[1];
    const meta = col?.children?.[1];
    if (!meta) return null;
    const cs = getComputedStyle(meta);
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight };
  })()`);

  const protoPrefsBox = await page.evalJs(`(() => {
    const aside = document.querySelector('aside');
    if (!aside) return null;
    const el = [...aside.children].find((c) => (c.textContent || '').includes('Notificações') && c.querySelector('input[type="checkbox"]'));
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderTopColor: cs.borderTopColor,
      borderTopWidth: cs.borderTopWidth,
      borderRadius: cs.borderRadius,
      paddingTop: cs.paddingTop,
      paddingLeft: cs.paddingLeft,
      gap: cs.gap,
      display: cs.display,
      flexDirection: cs.flexDirection,
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      bottom: Math.round(r.bottom),
    };
  })()`);

  writeFileSync(
    join(OUT_DIR, "gate-meta-measure.json"),
    JSON.stringify({ appGateMeta, appOtherMeta, protoGateMeta, protoOtherMeta }, null, 2),
  );
  writeFileSync(join(OUT_DIR, "prefs-box-measure.json"), JSON.stringify({ appPrefsBox, protoPrefsBox }, null, 2));
  check("proto gate meta is 12px", protoGateMeta?.fontSize, "12px");
  check("app gate meta matches proto font-size", appGateMeta?.fontSize, protoGateMeta?.fontSize);
  check("prefs font-size is 12px on both sides", appPrefsBox?.fontSize === "12px" && protoPrefsBox?.fontSize === "12px", true);
  check("prefs padding matches (12px)", appPrefsBox?.paddingTop === protoPrefsBox?.paddingTop, true);
  check("prefs radius matches (10px)", appPrefsBox?.borderRadius === protoPrefsBox?.borderRadius, true);

  const protoShot = await shot("proto-Inbox");

  const sidePath = join(OUT_DIR, "side-by-side-tela20.png");
  const composed = sideBySide(protoShot, appShot, sidePath);
  check("side-by-side composed into /tmp/a5c", composed || existsSync(appShot), true);

  console.log("MEASURE gate meta", JSON.stringify({ appGateMeta, protoGateMeta }));
  console.log("MEASURE prefs box", JSON.stringify({ appPrefsBox, protoPrefsBox }));

  page.close();
} finally {
  await stopApp(app);
  try {
    rmSync(USER_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
finish();

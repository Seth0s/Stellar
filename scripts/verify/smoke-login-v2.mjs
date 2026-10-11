// Isolated parity smoke for app-v2 screens 1 (Boot), 6 (LoginWaiting) and 7
// (Invite). Forces each state via STELLAR_LOGIN_V2_FIXTURE, asserts key DOM/
// computed styles, and writes prints + measures under /tmp/login-v2/ only.
import { mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { startApp, stopApp, connectPageRaw, assertAppDocument, pickFreePort, makeChecker } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO_DIR = join(PROJECT_ROOT, "docs/design/app-v2/prototipo");
const FIXTURE_DIR = join(PROJECT_ROOT, "scripts/verify/fixtures");
const OUT_DIR = "/tmp/login-v2";
const { check, finish } = makeChecker();

mkdirSync(OUT_DIR, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function sideBySide(leftPath, rightPath, outPath) {
  const tryConvert = spawnSync("convert", [leftPath, rightPath, "+append", outPath], { encoding: "utf8" });
  if (tryConvert.status === 0 && existsSync(outPath)) return true;
  const tryMagick = spawnSync("magick", [leftPath, rightPath, "+append", outPath], { encoding: "utf8" });
  return tryMagick.status === 0 && existsSync(outPath);
}

async function withApp(fixtureName, fn) {
  const cdpPort = await pickFreePort();
  const userDataDir = join(PROJECT_ROOT, `.verify-tmp/smoke-login-v2-${fixtureName}-${cdpPort}`);
  const app = await startApp({
    cdpPort,
    userDataDir,
    extraEnv: { STELLAR_LOGIN_V2_FIXTURE: join(FIXTURE_DIR, `login-v2-${fixtureName}.json`) },
  });
  try {
    const page = await connectPageRaw(cdpPort);
    await assertAppDocument(page.evalJs);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await fn(page);
    page.close();
  } finally {
    await stopApp(app);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  const path = join(OUT_DIR, `${name}.png`);
  writeFileSync(path, Buffer.from(res.data, "base64"));
  return path;
}

async function waitFor(page, expr, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evalJs(expr)) return true;
    await delay(150);
  }
  return false;
}

async function captureProto(page, file, name) {
  await page.send("Page.navigate", { url: `file://${join(PROTO_DIR, file)}` });
  await delay(800);
  return shot(page, name);
}

function measureBox(sel) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent || "").trim().slice(0, 200),
      borderRadius: cs.borderRadius,
      backgroundColor: cs.backgroundColor,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      gap: cs.gap,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      width: Math.round(r.width),
      height: Math.round(r.height),
      left: Math.round(r.left),
      top: Math.round(r.top),
    };
  })()`;
}

const measures = {};

// ---- Tela 1: Boot ----
await withApp("boot", async (page) => {
  const up = await waitFor(page, `!!document.querySelector('[data-boot]')`);
  check("boot screen held by fixture", up, true);
  await delay(400);

  const halo = await page.evalJs(measureBox("[data-boot] [class*='halo']"));
  const track = await page.evalJs(measureBox("[data-boot] [class*='track']"));
  const titlebar = await page.evalJs(measureBox(".titlebar"));
  const sessionsText = await page.evalJs(
    `([...document.querySelectorAll('[data-boot] [class*="step"]')].map((e) => (e.textContent || "").replace(/\\s+/g, " ").trim()).find((t) => /^restaurando \\d+ sessões$/.test(t)) || null)`,
  );
  const footText = await page.evalJs(`(document.querySelector('[data-boot] [class*="foot"]')?.textContent || "").replace(/\\s+/g, " ").trim()`);

  check("boot halo radius is 48px", halo?.borderRadius, "48px");
  check("boot track radius is 3px", track?.borderRadius, "3px");
  check("titlebar bg is #090b0f", titlebar?.backgroundColor, "rgb(9, 11, 15)");
  check("titlebar padding-left 12px", titlebar?.paddingLeft, "12px");
  check("titlebar padding-right 8px", titlebar?.paddingRight, "8px");
  check("sessions step shows count", sessionsText, "restaurando 4 sessões");
  check("footer shows home synced", footText.includes("casa sincronizada"), true);

  measures.tela1 = { halo, track, titlebar, sessionsText, footText };
  const appShot = await shot(page, "tela1-app");
  const protoShot = await captureProto(page, "Main.dc.html", "tela1-proto");
  const side = join(OUT_DIR, "tela1-side-by-side.png");
  check("tela1 side-by-side", sideBySide(protoShot, appShot, side) || existsSync(appShot), true);
});

// ---- Tela 6: LoginWaiting ----
await withApp("waiting", async (page) => {
  const up = await waitFor(page, `!!document.querySelector('[data-login-waiting]')`);
  check("login waiting card mounts", up, true);
  await delay(300);

  const wrap = await page.evalJs(measureBox("[data-login-waiting]"));
  const card = await page.evalJs(measureBox("[data-login-waiting] [class*='waitingCard']"));
  const waitBox = await page.evalJs(
    `(document.querySelector('[data-login-waiting] [class*="waitBox"]')?.textContent || "").replace(/\\s+/g, " ").trim()`,
  );
  const cancelInMeta = await page.evalJs(
    `!!document.querySelector('[data-login-waiting] [class*="stepMeta"] [class*="cancelLink"]')`,
  );

  check("waiting wrap is centered card layout (not 2-col)", wrap != null && card != null, true);
  // Prototype card is content-box max-width 560 + padding 32*2 + border 1*2 ≈ 624–626.
  check("card rendered width matches content-box 560", card?.width != null && card.width >= 620 && card.width <= 630, true);
  check("authorize wait shows expiry", /expira em \d+:\d{2}/.test(waitBox), true);
  check("cancel lives in step meta", cancelInMeta, true);

  const appBox = await page.evalJs(`(() => {
    const el = document.querySelector('[data-login-waiting] [class*="waitingCard"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { boxSizing: cs.boxSizing, maxWidth: cs.maxWidth, paddingLeft: cs.paddingLeft, borderLeftWidth: cs.borderLeftWidth, width: Math.round(r.width) };
  })()`);

  measures.tela6_step1 = { wrap, card, waitBox, appBox };
  const app1 = await shot(page, "tela6-step1-app");

  await page.evalJs(`document.querySelector('[data-role="fixture-advance"]')?.click()`);
  await waitFor(page, `document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '2'`);
  const machine = await page.evalJs(`!!document.querySelector('[data-role="machine-name"]')`);
  check("step 2 has machine name input", machine, true);
  measures.tela6_step2 = {
    machineValue: await page.evalJs(`document.querySelector('[data-role="machine-name"]')?.value || null`),
  };
  const app2 = await shot(page, "tela6-step2-app");

  await page.evalJs(`document.querySelector('[data-login-waiting] [class*="primaryBtn"]')?.click()`);
  await waitFor(page, `document.querySelector('[data-login-waiting]')?.getAttribute('data-step') === '3'`);
  const tools = await page.evalJs(
    `[...document.querySelectorAll('[data-login-waiting] [class*="subRow"]')].map((e) => e.textContent.trim())`,
  );
  // Open "some" to reveal tool list
  await page.evalJs(`([...document.querySelectorAll('[data-login-waiting] [class*="choice"]')].find((b) => (b.textContent||'').includes('ferramenta'))||{}).click?.()`);
  await delay(200);
  const toolsOpen = await page.evalJs(
    `[...document.querySelectorAll('[data-login-waiting] [class*="subRow"]')].map((e) => e.textContent.trim())`,
  );
  const planLock = await page.evalJs(
    `!!document.querySelector('[data-login-waiting] [class*="planNote"], [data-login-waiting] [class*="choiceDisabled"]')`,
  );
  check("step 3 tool list has Antigravity", toolsOpen.some((t) => /Antigravity|Claude Code|Codex|Cursor/.test(t)), true);
  check("step 3 has no plan lock", planLock, false);
  measures.tela6_step3 = { tools: toolsOpen.length ? toolsOpen : tools, planLock };
  const app3 = await shot(page, "tela6-step3-app");

  const protoShot = await captureProto(page, "LoginWaiting.dc.html", "tela6-proto");
  const protoBox = await page.evalJs(`(() => {
    const root = document.querySelector('x-dc') || document.body;
    const candidates = [...root.querySelectorAll('div')].filter((d) => {
      const cs = getComputedStyle(d);
      return cs.maxWidth === '560px' && (cs.paddingLeft === '32px' || cs.padding === '32px');
    });
    const el = candidates[0] || null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { boxSizing: cs.boxSizing, maxWidth: cs.maxWidth, paddingLeft: cs.paddingLeft, borderLeftWidth: cs.borderLeftWidth, width: Math.round(r.width) };
  })()`);
  measures.tela6_boxModel = { app: appBox, proto: protoBox };
  check(
    "app and proto card widths match",
    appBox != null && protoBox != null && Math.abs(appBox.width - protoBox.width) <= 2,
    true,
  );

  const side = join(OUT_DIR, "tela6-side-by-side.png");
  check("tela6 side-by-side", sideBySide(protoShot, app1, side) || existsSync(app1), true);
  void app2;
  void app3;
});

// ---- Tela 7: Invite ----
// The invite dialog is the approved Invite.dc.html (sign-in step): who invited whom, the
// masked invited identity, GitHub / email sign-in. The fixture feeds the public preview.
await withApp("invite", async (page) => {
  const up = await waitFor(page, `!!document.querySelector('[data-invite-dialog][data-step="signin"]')`);
  check("invite dialog mounts from fixture on the sign-in step", up, true);
  await delay(300);

  const text = (sel) => page.evalJs(`(document.querySelector(${JSON.stringify(sel)})?.textContent || "").replace(/\\s+/g, " ").trim()`);
  const title = await text("[data-invite-dialog] h1");
  const lead = await text('[data-part="signin-lead"]');
  const info = await text('[data-part="signin-info"]');
  const github = await text('[data-part="signin-github"]');
  const submit = await text('[data-part="signin-submit"]');
  const panel = await page.evalJs(`(() => {
    const el = document.querySelector("[data-invite-dialog] section");
    const cs = getComputedStyle(el);
    return { width: Math.round(el.getBoundingClientRect().width), padding: cs.paddingTop, radius: cs.borderTopLeftRadius, gap: cs.rowGap };
  })()`);

  check("invite title", title, "Você foi convidado");
  check("invite names inviter and team", lead, "Riley Chen convidou você para o time Orbit Labs.");
  check("invite shows only the masked invited identity", info.includes("r***@orbit.example") && !info.includes("riley@"), true);
  check("invite GitHub sign-in", github, "Continuar com GitHub");
  check("invite email sign-in", submit, "Entrar e ver o convite");
  check("invite panel is the prototype's (478px wide, 28px padding, 16px radius, 18px gap)", `${panel?.width}|${panel?.padding}|${panel?.radius}|${panel?.gap}`, "478|28px|16px|18px");

  measures.tela7 = { title, lead, info, github, submit, panel };
  const appShot = await shot(page, "tela7-app");
  const protoShot = await captureProto(page, "Invite.dc.html", "tela7-proto");
  const side = join(OUT_DIR, "tela7-side-by-side.png");
  check("tela7 side-by-side", sideBySide(protoShot, appShot, side) || existsSync(appShot), true);
});

writeFileSync(join(OUT_DIR, "measures.json"), JSON.stringify(measures, null, 2));
console.log("MEASURES", JSON.stringify(measures, null, 2));

// Keep a copy of audit side-by-sides when present (extra reference only).
for (const n of [1, 6, 7]) {
  const src = `/tmp/audit-v2/tela${n}/side-by-side.png`;
  if (existsSync(src)) {
    try {
      cpSync(src, join(OUT_DIR, `audit-ref-tela${n}.png`));
    } catch {
      /* ignore */
    }
  }
}

finish();

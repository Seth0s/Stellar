// Dual-ring radial (app-v3 screen 12) — equal-scale proto×app crops.
// Prototype: HTTP + support.js until data-dc-ready (no {{…}} leftovers).
// App: Radial.dc.html mock fixture (5 providers + short quotas). Prints in /tmp/radial-v3/.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootIntoFreshSession,
  connectPage,
  connectPageRaw,
  makeChecker,
  pickFreePort,
  startApp,
  stopApp,
} from "./cdp-client.mjs";

const OUT = "/tmp/radial-v3";
mkdirSync(OUT, { recursive: true });
const PROTO_DIR = fileURLToPath(new URL("../../docs/design/app-v3/prototipo/", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RADIAL_FIXTURE = join(PROJECT_ROOT, "scripts/verify/fixtures/radial-v3.json");
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same clip on both sides — centered on the radial (720, 450). */
const CLIP = { x: 360, y: 90, width: 720, height: 720, scale: 1 };
const VIEW = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

function startStatic(port, root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "Radial.dc.html";
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" });
    res.end(readFileSync(file));
  });
  return {
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    close: () => new Promise((r) => server.close(() => r())),
    origin: `http://127.0.0.1:${port}`,
  };
}

async function waitProtoReady(page) {
  for (let i = 0; i < 100; i++) {
    try {
      const st = JSON.parse(
        await page.evalJs(`JSON.stringify({
          ready: document.documentElement?.getAttribute("data-dc-ready"),
          err: document.documentElement?.getAttribute("data-dc-error"),
          hasMustache: (document.body?.innerText || "").includes("{{"),
          providerCount: document.querySelectorAll('[role="menu"] [role="menuitem"]').length,
          hasClaude: (document.body?.innerText || "").includes("Claude"),
          hasQuota: (document.body?.innerText || "").includes("77% semana"),
          hasGemini: (document.body?.innerText || "").includes("só Gemini"),
          scForLeft: document.querySelectorAll("sc-for").length,
        })`),
      );
      if (
        st.ready === "1" &&
        !st.hasMustache &&
        st.hasClaude &&
        st.hasQuota &&
        st.hasGemini &&
        st.scForLeft === 0 &&
        st.providerCount >= 17
      ) {
        return st;
      }
      if (st.err) throw new Error(st.err);
    } catch (e) {
      if (String(e.message || e).includes("data-dc")) throw e;
    }
    await delay(100);
  }
  throw new Error("prototype data-dc-ready / hydration timeout");
}

async function setViewport(page) {
  await page.send("Emulation.setDeviceMetricsOverride", VIEW);
}

async function shotClip(page, name) {
  const abs = join(OUT, name);
  const res = await page.send("Page.captureScreenshot", { format: "png", clip: CLIP });
  writeFileSync(abs, Buffer.from(res.data, "base64"));
  return abs;
}

async function shotFull(page, name) {
  const abs = join(OUT, name);
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(abs, Buffer.from(res.data, "base64"));
  return abs;
}

function sideBySide(left, right, outName) {
  const out = join(OUT, outName);
  execFileSync("magick", [left, right, "+append", "-background", "#05060a", "-gravity", "North", out], { stdio: "pipe" });
  return out;
}

async function measure(page, selectors) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return { missing: true, selector: sel };
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            "font-size": cs.fontSize,
            "font-weight": cs.fontWeight,
            "background-color": cs.backgroundColor,
            "border-color": cs.borderColor,
            "border-style": cs.borderStyle,
            width: cs.width,
            height: cs.height,
            text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 100),
          };
        };
        const out = {};
        for (const [k, sel] of Object.entries(${JSON.stringify(selectors)})) out[k] = pick(sel);
        return JSON.stringify(out);
      })()
    `),
  );
}

const staticPort = await pickFreePort();
const staticSrv = startStatic(staticPort, PROTO_DIR);
await staticSrv.listen();

const protoUser = mkdtempSync(join(tmpdir(), "stellar-radial-proto-"));
const appUser = mkdtempSync(join(tmpdir(), "stellar-radial-app-"));
const protoCdp = await pickFreePort();
const appCdp = await pickFreePort();

let protoApp;
let app;

try {
  // ---- Prototype (hydrated) ----
  protoApp = await startApp({ cdpPort: protoCdp, userDataDir: protoUser, preserveUserData: true, isolatedHome: true });
  const protoPage = await connectPageRaw(protoCdp);
  await protoPage.send("Page.enable");
  await setViewport(protoPage);
  await protoPage.send("Page.navigate", { url: `${staticSrv.origin}/Radial.dc.html` });
  const protoReady = await waitProtoReady(protoPage);
  check("proto hydrated (data-dc-ready)", protoReady.ready === "1", true);
  check("proto has no {{ mustache }}", protoReady.hasMustache, false);
  check("proto shows Claude + 77% semana", protoReady.hasClaude && protoReady.hasQuota, true);
  check(
    "proto provider arc nodes (≥5 menuitems beyond tools/spawns)",
    protoReady.providerCount >= 12,
    true,
  );

  const protoClosed = await shotClip(protoPage, "proto-closed.png");
  // Closed: hide the menu chrome by navigating… prototype always shows open.
  // Capture "closed" as the empty board chrome of the app only; for proto,
  // snapshot the page with menu (open is the designed resting state).
  const protoOpen = await shotClip(protoPage, "proto-open.png");
  await shotFull(protoPage, "proto-open-full.png");

  // Hover Navegador on proto via real CDP pointer (synthetic mouseenter does not fire onMouseEnter handlers).
  const protoNavPt = JSON.parse(
    await protoPage.evalJs(`(() => {
      const btns = [...document.querySelectorAll('[role="menuitem"]')];
      const nav = btns.find((b) => (b.getAttribute("aria-label") || "").includes("Navegador"));
      if (!nav) return JSON.stringify(null);
      const r = nav.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  if (!protoNavPt) throw new Error("proto Navegador menuitem not found");
  await protoPage.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: protoNavPt.x,
    y: protoNavPt.y,
    pointerType: "mouse",
  });
  await delay(250);
  check(
    "proto hover: hub Navegador",
    await protoPage.evalJs(`(document.querySelector('[aria-live="polite"]')?.textContent || "").includes("Navegador")`),
    true,
  );
  const protoHover = await shotClip(protoPage, "proto-hover.png");

  // Back to agent / providers (default state already has sub open)
  const protoAgentPt = JSON.parse(
    await protoPage.evalJs(`(() => {
      const btns = [...document.querySelectorAll('[role="menuitem"]')];
      const agent = btns.find((b) => (b.getAttribute("aria-label") || "").includes("Agente"));
      if (!agent) return JSON.stringify(null);
      const r = agent.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  if (!protoAgentPt) throw new Error("proto Agente menuitem not found");
  await protoPage.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: protoAgentPt.x,
    y: protoAgentPt.y,
    pointerType: "mouse",
  });
  await delay(200);
  await protoPage.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: protoAgentPt.x,
    y: protoAgentPt.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await protoPage.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: protoAgentPt.x,
    y: protoAgentPt.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await delay(250);
  const protoProviders = await shotClip(protoPage, "proto-providers.png");

  const protoMeas = await measure(protoPage, {
    hub: '[aria-live="polite"]',
    footer: "footer",
  });
  writeFileSync(join(OUT, "proto-styles.json"), JSON.stringify(protoMeas, null, 2));

  // ---- App with mock fixture via main IPC (STELLAR_RADIAL_FIXTURE) ----
  app = await startApp({
    cdpPort: appCdp,
    userDataDir: appUser,
    isolatedHome: true,
    extraEnv: { STELLAR_RADIAL_FIXTURE: RADIAL_FIXTURE },
  });
  const page = await connectPage(appCdp);
  await delay(800);
  await bootIntoFreshSession(page, "Radial v3 parity", { spawnTerminal: false });
  await setViewport(page);
  await delay(300);

  let ipcFixture = null;
  for (let i = 0; i < 50; i++) {
    ipcFixture = JSON.parse(
      await page.evalJs(`
        (async () => {
          try {
            const f = await window.system.getRadialFixture();
            return JSON.stringify(f);
          } catch (e) {
            return JSON.stringify({ error: String(e && e.message ? e.message : e) });
          }
        })()
      `),
    );
    if (ipcFixture && ipcFixture.defaultProviderId === "claude" && Array.isArray(ipcFixture.providers)) break;
    await delay(100);
  }
  check("fixture via IPC (not window global)", ipcFixture?.defaultProviderId, "claude");
  check("fixture has 5 providers", ipcFixture?.providers?.length, 5);
  check(
    "loose window global ignored in production renderer",
    await page.evalJs(`(() => {
      window.__stellarRadialFixture = { defaultProviderId: "evil", providers: [] };
      return true;
    })()`),
    true,
  );

  await shotClip(page, "app-closed.png");
  await shotFull(page, "app-closed-full.png");
  check("closed: no radial", await page.evalJs(`!document.querySelector(".radial-menu")`), true);

  await page.evalJs(`window.__stellarOpenRadial(720, 450)`);
  // Wait for RadialMenu to apply the async IPC fixture (hub Claude, 5 providers).
  for (let i = 0; i < 40; i++) {
    const ready = await page.evalJs(`
      document.querySelectorAll("[data-radial-provider]").length === 5 &&
      (document.querySelector(".radial-hub-label")?.textContent || "").trim() === "Claude"
    `);
    if (ready) break;
    await delay(50);
  }

  check("open: menu present", await page.evalJs(`!!document.querySelector(".radial-menu")`), true);
  check("open: hub 112", await page.evalJs(`Math.round(document.querySelector(".radial-hub")?.getBoundingClientRect().width || 0)`), 112);
  check("open: outer 360", await page.evalJs(`Math.round(document.querySelector(".radial-ring--outer")?.getBoundingClientRect().width || 0)`), 360);
  check("open: 5 mock providers", await page.evalJs(`document.querySelectorAll("[data-radial-provider]").length`), 5);
  check(
    "open: hub is Claude",
    await page.evalJs(`(document.querySelector(".radial-hub-label")?.textContent || "").trim()`),
    "Claude",
  );
  check(
    "open: short Antigravity quota",
    await page.evalJs(`([...document.querySelectorAll("[data-radial-provider]")].some((b) => {
      const wrap = b.parentElement;
      const q = wrap?.querySelector(".radial-quota")?.textContent || "";
      return b.getAttribute("data-radial-provider") === "antigravity" && q === "só Gemini";
    }))`),
    true,
  );
  check(
    "open: footer omits right-click",
    await page.evalJs(`!(document.querySelector(".radial-footer")?.textContent || "").includes("botão direito")`),
    true,
  );
  check(
    "open: provider angles stay in arc (Codex not above Claude)",
    await page.evalJs(`(() => {
      const claude = document.querySelector('[data-radial-provider="claude"]')?.getBoundingClientRect();
      const codex = document.querySelector('[data-radial-provider="codex"]')?.getBoundingClientRect();
      if (!claude || !codex) return false;
      // With −40…+40, Claude (first) is above-left; Codex (last) is above-right — similar Y.
      return Math.abs(claude.y - codex.y) < 40;
    })()`),
    true,
  );

  const openMeas = await measure(page, {
    outerRing: ".radial-ring--outer",
    innerDashedRing: ".radial-ring--inner",
    centerHub: ".radial-hub",
    centerLabel: ".radial-hub-label",
    footer: ".radial-footer",
  });
  writeFileSync(join(OUT, "app-open-styles.json"), JSON.stringify(openMeas, null, 2));

  const appOpen = await shotClip(page, "app-open.png");
  await shotFull(page, "app-open-full.png");

  const browserPt = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('[data-radial-id="browser"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: browserPt.x, y: browserPt.y, pointerType: "mouse" });
  await delay(250);
  check(
    "hover: hub Navegador",
    await page.evalJs(`(document.querySelector(".radial-hub-label")?.textContent || "").includes("Navegador")`),
    true,
  );
  const appHover = await shotClip(page, "app-hover.png");

  const agentPt = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('[data-radial-id="agent"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: agentPt.x, y: agentPt.y, pointerType: "mouse" });
  await delay(250);
  check(
    "providers: hub Claude again",
    await page.evalJs(`(document.querySelector(".radial-hub-label")?.textContent || "").trim()`),
    "Claude",
  );
  const appProviders = await shotClip(page, "app-providers.png");

  // Side-by-sides — same clip size, deviceScaleFactor 1 both sides
  sideBySide(protoOpen, appOpen, "side-by-side-open.png");
  sideBySide(protoHover, appHover, "side-by-side-hover.png");
  sideBySide(protoProviders, appProviders, "side-by-side-providers.png");
  // Closed: prototype has no designed closed state — hide every radial chrome
  // (menu, hub, pin, rings, veil, footer) and keep the dotted board only.
  await protoPage.evalJs(`(() => {
    const root = document.querySelector("[data-dc-root]") || document.body;
    for (const el of root.querySelectorAll("*")) {
      const role = el.getAttribute("role");
      const live = el.getAttribute("aria-live");
      const tag = el.tagName.toLowerCase();
      if (role === "menu" || live === "polite" || tag === "footer") {
        el.style.visibility = "hidden";
        continue;
      }
      // Concentric rings + pin + dark veil are aria-hidden decorative siblings.
      if (el.getAttribute("aria-hidden") === "true") {
        const st = el.getAttribute("style") || "";
        if (/border-radius:\\s*50%/.test(st) || /radial-gradient\\(circle at 720px/.test(st) || /width:\\s*8px/.test(st)) {
          el.style.visibility = "hidden";
        }
      }
    }
  })()`);
  await delay(100);
  const protoClosedReal = await shotClip(protoPage, "proto-closed.png");
  sideBySide(protoClosedReal, join(OUT, "app-closed.png"), "side-by-side-closed.png");

  const rows = ["outerRing", "innerDashedRing", "centerHub", "centerLabel", "footer"].map((key) => {
    const a = openMeas[key] || {};
    const p =
      key === "centerHub"
        ? protoMeas.hub || {}
        : key === "footer"
          ? protoMeas.footer || {}
          : {};
    return {
      element: key,
      proto_w: p.width ?? null,
      app_w: a.width ?? null,
      proto_h: p.height ?? null,
      app_h: a.height ?? null,
      proto_bg: p["background-color"] ?? null,
      app_bg: a["background-color"] ?? null,
      proto_fs: p["font-size"] ?? null,
      app_fs: a["font-size"] ?? null,
      proto_border: p["border-color"] ?? null,
      app_border: a["border-color"] ?? null,
      proto_text: p.text ?? null,
      app_text: a.text ?? null,
    };
  });
  writeFileSync(join(OUT, "parity-table.json"), JSON.stringify(rows, null, 2));
  writeFileSync(
    join(OUT, "parity-summary.json"),
    JSON.stringify(
      {
        openShot: join(OUT, "app-open.png"),
        hoverShot: join(OUT, "app-hover.png"),
        providersShot: join(OUT, "app-providers.png"),
        closedShot: join(OUT, "app-closed.png"),
        sideBySide: {
          open: join(OUT, "side-by-side-open.png"),
          hover: join(OUT, "side-by-side-hover.png"),
          providers: join(OUT, "side-by-side-providers.png"),
          closed: join(OUT, "side-by-side-closed.png"),
        },
        clip: CLIP,
        deviceScaleFactor: 1,
        hubWidth: openMeas.centerHub?.rect?.width ?? 112,
        outerWidth: openMeas.outerRing?.rect?.width ?? 360,
        innerWidth: openMeas.innerDashedRing?.rect?.width ?? 190,
        hubLabel: openMeas.centerLabel?.text ?? null,
        styles: openMeas,
        protoHub: protoMeas.hub,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(OUT, "parity-table.md"),
    [
      "| element | proto | app |",
      "|---|---|---|",
      `| hub | ${protoMeas.hub?.width} / ${protoMeas.hub?.text} | ${openMeas.centerHub?.width} / ${openMeas.centerLabel?.text} |`,
      `| clip | ${CLIP.width}×${CLIP.height} @ dsf=1 | ${CLIP.width}×${CLIP.height} @ dsf=1 |`,
      `| providers | 5 mock | ${5} mock fixture |`,
    ].join("\n") + "\n",
  );

  page.close();
  protoPage.close();
} finally {
  if (app) await stopApp(app);
  if (protoApp) await stopApp(protoApp);
  await staticSrv.close();
  try {
    rmSync(protoUser, { recursive: true, force: true });
    rmSync(appUser, { recursive: true, force: true });
  } catch {
    /* */
  }
}
finish();

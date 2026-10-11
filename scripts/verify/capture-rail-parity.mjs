/**
 * Capture Rail proto × app at CSS 1:1 (deviceScaleFactor 1, zoom 1).
 * Asserts strip=56 / panel=384 on both sides. Seeds Claude Code for terminal2.
 * Writes /tmp/rail-v3/side-by-side-*.png
 */
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const OUT = "/tmp/rail-v3";
const PROTO_DIR = fileURLToPath(new URL("../../docs/design/app-v3/prototipo/", import.meta.url));
const STEPS = ["collapsed", "tools", "add", "terminal1", "terminal2", "cards", "pen", "ai"];
const MOCK_CWD = "~/Workplace/Projects/Stellar";
fs.mkdirSync(OUT, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function startStaticServer(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\//, "") || "Rail.dc.html";
      const file = path.join(dir, rel);
      if (!file.startsWith(dir) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      const ext = path.extname(file);
      const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function forceScale1(page) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.evalJs(`document.body.style.zoom = "1"`);
  await delay(100);
}

async function measureApp(page) {
  return await page.evalJs(`window.__stellarRail?.measureDock()`);
}

async function captureAppClip(page, file) {
  const clip = await page.evalJs(`
    (() => {
      const el = document.querySelector('[data-role="rail-dock"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: Math.min(900, r.height) };
    })()
  `);
  if (!clip) throw new Error("no rail dock clip");
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: { ...clip, scale: 1 },
  });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return clip;
}

function captureProtoWithElectron(port) {
  const script = `
    const { app, BrowserWindow, screen } = require("electron");
    const fs = require("fs");
    const path = require("path");
    const OUT = ${JSON.stringify(OUT)};
    const PROTO_DIR = ${JSON.stringify(PROTO_DIR)};
    const PORT = ${port};
    const STEPS = ${JSON.stringify(STEPS)};
    const base = fs.readFileSync(path.join(PROTO_DIR, "Rail.dc.html"), "utf8");
    app.commandLine.appendSwitch("force-device-scale-factor", "1");
    app.whenReady().then(async () => {
      const win = new BrowserWindow({
        width: 440,
        height: 900,
        useContentSize: true,
        show: false,
        webPreferences: { offscreen: true, zoomFactor: 1 },
      });
      for (const step of STEPS) {
        const html = base.replace('"default":"tools"', '"default":"' + step + '"');
        const name = "_tmp-Rail-" + step + ".dc.html";
        const tmp = path.join(PROTO_DIR, name);
        fs.writeFileSync(tmp, html);
        await win.loadURL("http://127.0.0.1:" + PORT + "/" + name);
        await new Promise((r) => setTimeout(r, 700));
        await win.webContents.setZoomFactor(1);
        const m = await win.webContents.executeJavaScript(\`
          (() => {
            const root = document.querySelector("[data-dc-root]") || document.querySelector("x-dc") || document.body;
            const nav = document.querySelector("nav[aria-label]");
            const panel = document.querySelector("section[aria-label]");
            const r = (el) => el ? (() => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height }; })() : null;
            return { dpr: window.devicePixelRatio, nav: r(nav), panel: r(panel), root: r(root.firstElementChild || root) };
          })()
        \`);
        fs.writeFileSync(path.join(OUT, "proto-measure-" + step + ".json"), JSON.stringify(m, null, 2));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, "proto-" + step + ".png"), img.toPNG());
        try { fs.unlinkSync(tmp); } catch {}
        console.log("PROTO", step, JSON.stringify(m));
      }
      app.quit();
    });
  `;
  const tmpJs = path.join(OUT, "_capture-proto-tmp.cjs");
  fs.writeFileSync(tmpJs, script);
  const r = spawnSync(path.join(process.cwd(), "node_modules/.bin/electron"), [tmpJs], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ELECTRON_FORCE_IS_PACKAGED: undefined },
  });
  console.log(r.stdout);
  if (r.status !== 0) console.error(r.stderr);
  try {
    fs.unlinkSync(tmpJs);
  } catch {
    /* ignore */
  }
}

function composeSideBySide(protoPath, appPath, outPath, label) {
  const py = `
from PIL import Image, ImageDraw
proto = Image.open(${JSON.stringify(protoPath)}).convert("RGB")
app = Image.open(${JSON.stringify(appPath)}).convert("RGB")
# Force both to CSS 440×900 crop (top-left) — deviceScaleFactor 1 should already match
def crop440(im):
    w, h = im.size
    return im.crop((0, 0, min(440, w), min(900, h)))
proto, app = crop440(proto), crop440(app)
gap, lh = 16, 28
canvas = Image.new("RGB", (proto.width + app.width + gap, max(proto.height, app.height) + lh), (12, 14, 18))
d = ImageDraw.Draw(canvas)
d.text((8, 6), "proto · ${label}", fill=(180, 190, 210))
d.text((proto.width + gap + 8, 6), "app · ${label}", fill=(180, 190, 210))
canvas.paste(proto, (0, lh))
canvas.paste(app, (proto.width + gap, lh))
canvas.save(${JSON.stringify(outPath)})
print(canvas.size, "proto", proto.size, "app", app.size)
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  console.log(r.stdout.trim());
}

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = path.join(OUT, `userdata-${Date.now()}`);
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const { server: protoServer, port: protoPort } = await startStaticServer(PROTO_DIR);
captureProtoWithElectron(protoPort);

const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraArgs: ["--force-device-scale-factor=1"],
});
const { check, finish } = makeChecker();
const measurements = { proto: {}, app: {} };

try {
  const page = await connectPage(CDP_PORT);
  await delay(800);
  await bootIntoFreshSession(page);
  await delay(600);
  await forceScale1(page);

  const screenshots = [];

  for (const step of STEPS) {
    if (step === "terminal2") {
      await page.evalJs(`
        window.__stellarRail?.seedTerminal2({
          providerId: "claude",
          providerLabel: "Claude Code",
          cwd: ${JSON.stringify(MOCK_CWD)},
          model: "Sonnet 5.5",
          effort: "alto",
          session: "new",
          systemPrompt: "",
        })
      `);
    } else {
      await page.evalJs(`window.__stellarRail?.setStep(${JSON.stringify(step)})`);
    }
    await delay(350);

    const m = await measureApp(page);
    measurements.app[step] = m;
    console.log("APP", step, JSON.stringify(m));

    const stripW = m?.strip?.width;
    const panelW = m?.panel?.width;
    if (step === "collapsed") {
      check(`${step}: strip CSS width ≈ 56`, Math.abs((stripW ?? 0) - 56) < 1, true);
      check(`${step}: panel absent`, panelW == null, true);
      check(`${step}: dpr ≈ 1`, Math.abs((m?.dpr ?? 0) - 1) < 0.02, true);
    } else {
      check(`${step}: strip CSS width ≈ 56`, Math.abs((stripW ?? 0) - 56) < 1, true);
      check(`${step}: panel CSS width ≈ 384`, Math.abs((panelW ?? 0) - 384) < 1, true);
      check(`${step}: dpr ≈ 1`, Math.abs((m?.dpr ?? 0) - 1) < 0.02, true);
    }

    if (step === "terminal2") {
      const form = await page.evalJs(`
        (() => {
          const panel = document.querySelector('[data-role="rail-panel"]');
          if (!panel) return null;
          const text = panel.innerText || "";
          const folder = panel.querySelector("input")?.value || "";
          const selects = [...panel.querySelectorAll("select")].map((s) => s.value);
          const radios = [...panel.querySelectorAll('input[type="radio"]')].map((r) => ({ checked: r.checked, label: r.parentElement?.textContent?.trim() }));
          const ta = panel.querySelector("textarea");
          return { text, folder, selects, radios, hasTextarea: !!ta, back: /Claude Code/.test(text) };
        })()
      `);
      check("terminal2 back breadcrumb is Claude Code", form?.back, true);
      check("terminal2 folder is mock path", form?.folder, MOCK_CWD);
      check("terminal2 has model+effort selects", (form?.selects?.length ?? 0) >= 2, true);
      check("terminal2 has session radios", (form?.radios?.length ?? 0) >= 3, true);
      check("terminal2 has instructions textarea", form?.hasTextarea, true);
      measurements.app.terminal2Form = form;
    }

    const appFile = path.join(OUT, `app-${step}.png`);
    await captureAppClip(page, appFile);

    const protoFile = path.join(OUT, `proto-${step}.png`);
    const protoMeasure = JSON.parse(fs.readFileSync(path.join(OUT, `proto-measure-${step}.json`), "utf8"));
    measurements.proto[step] = protoMeasure;
    if (step !== "collapsed") {
      check(`proto ${step}: nav ≈ 56`, Math.abs((protoMeasure.nav?.w ?? 0) - 56) < 1.5, true);
      check(`proto ${step}: panel ≈ 384`, Math.abs((protoMeasure.panel?.w ?? 0) - 384) < 1.5, true);
    } else {
      check(`proto ${step}: nav ≈ 56`, Math.abs((protoMeasure.nav?.w ?? 0) - 56) < 1.5, true);
    }

    const sbs = path.join(OUT, `side-by-side-${step}.png`);
    composeSideBySide(protoFile, appFile, sbs, step);
    screenshots.push(sbs);
  }

  fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify(measurements, null, 2));
  fs.writeFileSync(path.join(OUT, "screenshots.json"), JSON.stringify(screenshots, null, 2));
  console.log("screenshots:\n" + screenshots.join("\n"));
  finish();
} finally {
  await stopApp(app);
  protoServer.close();
}

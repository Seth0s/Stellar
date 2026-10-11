/**
 * Isolated smoke for docked Rail V3 (app-v3 screens 9–10).
 * Own userData + CDP port — never the owner's instance.
 * Captures at deviceScaleFactor 1 / zoom 1; terminal2 seeds Claude Code.
 * Screenshots → /tmp/rail-v3/
 */
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-rail-v3-${Date.now()}-${Math.random()}`, import.meta.url).pathname;
const OUT = "/tmp/rail-v3";
const PROTO_DIR = fileURLToPath(new URL("../../docs/design/app-v3/prototipo/", import.meta.url));
const MOCK_CWD = "~/Workplace/Projects/Stellar";
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const STEPS = ["collapsed", "tools", "add", "terminal1", "terminal2", "cards", "pen", "ai"];

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

async function captureClip(page, clip, file) {
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
  });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

async function dockClip(page) {
  return await page.evalJs(`
    (() => {
      const el = document.querySelector('[data-role="rail-dock"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: Math.min(900, r.height) };
    })()
  `);
}

function captureProtoWithElectron() {
  const electronBin = path.join(process.cwd(), "node_modules/.bin/electron");
  const script = path.join(process.cwd(), "scripts/verify/capture-rail-proto-steps.cjs");
  const r = spawnSync(electronBin, [script, PROTO_DIR, OUT], {
    encoding: "utf8",
    timeout: 90000,
    env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
  });
  console.log(r.stdout || "(no proto stdout)");
  if (r.stderr) console.error(r.stderr.slice(-800));
  if (r.status !== 0 && r.status !== null) throw new Error(`proto electron capture exited ${r.status}`);
  if (r.error) throw r.error;
  for (const step of STEPS) {
    const png = path.join(OUT, `proto-${step}.png`);
    const measure = path.join(OUT, `proto-measure-${step}.json`);
    if (!fs.existsSync(png) || !fs.existsSync(measure)) {
      throw new Error(`proto capture missing artifacts for ${step}`);
    }
  }
}

function composeSideBySide(protoPath, appPath, outPath, label) {
  const py = `
from PIL import Image, ImageDraw
proto = Image.open(${JSON.stringify(protoPath)}).convert("RGB")
app = Image.open(${JSON.stringify(appPath)}).convert("RGB")
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

captureProtoWithElectron();

const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraArgs: ["--force-device-scale-factor=1"],
});
const { check, finish } = makeChecker();
const measurements = { proto: {}, app: {} };

try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page);
  await delay(800);
  await forceScale1(page);

  check("docked rail mounted", await page.evalJs(`!!document.querySelector('[data-role="rail-dock"]')`), true);
  check("board-viewport exists", await page.evalJs(`!!document.querySelector('.board-viewport')`), true);

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
    } else if (step === "terminal1") {
      await page.evalJs(`window.__stellarRail?.seedTerminal1()`);
    } else if (step === "cards") {
      await page.evalJs(`window.__stellarRail?.seedCardsFind()`);
      await page.evalJs(`document.activeElement?.blur?.()`);
    } else {
      await page.evalJs(`window.__stellarRail?.setStep(${JSON.stringify(step)})`);
    }
    await delay(400);
    const got = await page.evalJs(`window.__stellarRail?.getStep()`);
    check(`rail step ${step}`, got, step);

    const m = await page.evalJs(`window.__stellarRail?.measureDock()`);
    measurements.app[step] = m;
    console.log("APP", step, JSON.stringify(m));

    const stripW = m?.strip?.width;
    const panelW = m?.panel?.width;
    check(`${step}: dpr ≈ 1`, Math.abs((m?.dpr ?? 0) - 1) < 0.02, true);
    check(`${step}: strip CSS width ≈ 56`, Math.abs((stripW ?? 0) - 56) < 1, true);
    if (step === "collapsed") {
      check(`${step}: panel absent`, panelW == null, true);
    } else {
      check(`${step}: panel CSS width ≈ 384`, Math.abs((panelW ?? 0) - 384) < 1, true);
    }

    if (step === "terminal2") {
      const form = await page.evalJs(`
        (() => {
          const panel = document.querySelector('[data-role="rail-panel"]');
          if (!panel) return null;
          const text = panel.innerText || "";
          const folder = panel.querySelector("input")?.value || "";
          const selects = [...panel.querySelectorAll("select")].map((s) => ({
            value: s.value,
            options: [...s.options].map((o) => o.textContent.trim()),
          }));
          const radios = [...panel.querySelectorAll('input[type="radio"]')].map((r) => ({
            checked: r.checked,
            label: r.parentElement?.textContent?.trim(),
          }));
          const ta = panel.querySelector("textarea");
          return {
            back: /Claude Code/.test(text),
            folder,
            selects,
            radios,
            hasTextarea: !!ta,
            effortShowsAlto: selects.some((s) => s.options.includes("alto") && (s.value === "high" || s.value === "alto")),
          };
        })()
      `);
      check("terminal2 back is Claude Code", form?.back, true);
      check("terminal2 folder mock path", form?.folder, MOCK_CWD);
      check("terminal2 has model+effort", (form?.selects?.length ?? 0) >= 2, true);
      check("terminal2 effort shows alto", form?.effortShowsAlto, true);
      check("terminal2 has session radios", (form?.radios?.length ?? 0) >= 3, true);
      check("terminal2 has instructions", form?.hasTextarea, true);
      measurements.app.terminal2Form = form;
    }

    if (step === "terminal1") {
      const rows = await page.evalJs(`
        (() => {
          const panel = document.querySelector('[data-role="rail-panel"]');
          const labels = [...panel.querySelectorAll("button")].map((b) => b.innerText.replace(/\\s+/g, " ").trim());
          return {
            count: labels.length,
            hasClaude: labels.some((l) => /Claude Code/.test(l)),
            has77: labels.some((l) => /77%/.test(l)),
            hasBash: labels.some((l) => /bash/i.test(l)),
            labels,
          };
        })()
      `);
      check("terminal1 has Claude Code + 77%", rows?.hasClaude && rows?.has77, true);
      check("terminal1 has bash row", rows?.hasBash, true);
      check("terminal1 ≥ 5 provider rows", (rows?.count ?? 0) >= 5, true);
      measurements.app.terminal1Rows = rows;
    }

    if (step === "cards") {
      const find = await page.evalJs(`
        (() => {
          const list = document.querySelector('[data-role="rail-find-list"]');
          const items = [...(list?.querySelectorAll("button") || [])].map((b) => b.innerText.replace(/\\s+/g, " ").trim());
          const align = window.__stellarRail?.measureCardsAlign?.();
          return { count: items.length, items, align };
        })()
      `);
      check("cards mock has 6 rows", find?.count, 6);
      check("cards has IMPL · Claude", find?.items?.some((l) => /IMPL · Claude/.test(l)), true);
      check("cards has Fila 14 tasks", find?.items?.some((l) => /Fila/.test(l) && /14 tasks/.test(l)), true);
      check("cards has Nota · feedbacks", find?.items?.some((l) => /Nota · feedbacks/.test(l)), true);
      check("cards session aligns with field (Δx≈0)", Math.abs(find?.align?.sessionDelta ?? 99) < 1.5, true);
      check("cards tip aligns with field (Δx≈0)", Math.abs(find?.align?.tipDelta ?? 99) < 1.5, true);
      const sessionLabel = await page.evalJs(
        `document.querySelector('[data-role="rail-find-session"]')?.textContent?.trim()`,
      );
      check("cards session label · 9 (proto)", /·\s*9/.test(sessionLabel || ""), true);
      measurements.app.cardsFind = find;
    }

    const clip = await dockClip(page);
    check(`dock clip for ${step}`, !!clip && clip.width > 0, true);
    const appFile = path.join(OUT, `app-${step}.png`);
    await captureClip(page, clip, appFile);

    const protoFile = path.join(OUT, `proto-${step}.png`);
    const protoMeasurePath = path.join(OUT, `proto-measure-${step}.json`);
    if (fs.existsSync(protoMeasurePath)) {
      const protoMeasure = JSON.parse(fs.readFileSync(protoMeasurePath, "utf8"));
      measurements.proto[step] = protoMeasure;
      check(`proto ${step}: nav ≈ 56`, Math.abs((protoMeasure.nav?.w ?? 0) - 56) < 1.5, true);
      if (step !== "collapsed") {
        check(`proto ${step}: panel ≈ 384`, Math.abs((protoMeasure.panel?.w ?? 0) - 384) < 1.5, true);
      }
    }

    const sbs = path.join(OUT, `side-by-side-${step}.png`);
    if (fs.existsSync(protoFile)) composeSideBySide(protoFile, appFile, sbs, step);
    else fs.copyFileSync(appFile, sbs);
    screenshots.push(sbs);
  }

  // RailPassos-style grid
  const gridOut = path.join(OUT, "app-rail-passos-grid.png");
  const appFiles = STEPS.map((s) => path.join(OUT, `app-${s}.png`)).filter((f) => fs.existsSync(f));
  if (appFiles.length === 8) {
    const r = spawnSync(
      "magick",
      [...appFiles.slice(0, 4), "+append", ...appFiles.slice(4), "+append", "-append", gridOut],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      spawnSync("convert", [...appFiles.slice(0, 4), "+append", "null:", ...appFiles.slice(4), "+append", "-append", gridOut]);
    }
    if (fs.existsSync(gridOut)) screenshots.push(gridOut);
  }

  await page.evalJs(`window.__stellarRail?.setStep("add")`);
  await delay(200);
  await page.evalJs(`document.querySelector('[data-role="rail-panel"] [data-kind="files"]')?.click()`);
  await delay(500);
  check("files card spawned from docked panel", await page.evalJs(`!!document.querySelector(".files-card")`), true);

  await page.evalJs(`window.__stellarRail?.setStep("collapsed")`);
  await delay(300);
  const leftCollapsed = await page.evalJs(`document.querySelector(".board-viewport")?.getBoundingClientRect().left`);
  check("board left ≈ 56 when collapsed", Math.abs(leftCollapsed - 56) < 3, true);

  await page.evalJs(`window.__stellarRail?.setStep("tools")`);
  await delay(300);
  const leftOpen = await page.evalJs(`document.querySelector(".board-viewport")?.getBoundingClientRect().left`);
  check("board left ≈ 440 when open", Math.abs(leftOpen - 440) < 3, true);

  // Glyph paths from prototype (Conector / AI / Agrupar)
  const glyphs = await page.evalJs(`
    (() => {
      const dock = document.querySelector('[data-role="rail-dock"]');
      const paths = [...dock.querySelectorAll("svg")].map((svg) => ({
        html: svg.outerHTML.slice(0, 200),
      }));
      const joined = dock.innerHTML;
      return {
        connector: joined.includes('cx="4" cy="14"') && joined.includes('cx="14" cy="4"'),
        aiStar: joined.includes("M9 2l1.6 4.4L15 8l-4.4 1.6L9 14"),
        groupRects: joined.includes('x="2" y="2" width="6" height="6"') && joined.includes('x="10" y="10" width="6" height="6"'),
        sampleCount: paths.length,
      };
    })()
  `);
  check("connector glyph is two-dot line", glyphs?.connector, true);
  check("AI glyph is four-point star", glyphs?.aiStar, true);
  check("group glyph is two offset squares", glyphs?.groupRects, true);

  // Pointer highlight: only tools when open; collapsed reflects real tool (proto Rail.dc.html:165).
  async function stripOns() {
    return await page.evalJs(`
      (() => {
        const strip = document.querySelector('[data-role="rail-dock"] .rail');
        const by = (aria) => [...strip.querySelectorAll("button.rail-btn")].find((b) => (b.getAttribute("aria-label") || "") === aria);
        const isOn = (b) => !!b && /navBtnOn/.test(b.className);
        return {
          pointer: isOn(by("Ponteiro (V)") || by("Pointer (V)")),
          pen: isOn(by("Caneta (P)") || by("Pen (P)")),
          add: isOn(by("Novo card") || by("New card")),
          find: isOn(by("Achar card (Ctrl F)") || by("Find card (Ctrl F)")),
          ai: isOn(by("Ações de IA") || by("AI actions")),
        };
      })()
    `);
  }
  await page.evalJs(`window.__stellarRail?.setStep("add")`);
  await delay(200);
  let ons = await stripOns();
  check("add step: pointer off", ons?.pointer, false);
  check("add step: add on", ons?.add, true);

  await page.evalJs(`window.__stellarRail?.setStep("ai")`);
  await delay(200);
  ons = await stripOns();
  check("ai step: pointer off", ons?.pointer, false);
  check("ai step: ai on", ons?.ai, true);

  await page.evalJs(`window.__stellarRail?.setStep("tools")`);
  await delay(200);
  ons = await stripOns();
  check("tools step: pointer on", ons?.pointer, true);

  await page.evalJs(`window.__stellarRail?.setStep("collapsed")`);
  await delay(200);
  // default tool is pointer → lit when collapsed
  ons = await stripOns();
  check("collapsed: pointer on (real tool)", ons?.pointer, true);

  fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify(measurements, null, 2));
  fs.writeFileSync(path.join(OUT, "screenshots.json"), JSON.stringify(screenshots, null, 2));
  console.log("screenshots:\n" + screenshots.join("\n"));

  finish();
} finally {
  await stopApp(app);
}

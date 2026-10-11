/**
 * Capture each Rail.dc.html step at deviceScaleFactor 1 → OUT/proto-*.png
 * Usage: electron capture-rail-proto-steps.cjs <protoDir> <outDir>
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const PROTO_DIR = process.argv[2];
const OUT = process.argv[3] || "/tmp/rail-v3";
const STEPS = ["collapsed", "tools", "add", "terminal1", "terminal2", "cards", "pen", "ai"];

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ozone-platform-hint", "x11");
app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const base = fs.readFileSync(path.join(PROTO_DIR, "Rail.dc.html"), "utf8");
    fs.copyFileSync(path.join(PROTO_DIR, "support.js"), path.join(OUT, "support.js"));
    const win = new BrowserWindow({
      width: 440,
      height: 900,
      useContentSize: true,
      show: false,
      webPreferences: { offscreen: true, zoomFactor: 1 },
    });

    for (const step of STEPS) {
      const html = base.replace('"default":"tools"', `"default":"${step}"`);
      const tmp = path.join(OUT, `_proto-${step}.html`);
      fs.writeFileSync(tmp, html);
      await win.loadFile(tmp);
      await new Promise((r) => setTimeout(r, 600));
      await win.webContents.setZoomFactor(1);
      const m = await win.webContents.executeJavaScript(`(() => {
        const nav = document.querySelector("nav[aria-label]");
        const panel = document.querySelector("section[aria-label]");
        const r = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { w: b.width, h: b.height };
        };
        return { dpr: window.devicePixelRatio, nav: r(nav), panel: r(panel) };
      })()`);
      fs.writeFileSync(path.join(OUT, `proto-measure-${step}.json`), JSON.stringify(m, null, 2));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `proto-${step}.png`), img.toPNG());
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      console.log("PROTO", step, JSON.stringify(m));
    }
    app.quit();
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });

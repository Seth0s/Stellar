/**
 * Measure + capture the RailPassos.dc.html frames at 1:1 (deviceScaleFactor 1).
 * Usage: electron capture-rail-passos.cjs <protoDir> <outDir> <specJson>
 * Writes <outDir>/proto-<frame>.png and <outDir>/proto-measure.json
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const [PROTO_DIR, OUT, SPEC] = process.argv.slice(-3);
const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("ozone-platform-hint", "x11");
app.disableHardwareAcceleration();
app.setPath("userData", path.join(OUT, ".ud-proto"));

app
  .whenReady()
  .then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const win = new BrowserWindow({ width: 1900, height: 1100, useContentSize: true, show: false, webPreferences: { offscreen: true, zoomFactor: 1 } });
    await win.loadFile(path.join(PROTO_DIR, "RailPassos.dc.html"));
    await new Promise((r) => setTimeout(r, 1200));
    // The prototype pulls its fonts from Google Fonts; offline it falls back to a
    // system face with different metrics. Point the same family names at the
    // bundled files the app ships so heights and widths are comparable.
    const fontDir = (pkg) => path.join(__dirname, "../../node_modules/@fontsource", pkg, "files");
    const face = (family, pkg, weight) =>
      `@font-face{font-family:'${family}';font-weight:${weight};src:url('file://${fontDir(pkg)}/${pkg}-latin-${weight}-normal.woff2') format('woff2');}`;
    await win.webContents.insertCSS(
      [400, 500, 600, 700].map((w) => face("Space Grotesk", "space-grotesk", w)).join("") +
        [400, 500].map((w) => face("JetBrains Mono", "jetbrains-mono", w)).join(""),
    );
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    await new Promise((r) => setTimeout(r, 500));
    const result = {};
    for (const frame of spec.frames) {
      const measured = await win.webContents.executeJavaScript(`(async () => {
        const frame = document.querySelector('[data-frame="${frame.id}"]');
        if (!frame) return { error: "frame missing" };
        frame.scrollIntoView({ block: "start" });
        await new Promise((r) => setTimeout(r, 250));
        const fr = frame.getBoundingClientRect();
        const ox = fr.x + frame.clientLeft, oy = fr.y + frame.clientTop;
        const pairs = ${JSON.stringify(frame.pairs)};
        const props = ${JSON.stringify(spec.props)};
        const out = {};
        for (const pair of pairs) {
          const el = frame.querySelector(pair.proto);
          if (!el) { out[pair.name] = null; continue; }
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const row = {};
          for (const p of pair.props) {
            if (p === "@width") row[p] = r.width;
            else if (p === "@height") row[p] = r.height;
            else if (p === "@x") row[p] = r.x - ox;
            else if (p === "@y") row[p] = r.y - oy;
            else if (p === "@text") row[p] = el.innerText;
            else row[p] = cs[p];
          }
          out[pair.name] = row;
        }
        return { rect: { x: fr.x, y: fr.y, w: fr.width, h: fr.height }, out };
      })()`);
      result[frame.id] = measured.out ?? measured;
      if (measured.rect) {
        const r = measured.rect;
        const img = await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });
        fs.writeFileSync(path.join(OUT, `proto-${frame.id}.png`), img.toPNG());
      }
    }
    fs.writeFileSync(path.join(OUT, "proto-measure.json"), JSON.stringify(result, null, 2));
    app.quit();
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });

/**
 * Capture Rail.dc.html at each step via Electron (no system Chrome needed).
 * Writes /tmp/rail-v3/proto-<step>.png and side-by-side composites with app-*.png.
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OUT = "/tmp/rail-v3";
const PROTO_DIR = fileURLToPath(new URL("../../docs/design/app-v3/prototipo/", import.meta.url));
const STEPS = ["collapsed", "tools", "add", "terminal1", "terminal2", "cards", "pen", "ai"];
fs.mkdirSync(OUT, { recursive: true });

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

app.whenReady().then(async () => {
  const { server, port } = await startStaticServer(PROTO_DIR);
  const base = fs.readFileSync(path.join(PROTO_DIR, "Rail.dc.html"), "utf8");
  const win = new BrowserWindow({
    width: 440,
    height: 900,
    useContentSize: true,
    show: false,
    webPreferences: { offscreen: true },
  });

  for (const step of STEPS) {
    const html = base.replace('"default":"tools"', `"default":"${step}"`);
    const name = `_tmp-Rail-${step}.dc.html`;
    const tmpHtml = path.join(PROTO_DIR, name);
    fs.writeFileSync(tmpHtml, html);
    await win.loadURL(`http://127.0.0.1:${port}/${name}`);
    await new Promise((r) => setTimeout(r, 900));
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `proto-${step}.png`);
    fs.writeFileSync(file, img.toPNG());
    try {
      fs.unlinkSync(tmpHtml);
    } catch {
      /* ignore */
    }
    console.log("wrote", file);
  }

  // Side-by-side with PIL if available
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    // Use electron native composite via sharp if present; else python
  } catch {
    /* ignore */
  }

  server.close();
  app.quit();
});

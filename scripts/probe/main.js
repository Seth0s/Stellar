// Sonda independente (NÃO é o Stellar): responde empiricamente, nesta máquina e
// sessão Wayland, se `contentView.addChildView(WebContentsView)` compõe de
// verdade na janela principal — a rota abandonada em 2026-08-26
// (DESIGN-BACKLOG.md item 9, comentário em src/main/browser-registry.ts).
//
// Método: janela hospedeira com fundo de cor improvável (#1A0518) + 3
// WebContentsView filhas com cores-assinatura puras (magenta/ciano/verde),
// screenshot da TELA REAL via portal XDG (NÃO capturePage — a história
// registra, e esta sonda reconfirma, que capturePage da hospedeira não
// compõe WebContentsView: usar capturePage pra verificar seria falso
// negativo garantido). Verificação por contagem global + bounding box:
// uma cor-assinatura só conta como "composta" se seu bbox estiver DENTRO do
// bbox da janela hospedeira — elimina ruído do resto da tela do usuário.
// Sequência: baseline sem views → views adicionadas → repaint forçado
// (invalidate/DOM change) → move+recolor. Cada etapa com screenshot próprio.
//
// Depois: micro-benchmark do pipeline offscreen atual (toJPEG vs toBitmap)
// e da transferência de bitmap cru via MessageChannelMain/webContents.send
// (a premissa "ArrayBuffer transferível = zero-copy" é TESTADA, não assumida).
//
// Roda com userData próprio em /tmp — app separado, sem lock compartilhado
// com a instância do dono. Ver README.md.

const { app, BrowserWindow, WebContentsView, nativeImage, MessageChannelMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const OZONE = process.env.PROBE_OZONE || "wayland";
app.commandLine.appendSwitch("ozone-platform", OZONE);
app.commandLine.appendSwitch("no-first-run");
app.setPath("userData", `/tmp/stellar-probe-userdata-${OZONE}`);

const OUT = path.join(__dirname, "out", OZONE);
fs.mkdirSync(OUT, { recursive: true });
const log = (msg) => console.error(`[probe ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST_COLOR = "#1A0518";
const COLORS = {
  magenta: [255, 0, 255],
  cyan: [0, 255, 255],
  green: [0, 255, 0],
  orange: [255, 128, 0],
};
const CSS = { magenta: "#FF00FF", cyan: "#00FFFF", green: "#00FF00", orange: "#FF8000" };

function page(color, label) {
  return (
    "data:text/html,<html><body style=\"margin:0;background:" +
    color +
    ";width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;font:bold 64px sans-serif;color:#000\">" +
    label +
    "</body></html>"
  );
}

function portalShot(file) {
  return new Promise((resolve, reject) => {
    execFile("python3", [path.join(__dirname, "portal_screenshot.py"), file], (err, stdout, stderr) => {
      if (err) reject(new Error(`portal screenshot falhou: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

function importShot(file) {
  return new Promise((resolve, reject) => {
    execFile("import", ["-window", "root", file], (err) => (err ? reject(err) : resolve(file)));
  });
}

async function screenShot(name) {
  const file = path.join(OUT, name);
  if (OZONE === "x11") await importShot(file);
  else await portalShot(file);
  return nativeImage.createFromPath(file);
}

function matches(r, g, b, target) {
  return Math.abs(r - target[0]) < 40 && Math.abs(g - target[1]) < 40 && Math.abs(b - target[2]) < 40;
}

// Contagem + bbox de cada cor-assinatura (amostrando 1 a cada 4px, BGRA).
function scan(img) {
  const { width, height } = img.getSize();
  const bmp = img.getBitmap();
  const out = { shotSize: `${width}x${height}`, colors: {} };
  const host = [0x1a, 0x05, 0x18];
  const init = () => ({ count: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 });
  out.colors.host = init();
  for (const k of Object.keys(COLORS)) out.colors[k] = init();
  for (let i = 0; i + 2 < bmp.length; i += 16) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
    const px = (i / 4) % width;
    const py = Math.floor(i / 4 / width);
    let hit = null;
    if (matches(r, g, b, host)) hit = "host";
    else for (const [k, c] of Object.entries(COLORS)) if (matches(r, g, b, c)) { hit = k; break; }
    if (hit) {
      const s = out.colors[hit];
      s.count++;
      if (px < s.minX) s.minX = px;
      if (px > s.maxX) s.maxX = px;
      if (py < s.minY) s.minY = py;
      if (py > s.maxY) s.maxY = py;
    }
  }
  for (const s of Object.values(out.colors)) {
    if (s.count === 0) { s.minX = s.minY = s.maxX = s.maxY = null; }
  }
  return out;
}

// Uma cor "compõe" se tem área significativa E seu bbox está dentro do bbox
// da hospedeira (com folga pras bordas amostradas).
const MIN_SAMPLED = 4000; // ~64k px reais; uma view de 440x280 amostra ~31k
function composedInsideHost(scanResult, color) {
  const h = scanResult.colors.host;
  const c = scanResult.colors[color];
  if (!h || h.count === 0) return { composed: c.count > MIN_SAMPLED, contained: null, count: c.count };
  const contained =
    c.count > 0 && c.minX >= h.minX - 8 && c.maxX <= h.maxX + 8 && c.minY >= h.minY - 8 && c.maxY <= h.maxY + 8;
  return { composed: c.count > MIN_SAMPLED && contained, contained, count: c.count };
}

const result = {
  ozone: OZONE,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: `${process.platform} ${process.arch}`,
  sessionType: process.env.XDG_SESSION_TYPE || null,
};

async function run() {
  const win = new BrowserWindow({
    x: 150,
    y: 100,
    width: 1000,
    height: 700,
    alwaysOnTop: true,
    backgroundColor: HOST_COLOR,
    title: "stellar-probe",
  });
  await win.loadURL(page(HOST_COLOR, ""));
  await sleep(1500);

  // Baseline: tela SEM as views (ruído do desktop do usuário medido, não
  // assumido zero).
  const shot0 = await screenShot("shot0-baseline-sem-views.png");
  result.shot0baseline = scan(shot0);
  log("baseline ok");

  const v1 = new WebContentsView();
  const v2 = new WebContentsView();
  const v3 = new WebContentsView();
  win.contentView.addChildView(v1);
  win.contentView.addChildView(v2);
  win.contentView.addChildView(v3);
  v1.setBounds({ x: 40, y: 40, width: 440, height: 280 });
  v2.setBounds({ x: 520, y: 40, width: 440, height: 280 });
  v3.setBounds({ x: 40, y: 360, width: 440, height: 280 });
  await Promise.all([
    v1.webContents.loadURL(page(CSS.magenta, "V1")),
    v2.webContents.loadURL(page(CSS.cyan, "V2")),
    v3.webContents.loadURL(page(CSS.green, "V3")),
  ]);
  await sleep(2500);

  const shot1 = await screenShot("shot1-tres-views.png");
  result.shot1viewsAdded = scan(shot1);
  result.initialComposite = {
    magenta: composedInsideHost(result.shot1viewsAdded, "magenta"),
    cyan: composedInsideHost(result.shot1viewsAdded, "cyan"),
    green: composedInsideHost(result.shot1viewsAdded, "green"),
  };
  log(`shot1: ${JSON.stringify(result.initialComposite)}`);

  // A armadilha histórica, reconfirmada: capturePage da hospedeira.
  const hostCapture = await win.capturePage();
  fs.writeFileSync(path.join(OUT, "capture1-host-capturePage.png"), hostCapture.toPNG());
  result.hostCapturePage = scan(hostCapture).colors;

  // A view pinta INTERNAMENTE? (em 2026-08-26 pintava — CDP no target dela)
  const v1cap = await v1.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "capture1-v1-interna.png"), v1cap.toPNG());
  result.v1InternalPaint = { size: v1cap.getSize(), magenta: scan(v1cap).colors.magenta.count };

  // Repaint forçado sem mudar cor: v1 via invalidate(), v2 via mutação DOM.
  v1.webContents.invalidate();
  await v2.webContents.executeJavaScript(
    `document.body.appendChild(document.createElement('div')).textContent = 'repaint';`
  );
  await sleep(1200);
  const shot2 = await screenShot("shot2-repaint-forcado.png");
  result.shot2forcedRepaint = scan(shot2);
  result.repaintUnsticks = {
    magentaInvalidate: composedInsideHost(result.shot2forcedRepaint, "magenta"),
    cyanDomChange: composedInsideHost(result.shot2forcedRepaint, "cyan"),
  };
  log(`shot2: ${JSON.stringify(result.repaintUnsticks)}`);

  // Dinâmica estilo board: move v1, recolore v3.
  v1.setBounds({ x: 500, y: 380, width: 460, height: 280 });
  await v3.webContents.executeJavaScript(
    `document.body.style.background = '${CSS.orange}'; document.body.textContent = 'V3*';`
  );
  await sleep(1200);
  const shot3 = await screenShot("shot3-movida-recolorida.png");
  result.shot3movedRecolored = scan(shot3);
  result.dynamicMoveOk = composedInsideHost(result.shot3movedRecolored, "magenta");
  result.dynamicRepaintOk = composedInsideHost(result.shot3movedRecolored, "orange");
  log(`shot3: move=${JSON.stringify(result.dynamicMoveOk)} repaint=${JSON.stringify(result.dynamicRepaintOk)}`);

  // ---- Micro-benchmark do pipeline offscreen atual (rota alternativa) ----
  log("benchmark offscreen: subindo janela oculta 1500x950");
  const off = new BrowserWindow({
    show: false,
    width: 1500,
    height: 950,
    webPreferences: { offscreen: true },
  });
  off.webContents.setFrameRate(30);
  // Repintura do frame INTEIRO sem depender de rAF (rAF é throttled em
  // página oculta): setInterval mudando estilo de um div full-viewport +
  // animação CSS composited (gradiente girando) por cima.
  await off.loadURL(
    "data:text/html,<div id=d style='position:fixed;inset:0'></div>" +
      "<div style='position:fixed;inset:0;background:conic-gradient(from 0deg,#f00,#0f0,#00f,#f00);animation:s 1s linear infinite;mix-blend-mode:multiply'></div>" +
      "<style>@keyframes s{to{filter:hue-rotate(360deg)}}</style>" +
      "<script>let i=0;setInterval(()=>{const d=document.getElementById('d');" +
      "d.style.background='hsl('+((i+=7)%360)+',80%,50%)';d.textContent='frame '+i;" +
      "d.style.font='bold 200px sans-serif';},33);</script>"
  );
  const frames = [];
  const t0bench = Date.now();
  let gotPaint = false;
  await new Promise((resolve) => {
    off.webContents.on("paint", (event, dirty, image) => {
      if (!gotPaint) { gotPaint = true; log("benchmark: primeiro paint chegou"); }
      const t0 = performance.now();
      const jpeg = image.toJPEG(90);
      const t1 = performance.now();
      const bitmap = image.toBitmap();
      const t2 = performance.now();
      frames.push({
        dirtyArea: dirty.width * dirty.height,
        jpegMs: t1 - t0,
        toBitmapMs: t2 - t1,
        jpegBytes: jpeg.length,
        bitmapBytes: bitmap.length,
      });
      if (Date.now() - t0bench > 4000) resolve();
    });
    setTimeout(() => { if (!gotPaint) log("benchmark: TIMEOUT sem paint"); resolve(); }, 12000);
  });
  log(`benchmark: ${frames.length} frames em ${Date.now() - t0bench}ms`);
  const n = frames.length;
  if (n > 0) {
    const avg = (k) => frames.reduce((a, f) => a + f[k], 0) / n;
    result.offscreenPipeline = {
      frames: n,
      windowMs: Date.now() - t0bench,
      avgDirtyArea: Math.round(avg("dirtyArea")),
      avgToJpeg90Ms: +avg("jpegMs").toFixed(2),
      avgToBitmapMs: +avg("toBitmapMs").toFixed(2),
      avgJpegBytes: Math.round(avg("jpegBytes")),
      bitmapBytes: frames[n - 1].bitmapBytes,
    };
  } else {
    result.offscreenPipeline = { frames: 0, note: "nenhum paint em 12s — janela offscreen oculta sem BeginFrame nesta config" };
  }

  // ---- Transferência de bitmap cru: a premissa "transferível" testada ----
  await win.webContents.executeJavaScript(`
    window.__last = null;
    window.addEventListener('message', (e) => {
      if (e.data === 'take-port') {
        window.__port = e.ports[0];
        window.__port.onmessage = (ev) => {
          window.__last = { bytes: ev.data && ev.data.buf ? ev.data.buf.byteLength : -1 };
          window.__port.postMessage({ ack: window.__last.bytes });
        };
      }
    });
    true;
  `);
  const raw = nativeImage
    .createFromBitmap(Buffer.alloc(1500 * 950 * 4, 7), { width: 1500, height: 950 })
    .toBitmap();
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

  // (a) Tentativa de TRANSFER real de ArrayBuffer — na primeira rodada da
  // sonda isto lançou "Port at index 0 is not a valid port"; re-testado aqui
  // de forma controlada pra constar como evidência, não exceção.
  const transferTest = { bytes: raw.length };
  {
    const { port1, port2 } = new MessageChannelMain();
    win.webContents.postMessage("take-port", "take-port", [port2]);
    port1.start();
    await sleep(400);
    try {
      const ab2 = ab.slice(0); // cópia descartável (a original pode destacar)
      port1.postMessage({ buf: ab2 }, [ab2]);
      const ack = await Promise.race([
        new Promise((res) => port1.once("message", (e) => res(e.data))),
        sleep(4000).then(() => null),
      ]);
      transferTest.supported = true;
      transferTest.detachedAfterPost = ab2.byteLength === 0;
      transferTest.ackBytes = ack && ack.ack;
    } catch (err) {
      transferTest.supported = false;
      transferTest.error = String(err && err.message ? err.message : err);
    }
    port1.close();
  }
  // (b) Sem transfer: structured clone (cópia) — mede o custo real da rota.
  {
    const { port1, port2 } = new MessageChannelMain();
    win.webContents.postMessage("take-port", "take-port", [port2]);
    port1.start();
    await sleep(400);
    const t0 = performance.now();
    port1.postMessage({ buf: ab });
    const ack = await Promise.race([
      new Promise((res) => port1.once("message", (e) => res(e.data))),
      sleep(4000).then(() => null),
    ]);
    const t1 = performance.now();
    transferTest.cloneRoundTripMs = +(t1 - t0).toFixed(2);
    transferTest.cloneAckBytes = ack && ack.ack;
    port1.close();
  }
  // (c) A rota ATUAL do Stellar: webContents.send com Buffer.
  {
    await win.webContents.executeJavaScript(`
      window.__ipcBytes = -1;
      require && 0; // sem nodeIntegration; usa evento do port abaixo
      true;
    `).catch(() => {});
    // Sem preload não há ipcRenderer na página data:; mede só o custo do
    // lado main (serialização síncrona na thread principal é o que importa
    // pro sintoma medido de 98,9%).
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) win.webContents.send("probe-frame", raw);
    const t1 = performance.now();
    transferTest.ipcSend30FramesMainThreadMs = +(t1 - t0).toFixed(2);
  }
  result.rawBitmapRoutes = transferTest;

  off.destroy();
  console.log("PROBE_RESULT " + JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  app.quit();
}

app.whenReady().then(run).catch((err) => {
  console.error("PROBE_ERROR", err);
  result.fatal = String(err && err.stack ? err.stack : err);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  app.exit(3);
});

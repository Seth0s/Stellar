/**
 * Sonda 4 — recorte por área suja, utility process de verdade, distribuição
 * real de dano.
 *
 * Duas perguntas que as sondas 1–3 (docs/PERF.md) não responderam:
 *
 * 1) `browser-registry.ts:642` já recebe `dirty` no `paint` e só o usa pra
 *    descartar frame de área zero (`hasDirtyArea`). O frame INTEIRO é
 *    encodado sempre. Se `image.crop(dirty).toJPEG(90)` custar proporcional
 *    à área, uma barra de progresso ou um cursor piscando passam a custar
 *    quase nada — e é isso que uma UI real faz a maior parte do tempo.
 *    Mas só vale a pena se o dano REAL for pequeno na prática: medimos os
 *    dois lados, custo-por-área E distribuição de área suja, em três
 *    páginas (cheia-animada = pior caso, cursor piscando, barra de
 *    progresso).
 *
 * 2) A ideia de mover o encode pra um `utilityProcess` parecia ganho óbvio.
 *    A sonda 3 (`bitmap-route.js`, commit 00f511c) já mediu que bitmap cru
 *    por CLONE ESTRUTURADO pra outra JANELA custa mais (5,95 ms de thread
 *    principal) que o JPEG atual (5,31 ms) — porque não existe bitmap
 *    transferível na API (`MessagePortMain.postMessage`, electron.d.ts:9704,
 *    só aceita portas no array de transfer). Mas aquela sonda usou uma
 *    JANELA como receptor, não um `utilityProcess` de verdade — o pedido
 *    desta sonda é confirmar com o real: `UtilityProcess.postMessage`
 *    (electron.d.ts:15701) tem a MESMA assinatura
 *    `(message: any, transfer?: MessagePortMain[])`, então a mesma restrição
 *    deveria valer, mas "deveria" não é medição. Testamos aqui, e checamos
 *    de brinde se `nativeImage` sequer existe dentro de um utility process
 *    (se não existir, mover o ENCODE pra lá — não só o bitmap — exige um
 *    encoder JPEG puro-JS/WASM, achado à parte).
 *
 * Roda com userData próprio em /tmp — app separado, sem lock com a
 * instância do dono. Ver scripts/probe/README.md.
 *
 *   node_modules/.bin/electron scripts/probe/encode-route.js
 */
const { app, BrowserWindow, utilityProcess } = require("electron");
const fs = require("fs");
const path = require("path");

app.commandLine.appendSwitch("no-first-run");
app.setPath("userData", "/tmp/stellar-probe-userdata-encode-route");

const OUT = path.join(__dirname, "out", "encode-route");
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => console.error(`[encode-route] ${m}`);
const now = () => performance.now();
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------------------------------------------------------------------
// Três páginas offscreen, mesmo tamanho de card real (720x560, igual
// browser-registry.ts:create). Cada uma testa um regime de dano diferente.
// ---------------------------------------------------------------------

// `#` num literal de data: URI é lido como início de fragmento (a parte
// depois dele nunca chega ao parser HTML) — as sondas anteriores escapam
// disso evitando cor hex inline; aqui há CSS demais pra evitar `#` à mão,
// então cada página passa por `encodeURIComponent` antes de virar data URI.
const toDataUrl = (html) => "data:text/html," + encodeURIComponent(html);

// Pior caso já medido nas sondas 1/3: repaint de tela cheia sem depender de
// rAF (throttled em janela oculta).
const FULL_ANIMATE = toDataUrl(
  "<div id=d style='position:fixed;inset:0;font:bold 200px sans-serif'></div>" +
  "<script>let i=0;setInterval(()=>{const d=document.getElementById('d');" +
  "d.style.background='hsl('+((i+=7)%360)+',80%,50%)';d.textContent='f'+i;},33);<\/script>"
);

// Caso comum: bastante conteúdo estático (texto real, não um retângulo liso
// — JPEG de área lisa é otimista demais) + um cursor de texto piscando
// (20x40px) numa posição fixa. É o padrão de "alguém digitando" ou "campo
// com foco parado".
const BLINK_CURSOR = toDataUrl(
  "<body style='margin:0;font:16px monospace;padding:24px;line-height:1.6;background:#fff'>" +
  Array.from({ length: 40 }, (_, i) => `<div>linha ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod</div>`).join("") +
  "<div id=cur style='position:absolute;left:120px;top:60px;width:10px;height:20px;background:#000'></div>" +
  "<script>let on=true;setInterval(()=>{on=!on;document.getElementById('cur').style.background=on?'#000':'#fff';},500);<\/script>" +
  "</body>"
);

// Caso comum 2: barra de progresso enchendo, 400x24, sobre um fundo estático
// com bastante detalhe (mesmo bloco de texto do cursor).
const PROGRESS_BAR = toDataUrl(
  "<body style='margin:0;font:16px monospace;padding:24px;line-height:1.6;background:#fff'>" +
  Array.from({ length: 40 }, (_, i) => `<div>linha ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod</div>`).join("") +
  "<div style='position:absolute;left:160px;top:480px;width:400px;height:24px;border:1px solid #333'>" +
  "<div id=bar style='height:100%;width:0;background:#2a6df4'></div></div>" +
  "<script>let w=0;setInterval(()=>{w=(w+3)%400;document.getElementById('bar').style.width=w+'px';},60);<\/script>" +
  "</body>"
);

// UM ÚNICO BrowserWindow offscreen é reaproveitado (navegado com `loadURL`
// de novo) entre cenários, em vez de criar+destruir uma janela por cenário.
// Achado ao vivo escrevendo esta sonda: criar e `destroy()`ar janelas
// offscreen em sequência rápida, nesta máquina, derruba o processo inteiro
// sem nenhum evento JS (nem `render-process-gone`) — sem stack, sem catch,
// `app.quit()` nunca roda, o processo só morre. Reaproveitar a janela evita
// o gatilho e não muda o que está sendo medido (o custo é do pipeline de
// paint, não da janela em si).
async function collectFrames(off, html, ms, maxFrames) {
  await off.loadURL(html);
  const frames = [];
  await new Promise((resolve) => {
    const t0 = Date.now();
    const onPaint = (_e, dirty, image) => {
      frames.push({ dirty: { x: dirty.x, y: dirty.y, width: dirty.width, height: dirty.height }, image });
      if (frames.length >= maxFrames || Date.now() - t0 > ms) { off.webContents.off("paint", onPaint); resolve(); }
    };
    off.webContents.on("paint", onPaint);
    setTimeout(() => { off.webContents.off("paint", onPaint); resolve(); }, ms + 5000);
  });
  return frames;
}

function dirtyHistogram(frames, frameArea) {
  const buckets = [
    { label: "<1%", max: 0.01, n: 0 },
    { label: "1-5%", max: 0.05, n: 0 },
    { label: "5-15%", max: 0.15, n: 0 },
    { label: "15-40%", max: 0.4, n: 0 },
    { label: "40-90%", max: 0.9, n: 0 },
    { label: "90-100%", max: 1.01, n: 0 },
  ];
  for (const f of frames) {
    const frac = (f.dirty.width * f.dirty.height) / frameArea;
    for (const b of buckets) {
      if (frac <= b.max) { b.n++; break; }
    }
  }
  return {
    frames: frames.length,
    frameArea,
    buckets: buckets.map((b) => ({ label: b.label, n: b.n, pct: +((100 * b.n) / frames.length).toFixed(1) })),
    avgDirtyFrac: +((avg(frames.map((f) => f.dirty.width * f.dirty.height)) / frameArea) * 100).toFixed(1),
  };
}

// Custo de crop+encode do retângulo REAL que o paint entregou, contra o
// frame inteiro — nas páginas onde o dano é de fato pequeno.
function measureRealDirtyCropCost(frames) {
  const rows = [];
  for (const f of frames) {
    const { width, height } = f.image.getSize();
    const fullT0 = now();
    const fullJpeg = f.image.toJPEG(90);
    const fullMs = now() - fullT0;

    let cropMs = null, cropJpegBytes = null, cropErr = null;
    if (f.dirty.width > 0 && f.dirty.height > 0) {
      try {
        const t0 = now();
        const cropped = f.image.crop(f.dirty);
        const jpeg = cropped.toJPEG(90);
        cropMs = now() - t0;
        cropJpegBytes = jpeg.length;
      } catch (e) {
        cropErr = String((e && e.message) || e);
      }
    }
    rows.push({
      dirtyArea: f.dirty.width * f.dirty.height,
      dirtyFracPct: +((100 * f.dirty.width * f.dirty.height) / (width * height)).toFixed(2),
      fullFrameMs: +fullMs.toFixed(3),
      fullFrameBytes: fullJpeg.length,
      cropMs: cropMs === null ? null : +cropMs.toFixed(3),
      cropBytes: cropJpegBytes,
      cropErr,
    });
  }
  return rows;
}

// Curva custo × área: recorta o MESMO frame em quadrados de fração
// crescente da área total, ancorados no canto superior esquerdo — isola "o
// crop escala com a área" de "o paint reporta um dirty pequeno de verdade".
function measureAreaScalingCurve(image) {
  const { width, height } = image.getSize();
  const fractions = [1, 0.75, 0.5, 0.25, 0.1, 0.05, 0.01];
  const shapes = [
    { label: "cursor-20x40", rect: { x: 0, y: 0, width: Math.min(20, width), height: Math.min(40, height) } },
    { label: "progressbar-400x24", rect: { x: 0, y: 0, width: Math.min(400, width), height: Math.min(24, height) } },
    { label: "toolbar-720x48", rect: { x: 0, y: 0, width: Math.min(width, 720), height: Math.min(48, height) } },
  ];
  const rows = [];
  for (const frac of fractions) {
    const w = Math.max(1, Math.round(width * Math.sqrt(frac)));
    const h = Math.max(1, Math.round(height * Math.sqrt(frac)));
    const rect = { x: 0, y: 0, width: Math.min(w, width), height: Math.min(h, height) };
    const REPS = 8;
    const times = [];
    let bytes = 0;
    for (let i = 0; i < REPS; i++) {
      const t0 = now();
      const cropped = frac === 1 ? image : image.crop(rect);
      const jpeg = cropped.toJPEG(90);
      times.push(now() - t0);
      bytes = jpeg.length;
    }
    rows.push({ shape: `square-${Math.round(frac * 100)}%`, rectArea: rect.width * rect.height, fracOfFrame: +(((rect.width * rect.height) / (width * height)) * 100).toFixed(2), avgMs: +avg(times).toFixed(3), bytes });
  }
  for (const s of shapes) {
    const REPS = 8;
    const times = [];
    let bytes = 0;
    for (let i = 0; i < REPS; i++) {
      const t0 = now();
      const cropped = image.crop(s.rect);
      const jpeg = cropped.toJPEG(90);
      times.push(now() - t0);
      bytes = jpeg.length;
    }
    rows.push({ shape: s.label, rectArea: s.rect.width * s.rect.height, fracOfFrame: +(((s.rect.width * s.rect.height) / (width * height)) * 100).toFixed(2), avgMs: +avg(times).toFixed(3), bytes });
  }
  return rows;
}

// ---------------------------------------------------------------------
// utilityProcess de verdade: mesmo teste da sonda 3 (bitmapCopy), mas o
// receptor é um UtilityProcess real, não uma BrowserWindow. Mede: (a) se
// `nativeImage` existe lá dentro (então o ENCODE, não só o bitmap, poderia
// rodar fora da main thread); (b) o custo real de thread principal do
// `postMessage` com o bitmap cru, igual sonda 3; (c) round-trip.
// ---------------------------------------------------------------------
const WORKER_SRC = `
// NAO e require("electron").parentPort -- dentro de um utility process isso
// e undefined (o modulo 'electron' la dentro so expoe net e
// systemPreferences, medido ao vivo escrevendo esta sonda). A porta pro
// processo pai e process.parentPort (electron.d.ts:26736..26738,
// documentado em process, nao no modulo 'electron').
const parentPort = process.parentPort;
let nativeImage = null;
let nativeImageAvailable = false;
let nativeImageError = null;
try {
  nativeImage = require("electron").nativeImage;
  nativeImageAvailable = !!(nativeImage && typeof nativeImage.createFromBitmap === "function");
} catch (e) {
  nativeImageError = String((e && e.message) || e);
}
if (nativeImageAvailable) {
  try {
    const probe = nativeImage.createFromBitmap(Buffer.alloc(4 * 4 * 4, 200), { width: 4, height: 4 });
    probe.toJPEG(90);
  } catch (e) {
    nativeImageAvailable = false;
    nativeImageError = String((e && e.message) || e);
  }
}
parentPort.postMessage({ type: "ready", nativeImageAvailable, nativeImageError });
parentPort.on("message", (e) => {
  const { seq, buf, width, height } = e.data;
  let jpegBytes = null, encodeMs = null, error = null;
  if (nativeImageAvailable) {
    try {
      const t0 = performance.now();
      const img = nativeImage.createFromBitmap(buf, { width, height });
      const jpeg = img.toJPEG(90);
      encodeMs = performance.now() - t0;
      jpegBytes = jpeg.length;
    } catch (e) {
      error = String((e && e.message) || e);
    }
  }
  parentPort.postMessage({ type: "ack", seq, bytesReceived: buf.length, jpegBytes, encodeMs, error });
});
`;

async function measureUtilityProcess(frames) {
  const workerPath = path.join(OUT, "utility-worker.js");
  fs.writeFileSync(workerPath, WORKER_SRC);
  const child = utilityProcess.fork(workerPath, [], { stdio: "pipe" });
  child.stdout?.on("data", (d) => log(`[utility stdout] ${d.toString().trim()}`));
  child.stderr?.on("data", (d) => log(`[utility stderr] ${d.toString().trim()}`));

  const readyInfo = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("utilityProcess não respondeu 'ready' em 8s")), 8000);
    child.once("message", (m) => {
      if (m && m.type === "ready") { clearTimeout(t); resolve(m); }
    });
  });
  log(`utilityProcess ready: ${JSON.stringify(readyInfo)}`);

  const acks = new Map();
  child.on("message", (m) => {
    if (m && m.type === "ack") {
      const r = acks.get(m.seq);
      if (r) r(m);
    }
  });

  const rows = [];
  for (let i = 0; i < frames.length; i++) {
    const image = frames[i].image;
    const { width, height } = image.getSize();
    const bmp = image.toBitmap();

    const t0 = now();
    const p = new Promise((res) => acks.set(i, res));
    child.postMessage({ seq: i, buf: bmp, width, height });
    // Este é o número que decide: quanto a thread principal ficou presa no
    // postMessage em si (clone estruturado síncrono do lado de quem envia
    // — mesma metodologia da sonda 3).
    const postMs = now() - t0;
    const ack = await Promise.race([
      p,
      new Promise((res) => setTimeout(() => res(null), 5000)),
    ]);
    const roundTripMs = now() - t0;

    rows.push({
      toBitmapPlusPostMs: +postMs.toFixed(3),
      roundTripMs: ack ? +roundTripMs.toFixed(3) : null,
      bitmapBytes: bmp.length,
      remoteEncodeMs: ack ? ack.encodeMs : null,
      remoteJpegBytes: ack ? ack.jpegBytes : null,
      remoteError: ack ? ack.error : "sem ack em 5s",
    });
  }
  child.kill();
  return { nativeImageAvailable: readyInfo.nativeImageAvailable, nativeImageError: readyInfo.nativeImageError, rows };
}

const result = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };

async function run() {
  const off = new BrowserWindow({ show: false, width: 720, height: 560, webPreferences: { offscreen: true } });
  off.webContents.setFrameRate(30);

  log("coletando página animada em tela cheia (pior caso)...");
  const fullFrames = await collectFrames(off, FULL_ANIMATE, 6000, 15);
  log(`full-animate: ${fullFrames.length} frames`);

  log("coletando página com cursor piscando (dano pequeno, fixo)...");
  const cursorFrames = await collectFrames(off, BLINK_CURSOR, 8000, 10);
  log(`blink-cursor: ${cursorFrames.length} frames`);

  log("coletando página com barra de progresso (dano pequeno, móvel)...");
  const barFrames = await collectFrames(off, PROGRESS_BAR, 8000, 10);
  log(`progress-bar: ${barFrames.length} frames`);

  if (fullFrames.length === 0) throw new Error("nenhum frame em full-animate — sem baseline pra medir");

  const frameArea = 720 * 560;
  result.dirtyDistribution = {
    fullAnimate: dirtyHistogram(fullFrames, frameArea),
    blinkCursor: cursorFrames.length ? dirtyHistogram(cursorFrames, frameArea) : { frames: 0, note: "sem paints — cursor não gerou repaint capturado" },
    progressBar: barFrames.length ? dirtyHistogram(barFrames, frameArea) : { frames: 0, note: "sem paints" },
  };
  log(`distribuição full-animate: ${JSON.stringify(result.dirtyDistribution.fullAnimate.buckets)}`);
  if (cursorFrames.length) log(`distribuição blink-cursor: ${JSON.stringify(result.dirtyDistribution.blinkCursor.buckets)}`);
  if (barFrames.length) log(`distribuição progress-bar: ${JSON.stringify(result.dirtyDistribution.progressBar.buckets)}`);

  result.realDirtyCropCost = {
    blinkCursor: cursorFrames.length ? measureRealDirtyCropCost(cursorFrames) : [],
    progressBar: barFrames.length ? measureRealDirtyCropCost(barFrames) : [],
    fullAnimate: measureRealDirtyCropCost(fullFrames.slice(0, 5)),
  };

  log("medindo curva custo×área (recortes sintéticos sobre frame full-animate)...");
  result.areaScalingCurve = measureAreaScalingCurve(fullFrames[Math.floor(fullFrames.length / 2)].image);
  log(`curva: ${JSON.stringify(result.areaScalingCurve)}`);

  log("medindo utilityProcess de verdade...");
  result.utilityProcess = await measureUtilityProcess(fullFrames.slice(0, 8));
  log(`utilityProcess nativeImageAvailable=${result.utilityProcess.nativeImageAvailable} err=${result.utilityProcess.nativeImageError}`);
  const avgPost = avg(result.utilityProcess.rows.map((r) => r.toBitmapPlusPostMs));
  const gotRT = result.utilityProcess.rows.filter((r) => r.roundTripMs !== null).map((r) => r.roundTripMs);
  result.utilityProcess.summary = {
    avgMainThreadMsPerFrame: +avgPost.toFixed(3),
    avgRoundTripMs: gotRT.length ? +avg(gotRT).toFixed(3) : null,
    comparedToCurrentJpegMs: +avg(fullFrames.map((f) => { const t0 = now(); f.image.toJPEG(90); return now() - t0; })).toFixed(3),
  };
  log(`utilityProcess summary: ${JSON.stringify(result.utilityProcess.summary)}`);

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log("PROBE_RESULT " + JSON.stringify(result, null, 2));
}

app.whenReady().then(() =>
  run()
    .catch((e) => { log(`ERRO: ${e.stack || e.message}`); result.erro = String((e && e.stack) || e); fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); })
    .finally(() => app.quit())
);

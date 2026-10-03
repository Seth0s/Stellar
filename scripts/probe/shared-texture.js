// Sonda INDEPENDENTE (NÃO é o Stellar) — task dc01030b.
//
// PERGUNTA: o caminho de shared texture do Electron 42
// (`webPreferences.offscreen.useSharedTexture`) funciona PONTA A PONTA nesta
// máquina (Linux/Wayland), e quanto custa na thread principal comparado ao
// `image.toJPEG(90)` que o Stellar usa hoje (5,31 ms/frame — docs/PERF.md §7)?
//
// O CAMINHO (electron.d.ts 42.3.0): o `paint` de uma janela offscreen com
// `useSharedTexture:true` traz `details.texture` (OffscreenSharedTexture), cujo
// `textureInfo` é um handle de GPU (Linux: planos DMA-BUF em
// `SharedTextureHandle.nativePixmap`). O main importa
// (`sharedTexture.importSharedTexture`) e envia (`sharedTexture.sendSharedTexture`)
// a um renderer que registrou `sharedTexture.setSharedTextureReceiver`; lá,
// `importedSharedTexture.getVideoFrame()` devolve um `VideoFrame` que vai direto
// num `drawImage` de canvas — sem encode, sem bitmap, sem readback CPU (a menos
// do `getImageData` que ESTA sonda usa de propósito, UMA vez, para PROVAR o pixel).
//
// PROVA POR PIXEL, não por ausência de exceção: a fonte é de cor sólida
// conhecida (#3366CC); o receptor desenha e lê o pixel de volta.
//
// Método pedido: instância ISOLADA (userData próprio em /tmp; não sobe o Stellar,
// não toca o DB do dono), RSS de `VmRSS` em /proc/<pid>/status (NUNCA o campo de
// páginas de /proc/<pid>/stat), árvore de processos por PPid.
//
// Rodar: node_modules/.bin/electron scripts/probe/shared-texture.js
//   Variante de sessão: PROBE_OZONE=x11 (default wayland)
//   Switches extra:    PROBE_SWITCHES="--disable-vulkan,..." (separados por vírgula)
// Resultado: scripts/probe/out/shared-texture/result[-<ozone>].json

const { app, BrowserWindow, ipcMain, sharedTexture } = require("electron");
const fs = require("fs");
const path = require("path");

const OZONE = process.env.PROBE_OZONE || "wayland";
app.commandLine.appendSwitch("ozone-platform", OZONE);
app.commandLine.appendSwitch("no-first-run");
for (const s of (process.env.PROBE_SWITCHES || "").split(",").filter(Boolean)) {
  const eq = s.indexOf("=");
  if (eq === -1) app.commandLine.appendSwitch(s);
  else app.commandLine.appendSwitch(s.slice(0, eq), s.slice(eq + 1));
}
app.setPath("userData", `/tmp/stellar-probe-shared-texture-${OZONE}-${process.pid}`);

const OUT = path.join(__dirname, "out", "shared-texture");
fs.mkdirSync(OUT, { recursive: true });
const TMPPAGES = fs.mkdtempSync("/tmp/stellar-probe-pages-");
const log = (m) => console.error(`[shared-texture ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : +n.toFixed(3));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms`)), ms))]);

const W = 720;
const H = 560;
const SOURCE_CSS = "#3366cc";
const SOURCE_RGB = { r: 0x33, g: 0x66, b: 0xcc };

// ------------------------------------------------------ RSS e árvore por PPid
function vmRssKb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
function descendants(rootPid) {
  const all = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // tudo após o último ')'
      all.push({ pid: Number(entry), ppid: Number(fields[1]), rssKb: vmRssKb(entry) });
    } catch {
      /* saiu */
    }
  }
  const out = [];
  const seen = new Set([rootPid]);
  let frontier = [rootPid];
  while (frontier.length) {
    const next = [];
    for (const parent of frontier)
      for (const p of all)
        if (p.ppid === parent && !seen.has(p.pid)) {
          seen.add(p.pid);
          out.push(p);
          next.push(p.pid);
        }
    frontier = next;
  }
  return out;
}
const rssSnapshot = (label) => ({ label, mainRssKb: vmRssKb(process.pid), descendants: descendants(process.pid) });

// ------------------------------------------------------ páginas (arquivo, não data:)
// `loadFile` em vez de `data:` — uma `#` num data: URL vira fragmento e truncava
// a página (ERR_FAILED medido nesta sonda na 1ª rodada).
function tempPage(name, html) {
  const file = path.join(TMPPAGES, `${name}.html`);
  fs.writeFileSync(file, html, "utf8");
  return file;
}
const SOLID_HTML = `<!doctype html><html><body style="margin:0;background:${SOURCE_CSS};width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;font:bold 72px sans-serif;color:#fff">PROBE</body></html>`;
const ANIMATED_HTML =
  `<!doctype html><html><body style="margin:0">` +
  `<div id="d" style="position:fixed;inset:0"></div>` +
  `<div style="position:fixed;inset:0;background:conic-gradient(from 0deg,#f00,#0f0,#00f,#f00);animation:s 1s linear infinite"></div>` +
  `<style>@keyframes s{to{filter:hue-rotate(360deg)}}</style>` +
  `<script>let i=0;setInterval(function(){const d=document.getElementById('d');d.style.background='hsl('+((i+=7)%360)+',80%,50%)';d.style.font='bold 200px sans-serif';d.textContent='frame '+i;},33);</script>` +
  `</body></html>`;

function makeSource(useSharedTexture) {
  const win = new BrowserWindow({ show: false, width: W, height: H, webPreferences: { offscreen: { useSharedTexture } } });
  win.webContents.setFrameRate(30);
  return win;
}

// O consumidor: renderer com nodeIntegration (sonda isolada) + canvas 2D — o MESMO
// tipo de consumidor do Stellar.
async function makeReceiver() {
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  await win.loadFile(tempPage("receiver", `<canvas id="c" width="${W}" height="${H}"></canvas>`));
  const reg = await win.webContents.executeJavaScript(`
    (() => {
      const { sharedTexture, ipcRenderer } = require("electron");
      const canvas = document.getElementById("c");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      sharedTexture.setSharedTextureReceiver(async (data, ...args) => {
        const t0 = performance.now();
        const frame = data.importedSharedTexture.getVideoFrame();
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        const px = ctx.getImageData(8, 8, 1, 1).data;
        frame.close();
        data.importedSharedTexture.release();
        ipcRenderer.send("probe-drawn", {
          index: args[0] ?? null, marker: args[1] ?? null,
          r: px[0], g: px[1], b: px[2], a: px[3],
          drawMs: performance.now() - t0,
        });
      });
      return { registered: typeof sharedTexture.setSharedTextureReceiver === "function" };
    })()
  `);
  return { win, reg };
}

// Importa + envia UMA textura. `syncMs` = import + a chamada síncrona do send,
// que é o que trava a thread principal (o número que decide).
async function importAndSend(sourceWC, receiverWC, texture, index, marker) {
  const t0 = now();
  const imported = sharedTexture.importSharedTexture({ textureInfo: texture.textureInfo });
  const t1 = now();
  const p = sharedTexture.sendSharedTexture({ frame: receiverWC.mainFrame, importedSharedTexture: imported }, index, marker);
  const t2 = now();
  let sendErr = null;
  try {
    await withTimeout(p, 3000, "sendSharedTexture");
  } catch (err) {
    sendErr = String(err && err.message ? err.message : err);
  }
  const t3 = now();
  imported.release();
  return { importMs: t1 - t0, syncMs: t2 - t0, awaitMs: t3 - t2, sendErr };
}

const result = {
  task: "dc01030b",
  ozone: OZONE,
  switches: (process.env.PROBE_SWITCHES || "").split(",").filter(Boolean),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: `${process.platform} ${process.arch}`,
  sessionType: process.env.XDG_SESSION_TYPE || null,
  mainPid: process.pid,
  phases: {},
};

// ------------------------------------------------------ FASE 1: funciona? (pixel)
async function phasePixel(receiver) {
  const phase = { paintsTotal: 0, paintsWithTexture: 0 };
  const source = makeSource(true);
  phase.receiverRegistered = true;

  let drawn = [];
  ipcMain.on("probe-drawn", (_e, d) => drawn.push(d));
  let firstTexture = null;

  await source.loadFile(tempPage("solid", SOLID_HTML));
  source.webContents.on("paint", async (details, dirty, image) => {
    phase.paintsTotal++;
    const texture = details.texture;
    if (!texture) {
      phase.cpuImagePresentInTextureMode = image && !image.isEmpty() ? { size: image.getSize() } : null;
      return;
    }
    phase.paintsWithTexture++;
    if (firstTexture) {
      texture.release();
      return;
    }
    firstTexture = texture;
    phase.textureInfoShape = {
      hasHandle: !!texture.textureInfo.handle,
      nativePixmap: texture.textureInfo.handle.nativePixmap
        ? {
            planes: texture.textureInfo.handle.nativePixmap.planes?.length ?? null,
            modifier: texture.textureInfo.handle.nativePixmap.modifier ?? null,
          }
        : null,
      ioSurface: !!texture.textureInfo.handle.ioSurface,
      ntHandle: !!texture.textureInfo.handle.ntHandle,
      codedSize: texture.textureInfo.codedSize ?? null,
      pixelFormat: texture.textureInfo.pixelFormat ?? null,
    };
    phase.cpuImagePopulatedInTextureMode = image ? { size: image.getSize(), empty: image.isEmpty() } : null;
    try {
      phase.firstSend = await withTimeout(
        importAndSend(source.webContents, receiver.webContents, texture, 0, "pixel-proof"),
        5000,
        "pixel import+send",
      );
    } catch (err) {
      phase.importSendError = String(err && err.message ? err.message : err);
    }
    texture.release();
  });

  await sleep(3000);
  phase.drawnCount = drawn.length;
  phase.firstDrawnPixel = drawn[0] ? { r: drawn[0].r, g: drawn[0].g, b: drawn[0].b, a: drawn[0].a } : null;
  phase.expected = SOURCE_RGB;
  phase.pixelMatches =
    !!drawn[0] && Math.abs(drawn[0].r - SOURCE_RGB.r) <= 4 && Math.abs(drawn[0].g - SOURCE_RGB.g) <= 4 && Math.abs(drawn[0].b - SOURCE_RGB.b) <= 4;
  phase.argsRoundTripped = drawn[0] ? { index: drawn[0].index, marker: drawn[0].marker } : null;

  ipcMain.removeAllListeners("probe-drawn");
  source.destroy();
  return phase;
}

// ------------------------------------------------------ FASE 2: custo (mesma página)
async function benchCpuJpeg(nTarget) {
  const win = makeSource(false);
  const frames = [];
  const t0 = Date.now();
  await win.loadFile(tempPage("anim-cpu", ANIMATED_HTML));
  await new Promise((resolve) => {
    win.webContents.on("paint", (_d, _dirty, image) => {
      const a = now();
      const jpeg = image.toJPEG(90);
      const b = now();
      frames.push({ ms: b - a, bytes: jpeg.length });
      if (frames.length >= nTarget || Date.now() - t0 > 6000) resolve();
    });
    setTimeout(resolve, 8000);
  });
  win.destroy();
  const avg = (k) => (frames.length ? frames.reduce((s, f) => s + f[k], 0) / frames.length : null);
  return { frames: frames.length, avgMainThreadMs: r2(avg("ms")), avgJpegBytes: avg("bytes") ? Math.round(avg("bytes")) : null };
}

async function benchSharedTexture(nTarget, receiver) {
  const source = makeSource(true);
  const draws = [];
  ipcMain.on("probe-drawn", (_e, d) => draws.push({ ...d, at: Date.now() }));
  const frames = [];
  const t0 = Date.now();
  await source.loadFile(tempPage("anim-tex", ANIMATED_HTML));
  await new Promise((resolve) => {
    source.webContents.on("paint", async (details) => {
      const texture = details.texture;
      if (!texture) return;
      const index = frames.length;
      const sentAt = Date.now();
      const t = await importAndSend(source.webContents, receiver.webContents, texture, index, "bench");
      const rec = draws.find((d) => d.index === index);
      frames.push({ ...t, untilDrawnMs: rec ? rec.at - sentAt : null, drawMs: rec ? rec.drawMs : null });
      texture.release();
      if (frames.length >= nTarget || Date.now() - t0 > 6000) resolve();
    });
    setTimeout(resolve, 8000);
  });
  await sleep(300);
  ipcMain.removeAllListeners("probe-drawn");
  source.destroy();
  const n = frames.length;
  const avg = (k) => (n ? frames.reduce((s, f) => s + (f[k] ?? 0), 0) / n : null);
  return {
    frames: n,
    avgSyncMs: r2(avg("syncMs")),
    avgImportMs: r2(avg("importMs")),
    avgSendAwaitMs: r2(avg("awaitMs")),
    avgUntilDrawnMs: r2(avg("untilDrawnMs")),
    avgRendererDrawMs: r2(avg("drawMs")),
    sendErrors: frames.filter((f) => f.sendErr).length,
    firstSendError: frames.find((f) => f.sendErr)?.sendErr ?? null,
  };
}

// ------------------------------------------------------ FASE 3: comportamentos
async function phaseBehaviors(receiver) {
  const phase = {};
  const source = makeSource(true);
  let paints = 0;
  let textures = 0;
  let lastTexture = null;
  source.webContents.on("paint", (details) => {
    paints++;
    if (details.texture) {
      textures++;
      lastTexture = details.texture;
    }
  });
  await source.loadFile(tempPage("anim-beh", ANIMATED_HTML));
  await sleep(1200);
  phase.animating = { paints, textures };

  // (a) PARADA: página quieta → o paint para?
  await source.webContents.executeJavaScript(`document.querySelectorAll('div')[1].style.animation='none';`).catch(() => {});
  const p0 = paints;
  await sleep(1500);
  phase.idle = { paintsDuringIdle: paints - p0 };

  // (b) REDIMENSIONAR: a textura seguinte tem outro codedSize?
  source.setContentSize(W + 200, H + 100);
  lastTexture = null;
  await source.webContents.executeJavaScript(`document.getElementById('d').style.background='#0a0';`).catch(() => {});
  const t0 = Date.now();
  while (lastTexture === null && Date.now() - t0 < 4000) await sleep(80);
  phase.resize = {
    gotTextureAfterResize: lastTexture !== null,
    codedSizeAfter: lastTexture ? lastTexture.textureInfo.codedSize ?? null : null,
    windowSizeAfter: source.getContentSize(),
  };
  if (lastTexture) lastTexture.release();

  // (c) consumidor esconde/mostra
  receiver.hide();
  await sleep(400);
  const ptBefore = textures;
  receiver.show();
  await sleep(900);
  phase.receiverHideShow = { texturesAfterShow: textures - ptBefore };

  source.destroy();
  return phase;
}

// ------------------------------------------------------ FASE 4: limite de texturas
async function phaseTextureLimit(cap) {
  const source = makeSource(true);
  const held = [];
  const phase = { cap };
  let texture = null;
  source.webContents.on("paint", (d) => {
    if (d.texture) texture = d.texture;
  });
  await source.loadFile(tempPage("anim-limit", ANIMATED_HTML));
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    if (!texture) {
      await sleep(20);
      continue;
    }
    const t = texture;
    texture = null;
    try {
      held.push(sharedTexture.importSharedTexture({ textureInfo: t.textureInfo }));
      t.release();
    } catch (err) {
      phase.firstError = String(err && err.message ? err.message : err);
      t.release();
      break;
    }
    if (held.length >= cap) break;
  }
  phase.heldCount = held.length;
  phase.mainRssWhileHeldKb = vmRssKb(process.pid);
  for (const h of held) h.release();
  await sleep(200);
  phase.mainRssAfterReleaseKb = vmRssKb(process.pid);
  source.destroy();
  return phase;
}

// ------------------------------------------------------ FASE 5: limpeza (release)
async function phaseCleanup(receiver) {
  const source = makeSource(true);
  const phase = {};
  ipcMain.removeAllListeners("probe-drawn");
  ipcMain.on("probe-drawn", () => {});
  let texture = null;
  source.webContents.on("paint", (d) => {
    if (d.texture) texture = d.texture;
  });
  await source.loadFile(tempPage("solid-cleanup", SOLID_HTML));

  async function oneCase(releaseMain) {
    texture = null;
    const t0 = Date.now();
    while (texture === null && Date.now() - t0 < 4000) await sleep(30);
    if (texture === null) return { got: false };
    let allRefsReleased = false;
    const imported = sharedTexture.importSharedTexture({
      textureInfo: texture.textureInfo,
      allReferencesReleased: () => {
        allRefsReleased = true;
      },
    });
    await withTimeout(
      sharedTexture.sendSharedTexture({ frame: receiver.webContents.mainFrame, importedSharedTexture: imported }, 1, "cleanup"),
      3000,
      "cleanup send",
    ).catch(() => {});
    texture.release();
    if (releaseMain) imported.release();
    await sleep(1200);
    return { got: true, mainReleased: releaseMain, allReferencesReleased: allRefsReleased };
  }

  phase.releasedByMain = await oneCase(true);
  phase.forgottenByMain = await oneCase(false);
  source.destroy();
  return phase;
}

// ------------------------------------------------------ orquestração
async function run() {
  result.rssAtStart = rssSnapshot("start");
  const step = async (name, fn, ms) => {
    log(`fase ${name}...`);
    try {
      result.phases[name] = await withTimeout(fn(), ms, `fase ${name}`);
      log(`fase ${name} ok`);
    } catch (err) {
      result.phases[name] = { fatal: String(err && err.stack ? err.stack : err) };
      log(`fase ${name} FALHOU: ${err && err.message ? err.message : err}`);
    }
    result.rssAfter = rssSnapshot(`after-${name}`);
    fs.writeFileSync(path.join(OUT, resultFile()), JSON.stringify(result, null, 2));
  };

  // O consumidor nasce ANTES de qualquer janela offscreen (medido: criar uma
  // janela offscreen antes deixa o processo GPU instável nesta máquina — um
  // `loadFile` comum passa a dar ERR_FAILED). Um receptor só, reusado por todas
  // as fases.
  const { win: receiver, reg } = await makeReceiver();
  result.receiverRegistered = reg.registered;

  // BASELINE PRIMEIRO, de propósito: se rodasse depois da janela de shared
  // texture, mediria o GPU já quebrado, não o caminho de hoje.
  await step("baseline", () => benchCpuJpeg(60), 30000);

  await step("pixel", () => phasePixel(receiver), 30000);
  const gotPixel = result.phases.pixel && result.phases.pixel.pixelMatches === true;

  await step(
    "cost",
    async () => {
      const shared = gotPixel ? await benchSharedTexture(60, receiver) : { skipped: "sem textura — ver phases.pixel" };
      return { baselineJpeg: result.phases.baseline, sharedTexture: shared };
    },
    gotPixel ? 40000 : 5000,
  );

  if (gotPixel) {
    await step("behaviors", () => phaseBehaviors(receiver), 30000);
    await step("textureLimit", () => phaseTextureLimit(120), 25000);
    await step("cleanup", () => phaseCleanup(receiver), 25000);
  } else {
    result.phases.behaviors = { skipped: "sem textura — ver phases.pixel" };
    result.phases.textureLimit = { skipped: "sem textura — ver phases.pixel" };
    result.phases.cleanup = { skipped: "sem textura — ver phases.pixel" };
  }
  receiver.destroy();
  result.verdict = deriveVerdict();
}

function resultFile() {
  return `result-${OZONE}${result.switches.length ? "-" + result.switches.join("_") : ""}.json`;
}

function deriveVerdict() {
  const p = result.phases;
  const px = p.pixel || {};
  const cpu = (p.cost || {}).baselineJpeg || {};
  const sh = (p.cost || {}).sharedTexture || {};
  if (px.pixelMatches === true) {
    return {
      works: true,
      pixelProof: `pixel ${JSON.stringify(px.firstDrawnPixel)} == esperado ${JSON.stringify(px.expected)}`,
      baselineMainThreadMs: cpu.avgMainThreadMs ?? null,
      sharedTextureSyncMs: sh.avgSyncMs ?? null,
      ratio: cpu.avgMainThreadMs && sh.avgSyncMs ? r2(cpu.avgMainThreadMs / sh.avgSyncMs) : null,
      caveat: "só Linux/Wayland foi testado; macOS (IOSurface) e Windows (NT HANDLE) ficaram SEM teste.",
    };
  }
  if (px.paintsWithTexture > 0) {
    return { works: false, reason: "textura chegou mas o pixel não bateu/send falhou", detail: { pixel: px.firstSend, drawn: px.firstDrawnPixel, expected: px.expected } };
  }
  return {
    works: false,
    reason: `nenhuma textura no paint (paintsTotal=${px.paintsTotal ?? "?"}, paintsWithTexture=0) — ver GPU stderr e phases.pixel`,
  };
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    result.fatal = "WATCHDOG 120s — ver fases já gravadas";
    try {
      fs.writeFileSync(path.join(OUT, resultFile()), JSON.stringify(result, null, 2));
    } catch {
      /* disco */
    }
    app.exit(4);
  }, 120000);
  try {
    await run();
  } catch (err) {
    result.fatal = String(err && err.stack ? err.stack : err);
  }
  clearTimeout(watchdog);
  console.log("PROBE_RESULT " + JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, resultFile()), JSON.stringify(result, null, 2));
  app.quit();
});

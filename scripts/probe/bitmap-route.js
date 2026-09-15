/**
 * Sonda 3 — o bitmap cru vale mais que o JPEG?
 *
 * A sonda 1 mediu o pipeline atual do card de navegador: `toJPEG(90)`
 * custa 5,35 ms por frame NA THREAD PRINCIPAL do processo main, e a 60fps
 * isso é ~32% de um core só encodando. `toBitmap` custa 1,65 ms — 3,2×
 * menos. Mas o bitmap tem 5,7 MB contra 8,7 KB do JPEG, e por isso a rota
 * crua foi descartada quando o card foi escrito.
 *
 * A sonda 1 TENTOU medir a alternativa (`MessageChannelMain` com
 * `ArrayBuffer` transferível, que não copia) e falhou com "Port at index 0
 * is not a valid port". Isso é uso errado da API, não limitação: a porta
 * precisa viajar por `webContents.postMessage(canal, msg, [port])`, não
 * como argumento comum. Ficou `supported: false` — que é diferente de
 * "não funciona", e é o único buraco que ainda podia mudar o desenho.
 *
 * O que importa medir NÃO é a largura de banda, é QUANTO A THREAD
 * PRINCIPAL FICA BLOQUEADA. Ela também serve todo o IPC do app e todo o
 * SQLite síncrono: é ela que trava o Stellar inteiro quando satura. Por
 * isso cada rota é medida pelo tempo que o `send` rouba do main, e não só
 * pelo tempo até o outro lado receber.
 *
 * Três rotas, o mesmo frame:
 *   jpeg      toJPEG(90) + ipc normal        (o que existe hoje)
 *   bitmapIpc toBitmap() + ipc normal        (cópia estruturada, 5,7 MB)
 *   bitmapXfer toBitmap() + porta dedicada com ArrayBuffer transferível
 */
const { app, BrowserWindow, MessageChannelMain } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "out", "bitmap-route");
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => console.error(`[bitmap-route] ${m}`);
const now = () => performance.now();

// Página que repinta o quadro INTEIRO sem depender de rAF (rAF é
// estrangulado em janela oculta) — é o pior caso, e é exatamente o caso
// da landing animada que travou o app do dono.
const PAINTER =
  "data:text/html,<div id=d style='position:fixed;inset:0;font:bold 200px sans-serif'></div>" +
  "<script>let i=0;setInterval(()=>{const d=document.getElementById('d');" +
  "d.style.background='hsl('+((i+=7)%360)+',80%,50%)';d.textContent='f'+i;},33);<\/script>";

// Receptor: pega a porta transferida e devolve um ack com o tamanho.
const RECEIVER =
  "data:text/html,<body>recv</body><script>" +
  "const {ipcRenderer}=require('electron');" +
  "ipcRenderer.on('port',(e)=>{const p=e.ports[0];p.start();" +
  "p.onmessage=(ev)=>{const b=ev.data.buf;p.postMessage({seq:ev.data.seq,bytes:b.byteLength||b.length});};});" +
  "ipcRenderer.on('plain',(e,msg)=>{ipcRenderer.send('plainAck',{seq:msg.seq,bytes:msg.buf.length});});" +
  "<\/script>";

const result = { electron: process.versions.electron, chrome: process.versions.chrome, routes: {} };

async function run() {
  const recv = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await recv.loadURL(RECEIVER);

  const { port1, port2 } = new MessageChannelMain();
  // ESTE é o uso correto que faltava: a porta vai no array de
  // transferíveis de `webContents.postMessage`, não como argumento.
  recv.webContents.postMessage("port", null, [port2]);
  port1.start();

  const off = new BrowserWindow({ show: false, width: 1500, height: 950, webPreferences: { offscreen: true } });
  off.webContents.setFrameRate(30);
  await off.loadURL(PAINTER);

  // Junta alguns frames reais antes de medir.
  const images = [];
  await new Promise((resolve) => {
    const t0 = Date.now();
    off.webContents.on("paint", (_e, _d, image) => {
      if (images.length < 12) images.push(image);
      if (images.length >= 12 || Date.now() - t0 > 15000) resolve();
    });
    setTimeout(resolve, 20000);
  });
  log(`frames coletados: ${images.length}`);
  if (images.length === 0) throw new Error("nenhum paint chegou — sem frames para medir");

  const acks = new Map();
  port1.on("message", (e) => { const a = acks.get(e.data.seq); if (a) a(e.data.bytes); });

  const measure = async (name, fn) => {
    const mainMs = [], rtMs = [], bytes = [];
    for (let i = 0; i < images.length; i++) {
      const r = await fn(images[i], i);
      mainMs.push(r.mainMs); rtMs.push(r.rtMs); bytes.push(r.bytes);
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    result.routes[name] = {
      // O número que decide: quanto a thread principal ficou presa.
      mainThreadMsPerFrame: +avg(mainMs).toFixed(3),
      roundTripMsPerFrame: +avg(rtMs).toFixed(3),
      bytesPerFrame: Math.round(avg(bytes)),
      atSixtyFpsPercentOfCore: +((avg(mainMs) * 60) / 10).toFixed(1),
      atThirtyFpsPercentOfCore: +((avg(mainMs) * 30) / 10).toFixed(1),
    };
    log(`${name}: ${JSON.stringify(result.routes[name])}`);
  };

  await measure("jpeg", async (image) => {
    const t0 = now();
    const jpeg = image.toJPEG(90);
    const mainMs = now() - t0;
    return { mainMs, rtMs: 0, bytes: jpeg.length };
  });

  // A rota transferível NÃO EXISTE nesta API, e isto é medição, não
  // suposição: `MessagePortMain.postMessage(message, transfer?)` declara
  // `transfer?: MessagePortMain[]` (electron.d.ts:9704) — só outra porta
  // pode ser transferida, nunca um ArrayBuffer. Passar o buffer no array
  // responde "Port at index 0 is not a valid port". Foi exatamente esse
  // erro que a sonda 1 registrou como `supported: false`, e a suspeita de
  // que era uso errado da API está agora descartada: o uso está certo, a
  // capacidade é que não existe.
  result.transferableSupported = {
    supported: false,
    why: "MessagePortMain.postMessage(message, transfer?: MessagePortMain[]) — electron.d.ts:9704 aceita apenas portas no array de transferência",
    observedError: "Port at index 0 is not a valid port",
  };

  // Sobra a cópia: o mesmo bitmap atravessa por clone estruturado.
  await measure("bitmapCopy", async (image, seq) => {
    const t0 = now();
    const bmp = image.toBitmap();
    const tSend = now();
    const p = new Promise((res) => acks.set(seq, res));
    port1.postMessage({ seq, buf: bmp });
    const mainMs = now() - t0;
    const got = await p;
    return { mainMs, rtMs: now() - tSend, bytes: got };
  });

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

app.whenReady().then(() =>
  run()
    .catch((e) => { log(`ERRO: ${e.message}`); result.erro = e.message; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); })
    .finally(() => app.quit())
);

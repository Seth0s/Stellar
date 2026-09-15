/**
 * Sonda 2 — isola O QUE destrava uma `WebContentsView` filha.
 *
 * A sonda 1 (`main.js`) provou que `addChildView` não compõe: três views
 * adicionadas, zero pixel na tela. Mas ela deixou um positivo ambíguo —
 * no último passo a V3 foi RECOLORIDA (`document.body.style.background`)
 * e apareceu (68.134 px laranja, dentro do retângulo da hospedeira),
 * enquanto a V1, que foi só MOVIDA, continuou invisível. No passo
 * anterior, uma mutação de DOM pequena na V2 também não destravou nada.
 *
 * A leitura provável é que só um repaint que cobre a SUPERFÍCIE INTEIRA
 * é promovido — dano parcial nunca chega ao compositor. Mas a sonda 1
 * fez move e recolor no mesmo passo, e a V3 já estava viva há mais
 * tempo, então tempo e ordem continuam como confundidores.
 *
 * Esta sonda separa as variáveis, cada uma numa view própria, todas com
 * a mesma idade:
 *
 *   A  nada (controle)                    -> esperado: invisível
 *   B  mutação de DOM pequena             -> esperado: invisível
 *   C  repaint de superfície inteira      -> esperado: VISÍVEL
 *   D  setBounds (resize, não só mover)   -> ?
 *
 * E responde a pergunta que decide a viabilidade, que a sonda 1 nem
 * chegou a fazer: **destravar é permanente?** Se depois de compor a view
 * volta a congelar na atualização parcial seguinte, o truque é inútil —
 * seria preciso repintar a superfície inteira a cada frame, que é
 * exatamente o custo do qual se quer escapar.
 */
const { app, BrowserWindow, WebContentsView, nativeImage } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const OZONE = process.env.PROBE_OZONE || "wayland";
app.commandLine.appendSwitch("ozone-platform", OZONE);
const OUT = path.join(__dirname, "out", `${OZONE}-unstick`);
fs.mkdirSync(OUT, { recursive: true });

const log = (m) => console.error(`[unstick] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = [0x1a, 0x05, 0x18];
const COLORS = { magenta: [255, 0, 255], cyan: [0, 255, 255], green: [0, 255, 0], orange: [255, 128, 0] };
const CSS = { magenta: "#FF00FF", cyan: "#00FFFF", green: "#00FF00", orange: "#FF8000" };
const page = (c, l) => `data:text/html,<body style="margin:0;background:${c}"><h1 style="font:700 90px sans-serif">${l}</h1></body>`;

function shotFile(name) {
  const file = path.join(OUT, name);
  return new Promise((resolve, reject) => {
    const args = OZONE === "x11" ? ["import", ["-window", "root", file]] : ["python3", [path.join(__dirname, "portal_screenshot.py"), file]];
    execFile(args[0], args[1], (err, _o, se) => (err ? reject(new Error(se || err.message)) : resolve(file)));
  });
}
const near = (r, g, b, t) => Math.abs(r - t[0]) < 40 && Math.abs(g - t[1]) < 40 && Math.abs(b - t[2]) < 40;

function scan(img) {
  const { width } = img.getSize();
  const bmp = img.getBitmap();
  const init = () => ({ count: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 });
  const out = { host: init() };
  for (const k of Object.keys(COLORS)) out[k] = init();
  for (let i = 0; i + 2 < bmp.length; i += 16) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
    let hit = near(r, g, b, HOST) ? "host" : null;
    if (!hit) for (const [k, c] of Object.entries(COLORS)) if (near(r, g, b, c)) { hit = k; break; }
    if (!hit) continue;
    const s = out[hit];
    s.count++;
    const px = (i / 4) % width, py = Math.floor(i / 4 / width);
    if (px < s.minX) s.minX = px; if (px > s.maxX) s.maxX = px;
    if (py < s.minY) s.minY = py; if (py > s.maxY) s.maxY = py;
  }
  return out;
}
const MIN = 4000;
function composed(s, color) {
  const h = s.host, c = s[color];
  const contained = c.count > 0 && c.minX >= h.minX - 8 && c.maxX <= h.maxX + 8 && c.minY >= h.minY - 8 && c.maxY <= h.maxY + 8;
  return { composed: c.count > MIN && contained, count: c.count };
}

const result = { ozone: OZONE, electron: process.versions.electron, chrome: process.versions.chrome };

async function run() {
  const win = new BrowserWindow({ x: 150, y: 100, width: 1000, height: 700, alwaysOnTop: true, backgroundColor: "#1A0518", title: "stellar-probe-unstick" });
  await win.loadURL(page("#1A0518", ""));
  await sleep(1500);

  // Quatro views idênticas, criadas juntas: mesma idade, mesma ordem.
  const views = {};
  const layout = { A: { x: 30, y: 30 }, B: { x: 510, y: 30 }, C: { x: 30, y: 350 }, D: { x: 510, y: 350 } };
  const color = { A: "magenta", B: "cyan", C: "green", D: "orange" };
  for (const k of ["A", "B", "C", "D"]) {
    const v = new WebContentsView();
    win.contentView.addChildView(v);
    v.setBounds({ ...layout[k], width: 440, height: 280 });
    views[k] = v;
  }
  await Promise.all(Object.entries(views).map(([k, v]) => v.webContents.loadURL(page(CSS[color[k]], k))));
  await sleep(2500);

  result.antes = {};
  let s = scan(nativeImage.createFromPath(await shotFile("u0-quatro-views.png")));
  for (const k of ["A", "B", "C", "D"]) result.antes[k] = composed(s, color[k]);
  log(`antes: ${JSON.stringify(result.antes)}`);

  // Cada view recebe UM estímulo diferente. A não recebe nada.
  await views.B.webContents.executeJavaScript(`document.body.appendChild(document.createElement('span')).textContent='x';`);
  await views.C.webContents.executeJavaScript(`document.body.style.background='${CSS[color.C]}';`);
  views.D.setBounds({ ...layout.D, width: 441, height: 281 });
  await sleep(1800);

  result.depois = {};
  s = scan(nativeImage.createFromPath(await shotFile("u1-estimulos.png")));
  for (const k of ["A", "B", "C", "D"]) result.depois[k] = composed(s, color[k]);
  log(`depois: ${JSON.stringify(result.depois)}`);

  // A pergunta que decide: destravar é permanente? Quem compôs recebe
  // agora só uma atualização PARCIAL. Se sumir, o truque não serve.
  for (const k of ["B", "C", "D"]) {
    await views[k].webContents.executeJavaScript(`document.body.appendChild(document.createElement('p')).textContent='parcial';`);
  }
  await sleep(1800);
  result.permanece = {};
  s = scan(nativeImage.createFromPath(await shotFile("u2-parcial-depois.png")));
  for (const k of ["A", "B", "C", "D"]) result.permanece[k] = composed(s, color[k]);
  log(`permanece: ${JSON.stringify(result.permanece)}`);

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

app.whenReady().then(() =>
  run().catch((e) => { log(`ERRO: ${e.message}`); result.erro = e.message; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); }).finally(() => app.quit())
);

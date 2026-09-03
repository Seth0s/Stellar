// Trilha B (docs/SCREEN_SPACE_PROJECTION_PLAN.md) — sexto card kind
// migrado. Combinação nova aqui, não exercida por nenhum kind migrado
// antes: MediaCard em modo imagem é `chromeless` (o corpo inteiro, não só
// o header, inicia o drag do card — ver CardFrame.tsx's `onHeaderPointerDown`
// chamado a partir de `.card-clip` quando chromeless), e tem uma transform
// interna própria (`view: {zoom,panX,panY}` de pan/zoom da imagem) que
// precisa continuar dividindo por `zoom` (o zoom do CANVAS) sem se
// confundir com a projeção externa do card — ver §0.5 ponto 2 do plano.
//
// A prova de comportamento (drag simétrico, resize preservando aspect
// ratio) já existe em `smoke-media-card.mjs` (pré-existente, roda contra
// a versão migrada e passa 22/22) — este teste cobre especificamente o
// que aquele não checa: o card real acaba no DOM certo (`.cards-layer`,
// não `.world`), a mesma prova mínima que sticky/files/changes/stroke já
// fizeram antes de confiar que a combinação nova não quebrou nada.
import zlib from "node:zlib";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9558;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-media-screen-projection", import.meta.url).pathname;

// Mesmo encoder PNG mínimo que smoke-media-card.mjs já usa (sem deps).
function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Media Screen Projection", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 400));

  const png = makePng(40, 20, [200, 80, 80]);
  const b64 = png.toString("base64");
  await page.evalJs(`
    (async () => {
      const bin = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "test.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      document.querySelector(".viewport").dispatchEvent(evt);
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));

  check("media card real criado (paste de imagem)", await page.evalJs(`!!document.querySelector('[data-kind="media"]')`), true);
  check("media card vive em .cards-layer (migrado)", await page.evalJs(`!!document.querySelector('.cards-layer [data-kind="media"]')`), true);
  check("media card NÃO vive mais em .world", await page.evalJs(`!!document.querySelector('.world [data-kind="media"]')`), false);

  // Zoom interno da mídia (roda/pinça na imagem) continua usando o zoom
  // do CANVAS pra converter delta de mouse -- não algo recalculado pela
  // projeção externa (§0.5 ponto 2 do plano). Testa via wheel real sobre
  // o corpo da imagem e confirma que o zoom interno muda (prova que o
  // wheel handler, que divide/multiplica usando `zoom` do canvas, ainda
  // reage normalmente com o card projetado).
  const body = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-role="media-viewport"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: body.x, y: body.y, deltaX: 0, deltaY: -240 });
  await new Promise((r) => setTimeout(r, 200));
  const transform = await page.evalJs(`document.querySelector('[data-role="media-content"]')?.style?.transform ?? ""`);
  check("wheel real sobre o corpo da imagem ainda muda o zoom interno (scale > 1)", /scale\(([\d.]+)\)/.exec(transform) ? Number(/scale\(([\d.]+)\)/.exec(transform)[1]) > 1 : false, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

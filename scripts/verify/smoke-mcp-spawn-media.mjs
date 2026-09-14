// spawn_card kind:"media" — agent surface opens an image/PDF card that
// MediaCard already knows how to render. Isolated Electron (never the
// owner's app). Copies into board-assets before consent; autonomous board
// auto-approves so the script can drive both spawns without a human click.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-spawn-media-${CDP_PORT}`, import.meta.url).pathname;
const FIXTURES_DIR = new URL(`../../.verify-tmp/smoke-mcp-spawn-media-fixtures-${CDP_PORT}`, import.meta.url).pathname;
const SHOTS_DIR = new URL(`../../.verify-tmp/smoke-mcp-spawn-media-shots-${CDP_PORT}`, import.meta.url).pathname;

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
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
function makePdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 34 >>\nstream\n0 0 0 rg 10 10 50 50 re f\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  return JSON.parse((await callTool(name, args)).content[0].text);
}
async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

async function spawnMediaApproved(page, bashId, path, reason) {
  const pending = callTool("spawn_card", {
    kind: "media",
    path,
    callerCardId: bashId,
    reason,
  });
  await new Promise((r) => setTimeout(r, 600));
  await clickModalButton(page, "Permitir");
  return JSON.parse((await pending).content[0].text);
}

async function captureCardPng(page, { preferCanvas = false } = {}, outPath) {
  // Prefer a DOM rect clip via CDP — MCP `snapshot(target)` hit UnknownVizError
  // on media cards in this harness (same class of compositor quirk other
  // smokes already sidestep with Page.captureScreenshot).
  const clip = JSON.parse(
    await page.evalJs(`
      (() => {
        const cards = [...document.querySelectorAll('[data-kind="media"]')];
        const el = ${preferCanvas ? "true" : "false"}
          ? (cards.find((c) => c.querySelector("canvas")) || cards[cards.length - 1])
          : (cards.find((c) => c.querySelector('[data-role="media-content"] img')) || cards[0]);
        if (!el) return JSON.stringify(null);
        el.click();
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        // If the card sits mostly off-screen, fall back to a full-window shot
        // rather than an empty clip at (0,0).
        if (r.bottom < 40 || r.right < 40 || r.top > vh - 40 || r.left > vw - 40) {
          return JSON.stringify({ x: 0, y: 0, width: vw, height: vh, scale: window.devicePixelRatio || 1, full: true });
        }
        return JSON.stringify({
          x: Math.max(0, r.x),
          y: Math.max(0, r.y),
          width: Math.min(r.width, vw - Math.max(0, r.x)),
          height: Math.min(r.height, vh - Math.max(0, r.y)),
          scale: window.devicePixelRatio || 1,
        });
      })()
    `),
  );
  if (!clip) throw new Error("no media card DOM to capture");
  const { data } = await page.send("Page.captureScreenshot", { format: "png", clip, fromSurface: true });
  writeFileSync(outPath, Buffer.from(data, "base64"));
}

mkdirSync(FIXTURES_DIR, { recursive: true });
mkdirSync(SHOTS_DIR, { recursive: true });
const pngPath = join(FIXTURES_DIR, "agent-shot.png");
const pdfPath = join(FIXTURES_DIR, "agent-doc.pdf");
writeFileSync(pngPath, makePng(120, 80, [220, 40, 40]));
writeFileSync(pdfPath, makePdf());

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Spawn Media Smoke");
  await new Promise((r) => setTimeout(r, 500));

  const bashId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  // Teaching refusal — before any card is created (no consent dialog).
  writeFileSync(join(FIXTURES_DIR, "notes.docx"), "x");
  const bad2 = await toolJson("spawn_card", {
    kind: "media",
    path: join(FIXTURES_DIR, "notes.docx"),
    callerCardId: bashId,
    reason: "should refuse docx",
  });
  check("tipo fora do conjunto é recusado com mensagem que ensina", /accepted types:/.test(bad2.error ?? ""), true);

  const imgSpawn = await spawnMediaApproved(page, bashId, pngPath, "live proof image");
  check("spawn_card media imagem ok", imgSpawn.ok && typeof imgSpawn.cardId === "string", true);

  let naturalWidth = 0;
  const imgDeadline = Date.now() + 5000;
  while (Date.now() < imgDeadline) {
    naturalWidth = JSON.parse(
      await page.evalJs(`
        (() => {
          const img = document.querySelector('[data-role="media-content"] img');
          return JSON.stringify(img?.naturalWidth || 0);
        })()
      `),
    );
    if (naturalWidth > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  check("imagem visível (naturalWidth > 0)", naturalWidth > 0, true);

  const imgShotPath = join(SHOTS_DIR, "media-image.png");
  await captureCardPng(page, { preferCanvas: false }, imgShotPath);
  check("screenshot da imagem gravado", readFileSync(imgShotPath).length > 100, true);

  const pdfSpawn = await spawnMediaApproved(page, bashId, pdfPath, "live proof pdf");
  check("spawn_card media pdf ok", pdfSpawn.ok && typeof pdfSpawn.cardId === "string", true);

  let pdfCanvas = false;
  const pdfDeadline = Date.now() + 8000;
  while (Date.now() < pdfDeadline) {
    pdfCanvas = JSON.parse(
      await page.evalJs(`
        (() => {
          const cards = [...document.querySelectorAll('[data-kind="media"]')];
          const pdfCard = cards.find((c) => c.querySelector('canvas'));
          if (pdfCard) {
            // Bring into view for the screenshot below.
            pdfCard.scrollIntoView?.({ block: "center", inline: "center" });
          }
          const canvas = pdfCard?.querySelector('canvas');
          return JSON.stringify(!!(canvas && canvas.width > 0 && canvas.height > 0));
        })()
      `),
    );
    if (pdfCanvas) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("PDF visível (canvas renderizado)", pdfCanvas, true);

  const pdfShotPath = join(SHOTS_DIR, "media-pdf.png");
  await captureCardPng(page, { preferCanvas: true }, pdfShotPath);
  check("screenshot do PDF gravado", readFileSync(pdfShotPath).length > 100, true);

  const listed = await toolJson("list_cards", {});
  check(
    "list_cards mostra dois cards media",
    listed.cards.filter((c) => c.kind === "media").length >= 2,
    true,
  );

  console.log(JSON.stringify({ shots: { image: imgShotPath, pdf: pdfShotPath }, imgSpawn, pdfSpawn }, null, 2));
} finally {
  await stopApp(app);
}
finish();

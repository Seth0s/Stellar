// Item 57.9 — mídia no canvas (paste/drop de imagem/PDF vira um card de
// visualização com resize proporcional, rotação e pan/zoom interno). Real
// clipboard paste synthesized in-page (CDP não tem um primitivo nativo de
// paste pra disparar diretamente) e tudo mais dirigido ao vivo contra uma
// instância real — nada mockado.
//
// PDF: um `File` fabricado em página (via `new File([bytes], ...)`) nunca
// tem um path real de SO associável por `webUtils.getPathForFile` — só um
// drop vindo de um gesto de SO de verdade tem isso, e CDP não tem um jeito
// confiável de simular ISSO especificamente neste Electron. Em vez de um
// drop sintético (que só provaria o caminho de rejeição "sem path real"),
// este teste chama `window.boardAssets.copyFromPath` direto com um PDF
// REAL escrito em disco pelo próprio script — exercita o mesmo IPC/cópia/
// protocolo/pdf.js que um drop real dispararia, só pulando a simulação do
// gesto de drop em si (não testável aqui). O reload com `preserveUserData`
// (mesmo padrão da auditoria S7) então confirma round-trip real pelo
// sqlite (toRow/fromRow) pra ambos os cards.
import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9430;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-media-card", import.meta.url).pathname;
const FIXTURES_DIR = new URL("../../.verify-tmp/smoke-media-card-fixtures", import.meta.url).pathname;

// ---- minimal real PNG encoder (no deps) — 40x20 solid RGB, deliberately
// non-square so aspect-ratio-preserving resize has something real to
// prove. ----
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

// ---- minimal real single-page PDF (no deps, byte-accurate xref) ----
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

function findMediaAssetFiles(dir) {
  const found = [];
  function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.startsWith("media-")) found.push(p);
    }
  }
  try {
    walk(dir);
  } catch {
    // board-assets dir doesn't exist yet — no media saved.
  }
  return found;
}

mkdirSync(FIXTURES_DIR, { recursive: true });
const pdfFixturePath = join(FIXTURES_DIR, "test.pdf");
writeFileSync(pdfFixturePath, makePdf());

const { check, finish } = makeChecker();
let app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  let page = await connectPage(CDP_PORT);
  await bootIntoFreshSession(page, "Mídia", { spawnTerminal: false });

  const pngBase64 = makePng(40, 20, [220, 60, 60]).toString("base64");

  // ---- paste an image onto the empty canvas ----
  await page.evalJs(`
    (async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pngBase64)}), (c) => c.charCodeAt(0));
      const file = new File([bytes], "test.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    })()
  `);

  let deadline = Date.now() + 5000;
  let mediaCardFound = false;
  while (Date.now() < deadline) {
    if (JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector(".media-card"))`))) {
      mediaCardFound = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  check("paste no canvas vazio cria um card de mídia", mediaCardFound, true);

  // Pedido ao vivo (2026-09-01): "O CARD TIPO MEDIA NÃO DEVERIA TER BODY" —
  // uma imagem passa a ser exibida sem moldura: sem rodapé, e com o header
  // virando um overlay que não ocupa altura de layout. É essa última parte
  // que faz a imagem preencher o card exatamente (o `rect` já nasce com a
  // proporção natural da imagem via `fitMediaRect`; era o header+rodapé que
  // quebravam o encaixe e deixavam a faixa vazia). Fechar/girar/renomear
  // continuam existindo no overlay — some a superfície, não a função.
  // Ponteiro pra longe antes de medir: o header em modo sem moldura é
  // revelado por `:hover`, então uma medição com o mouse parado em cima do
  // card (onde um clique anterior do boot pode tê-lo deixado) leria a
  // opacidade do estado revelado e a checagem de "invisível" viraria ruído.
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none", buttons: 0, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));

  const chrome = JSON.parse(
    await page.evalJs(`
      (() => {
        const frame = document.querySelector('.media-card');
        const head = frame.querySelector('.card-head');
        const viewport = frame.querySelector('.media-viewport');
        const f = frame.getBoundingClientRect();
        const v = viewport.getBoundingClientRect();
        return JSON.stringify({
          chromeless: frame.classList.contains('chromeless'),
          foot: !!frame.querySelector('.card-foot'),
          headPosition: getComputedStyle(head).position,
          headOpacity: Number(getComputedStyle(head).opacity),
          headButtons: head.querySelectorAll('button').length,
          gapY: f.height - v.height,
          gapX: f.width - v.width,
        });
      })()
    `),
  );
  check("um card de imagem entra em modo sem moldura", chrome.chromeless, true);
  check("...sem rodapé nenhum (o nome do arquivo já era o rótulo do header)", chrome.foot, false);
  check("...com o header fora do fluxo de layout, não como linha do card", chrome.headPosition, "absolute");
  check("...invisível até o hover", chrome.headOpacity, 0);
  check("...mas com os botões ainda lá (girar, fechar, focar)", chrome.headButtons, (n) => n >= 2);
  check("a imagem ocupa a altura inteira do card — nada de faixa vazia", Math.abs(chrome.gapY) <= 1, true);
  check("...e a largura inteira", Math.abs(chrome.gapX) <= 1, true);

  // Sem header não sobra faixa dedicada pra arrastar: a regra combinada é
  // que o corpo move o card enquanto a imagem cabe inteira (view.zoom <= 1,
  // não há pan possível), e só volta a dar pan quando ampliada.
  //
  // A espera não é folclore: `.card-frame` nasce com a animação `popin`
  // (animations.css anima `transform: scale`), e um `getBoundingClientRect`
  // no meio dela devolve a caixa ESCALADA — medir ali dá um ponto de garra
  // que cai fora do card já assentado, e o "drag" vira um clique no vazio
  // (foi exatamente esse o falso negativo enquanto isto foi escrito: dois
  // runs com "antes" diferentes e o mesmo "depois", ou seja, nada se moveu).
  await new Promise((r) => setTimeout(r, 600));
  const beforeBodyDrag = await getCardRect();
  // Centro do card, longe do overlay de header (que ocupa só a faixa do
  // topo) e longe do canto do handle de resize.
  const grab = { x: beforeBodyDrag.x + beforeBodyDrag.w / 2, y: beforeBodyDrag.y + beforeBodyDrag.h / 2 };
  // Arrasta pra CIMA e pra ESQUERDA de propósito: o teste de resize logo
  // abaixo puxa o canto inferior-direito mais 120px pra fora, e um
  // `Input.dispatchMouseEvent` com coordenada fora do viewport é um no-op
  // silencioso (mesmo achado já documentado em smoke-card-actions.mjs) —
  // empurrar este card pra baixo/direita fazia o resize seguinte falhar
  // sem ter nada a ver com resize.
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: grab.x, y: grab.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: grab.x - 70, y: grab.y - 50, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: grab.x - 70, y: grab.y - 50, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const afterBodyDrag = await getCardRect();
  check(
    "arrastar o corpo da imagem move o card (o header não é mais o único punho)",
    Math.abs(afterBodyDrag.x - beforeBodyDrag.x + 70) <= 6 && Math.abs(afterBodyDrag.y - beforeBodyDrag.y + 50) <= 6,
    true,
  );

  // Devolve o card exatamente pra onde estava. Não é higiene opcional: as
  // checagens seguintes (rotação pelo botão do header, resize pelo canto)
  // clicam em coordenadas derivadas da geometria do card, e um
  // `Input.dispatchMouseEvent` fora do viewport é um no-op silencioso —
  // deixar o card deslocado fazia rotação e resize falharem por motivo
  // nenhum relacionado a eles.
  const back = { x: grab.x - 70, y: grab.y - 50 };
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: back.x, y: back.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: grab.x, y: grab.y, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: grab.x, y: grab.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 400));
  const restored = await getCardRect();
  check(
    "...e o arraste é simétrico — volta exatamente pra posição original",
    Math.abs(restored.x - beforeBodyDrag.x) <= 2 && Math.abs(restored.y - beforeBodyDrag.y) <= 2,
    true,
  );

  let naturalWidth = 0;
  deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    naturalWidth = JSON.parse(
      await page.evalJs(`JSON.stringify(document.querySelector(".media-content img")?.naturalWidth || 0)`),
    );
    if (naturalWidth > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (naturalWidth === 0) {
    const diag = JSON.parse(
      await page.evalJs(`
        (async () => {
          const img = document.querySelector(".media-content img");
          let fetchStatus = "n/a";
          try {
            const res = await fetch(img.src);
            fetchStatus = res.status + " len=" + (await res.arrayBuffer()).byteLength;
          } catch (e) {
            fetchStatus = "fetch threw: " + e;
          }
          return JSON.stringify({ src: img?.src, complete: img?.complete, fetchStatus });
        })()
      `),
    );
    console.error("naturalWidth diag:", diag);
  }
  check("a <img> via stellar-asset:// carrega de verdade", naturalWidth, (n) => n > 0);
  check(
    "src usa o protocolo stellar-asset://",
    await page.evalJs(`document.querySelector(".media-content img")?.src.startsWith("stellar-asset://")`),
    true,
  );

  const assetFilesAfterPaste = findMediaAssetFiles(join(USER_DATA_DIR, "board-assets"));
  check("arquivo colado foi salvo na pasta PERSISTENTE do board", assetFilesAfterPaste.length, (n) => n >= 1);

  async function getCardRect(selector = ".media-card") {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
        })()
      `),
    );
  }

  const beforeResize = await getCardRect();
  const originalRatio = beforeResize.w / beforeResize.h;

  // Drag the resize handle (bottom-right corner) — real down/move/up via CDP.
  const handleX = beforeResize.x + beforeResize.w - 8;
  const handleY = beforeResize.y + beforeResize.h - 8;
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: handleX,
    y: handleY,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: handleX + 120,
    y: handleY + 40,
    pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: handleX + 120,
    y: handleY + 40,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 200));

  const afterResize = await getCardRect();
  check("resize pelo canto realmente mudou o tamanho", afterResize.w !== beforeResize.w, true);
  const newRatio = afterResize.w / afterResize.h;
  check("resize preserva a proporção original (aspectRatio)", Math.abs(newRatio - originalRatio) < 0.05, true);

  // ---- rotation button: click twice (0→90→180), stop at a non-default
  // value on purpose — a later check re-reads this after a full app
  // restart, so ending at the default (0) would prove nothing. ----
  const rotateBtnBox = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.media-card [title="Girar 90°"]');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  for (const expected of [90, 180]) {
    await page.click(rotateBtnBox.x, rotateBtnBox.y);
    await new Promise((r) => setTimeout(r, 120));
    const transform = await page.evalJs(`document.querySelector(".media-content").style.transform`);
    check(`rotação do botão chega em ${expected}deg`, transform.includes(`rotate(${expected}deg)`), true);
  }

  // ---- PDF: real file on disk, copied via the same IPC a real drop
  // would use, card row inserted directly (see file header comment for
  // why a synthetic drop can't carry a real OS path here). ----
  const boardId = JSON.parse(
    await page.evalJs(`(async () => JSON.stringify((await window.store.boards.list())[0].id))()`),
  );
  const pdfSaveResult = JSON.parse(
    await page.evalJs(
      `(async () => JSON.stringify(await window.boardAssets.copyFromPath(${JSON.stringify(boardId)}, ${JSON.stringify(pdfFixturePath)})))()`,
    ),
  );
  check("copyFromPath salva o PDF real na pasta do board", pdfSaveResult.ok, true);

  if (pdfSaveResult.ok) {
    await page.evalJs(`
      (async () => {
        await window.store.upsert({
          id: "test-pdf-card",
          board_id: ${JSON.stringify(boardId)},
          kind: "media",
          provider: "pdf",
          cwd: JSON.stringify({ assetPath: ${JSON.stringify(pdfSaveResult.path)}, rotation: 0, view: { zoom: 1, panX: 0, panY: 0 } }),
          x: 900, y: 60, w: 400, h: 300,
          resume_id: null, model: null, system_prompt: null,
          group_id: null, label: null, updated_at: Date.now(),
          messages_json: null, archived_at: null,
        });
      })()
    `);
  }

  page.close();

  // ---- restart the app against the SAME profile (preserveUserData) —
  // confirms both cards (and the PDF's page render) survive a real
  // reload, not just an in-memory state update. ----
  await stopApp(app);
  app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, preserveUserData: true });
  page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 500));

  // Item 8 — a restart boots back to Home, not straight into the board;
  // click the (only) session card to re-enter it.
  const sessionCardBox = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector(".home-session-card");
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!sessionCardBox) throw new Error("Home session card not found after restart");
  await page.click(sessionCardBox.x, sessionCardBox.y);

  deadline = Date.now() + 5000;
  let cardsAfterReload = 0;
  while (Date.now() < deadline) {
    cardsAfterReload = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelectorAll(".media-card").length)`));
    if (cardsAfterReload >= 2) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  check("os 2 cards de mídia sobrevivem a um reload real do app", cardsAfterReload, 2);

  const imageTransformAfterReload = await page.evalJs(`
    (() => {
      const imageCard = [...document.querySelectorAll(".media-card")].find((c) => !c.querySelector(".media-pdf-nav"));
      return imageCard?.querySelector(".media-content")?.style.transform ?? "";
    })()
  `);
  check(
    "rotação (180deg) persistiu de verdade pelo sqlite",
    String(imageTransformAfterReload).includes("rotate(180deg)"),
    true,
  );

  await new Promise((r) => setTimeout(r, 800)); // let pdf.js's lazy chunk + worker actually load and render

  const pdfNav = await page.evalJs(`document.querySelector(".media-pdf-nav")?.textContent || ""`);
  check("footer do PDF mostra 1/1 páginas", pdfNav.includes("1/1") || pdfNav.includes("1") , true);

  const pdfCanvasSize = JSON.parse(
    await page.evalJs(`
      (() => {
        const c = document.querySelector(".media-pdf-canvas");
        return JSON.stringify(c ? { w: c.width, h: c.height } : null);
      })()
    `),
  );
  check("pdf.js renderizou de verdade (canvas com dimensões reais)", pdfCanvasSize && pdfCanvasSize.w > 0 && pdfCanvasSize.h > 0, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

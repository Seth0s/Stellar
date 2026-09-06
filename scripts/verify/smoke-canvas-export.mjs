// DESIGN-BACKLOG.md 2.1 — "Exportação do Canvas com Seleção de Área"
// (Item 57.8), quarto item da lista priorizada aprovada pelo usuário em
// 2026-08-31 (item 3, FilesCard, ficou de fora — outro agente cuida dele).
//
// Reusa a MESMA API real (`webContents.capturePage`) que o `snapshot` MCP
// já usa — uma captura de janela de verdade, não um DOM-to-canvas de
// biblioteca (que não renderiza WebGL/views nativas corretamente). PDF
// embrulha o JPEG capturado num wrapper mínimo (main/pdf-export.ts, sem
// lib nova) — verificado de verdade aqui via `pdfinfo`/`pdftoppm`
// (poppler-utils, já instalado nesta máquina), não só "arquivo existe".
//
// Limite honesto de CDP, mesmo já aceito por `fs:pick-directory` neste
// código: um diálogo nativo de "Salvar como" não é dirigível via CDP (não
// é conteúdo web). O fluxo de UI real (ferramenta → arraste → barra de
// formato) é testado com eventos de mouse sintéticos de verdade; o
// pipeline de captura/encode/escrita em si (a parte nova e arriscada) é
// verificado via `window.canvasExport.captureRectTest`, que roda o
// EXATO mesmo código do handler real, só pulando o diálogo nativo —
// mesmo precedente de `clipboard:test-write-image`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-canvas-export-${CDP_PORT}`, import.meta.url).pathname;
const OUT_DIR = new URL(`../../.verify-tmp/smoke-canvas-export-out-${CDP_PORT}`, import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Canvas Export Teste");
  await new Promise((r) => setTimeout(r, 800));

  // O bash semeado por bootIntoFreshSession já imprime texto real (prompt)
  // no terminal — conteúdo com entropia de verdade dentro do recorte,
  // não uma área vazia/monocromática. `onBackgroundPointerDown` só inicia
  // a ferramenta de export quando o pointerdown acontece no FUNDO vazio
  // (e.target === e.currentTarget) — o arraste precisa começar FORA do
  // card, não em cima dele, então a área é calculada a partir do rect
  // real do card, não um palpite de coordenada fixa.
  const termRect = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-kind="terminal"]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      })()
    `),
  );
  check("terminal padrão existe (vai fornecer conteúdo real dentro do recorte)", termRect !== null, true);

  // ---- 1. ativa a ferramenta "export" ----
  const exportBtn = await centerOf(page, '.rail-btn[title="Exportar recorte do canvas"]');
  check("botão 'Exportar recorte do canvas' existe na rail", exportBtn !== null, true);
  await page.click(exportBtn.x, exportBtn.y);
  await new Promise((r) => setTimeout(r, 200));
  const toolActive = await page.evalJs(`document.querySelector('.rail-btn[title="Exportar recorte do canvas"]')?.className`);
  check("ferramenta 'export' fica marcada como ativa", toolActive?.includes("active"), true);

  // ---- 2. arraste real (down→move→up), começando no fundo VAZIO (à
  // direita do card, que ocupa quase a janela toda no boot padrão) e
  // terminando dentro dele — o retângulo final cobre uma boa parte do
  // terminal mesmo o pointerdown tendo começado fora dele. ----
  const startX = termRect.right + 60;
  const startY = termRect.top + 100;
  const endX = termRect.right - 400;
  const endY = termRect.top + 300;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (startX + endX) / 2, y: (startY + endY) / 2, button: "left", pointerType: "mouse" });

  const boxDuringDrag = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.export-selection-box');
        if (!el) return JSON.stringify(null);
        return JSON.stringify({ hasToolbar: !!el.querySelector('.export-selection-toolbar') });
      })()
    `),
  );
  check("durante o arraste, o retângulo já aparece MAS sem a barra de formato ainda", boxDuringDrag?.hasToolbar, false);

  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y: endY, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));

  const boxAfterDrag = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.export-selection-box');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, hasToolbar: !!el.querySelector('.export-selection-toolbar') });
      })()
    `),
  );
  check("depois de soltar, a barra de formato (PNG/JPEG/PDF) aparece", boxAfterDrag?.hasToolbar, true);
  check("...com a largura do recorte batendo com o arraste real", Math.round(boxAfterDrag?.w), Math.abs(endX - startX));
  check("...e a altura também", Math.round(boxAfterDrag?.h), Math.abs(endY - startY));

  const formatLabels = await page.evalJs(`[...document.querySelectorAll('.export-selection-toolbar button')].map((b) => b.textContent.trim())`);
  check("os 3 formatos certos estão na barra (PNG, JPEG, PDF + cancelar)", JSON.stringify(formatLabels.slice(0, 3)), JSON.stringify(["PNG", "JPEG", "PDF"]));

  // ---- 3. cancelar some com o recorte, sem exportar nada ----
  const cancelBtn = await centerOf(page, ".export-selection-cancel");
  await page.click(cancelBtn.x, cancelBtn.y);
  await new Promise((r) => setTimeout(r, 200));
  const boxAfterCancel = await page.evalJs(`document.querySelector('.export-selection-box')`);
  check("cancelar remove o recorte da tela", boxAfterCancel, null);

  // ---- 4. pipeline real de captura/encode/escrita, por formato, via ponte de teste (dialog nativo não é dirigível por CDP) ----
  const rect = {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
  const results = {};
  for (const format of ["png", "jpeg", "pdf"]) {
    const outPath = `${OUT_DIR}/recorte.${format === "jpeg" ? "jpg" : format}`;
    const result = JSON.parse(
      await page.evalJs(`
        window.canvasExport.captureRectTest(${JSON.stringify(rect)}, ${JSON.stringify(format)}, ${JSON.stringify(outPath)}).then(JSON.stringify)
      `),
    );
    results[format] = { ...result, outPath };
  }

  check("captura+escrita real de PNG resolveu ok", results.png.ok, true);
  check("...o arquivo PNG existe de verdade em disco", existsSync(results.png.outPath), true);
  const pngBytes = readFileSync(results.png.outPath);
  check("...com a assinatura PNG real (89 50 4E 47)", pngBytes.subarray(0, 4).toString("hex"), "89504e47");
  // Achado ao vivo: um recorte 400x200 real (terminal com prompt esparso,
  // fundo escuro uniforme) compacta em PNG pra ~1KB de verdade — PNG é
  // ótimo com áreas de cor sólida. 600B ainda distingue isso de um
  // retângulo genuinamente vazio/monocromático (compactaria pra poucas
  // centenas de bytes, perto do mínimo de qualquer PNG válido).
  check("...e tamanho substancial (conteúdo real do terminal, não uma área vazia comprimida a quase nada)", statSync(results.png.outPath).size > 600, true);

  check("captura+escrita real de JPEG resolveu ok", results.jpeg.ok, true);
  const jpegBytes = readFileSync(results.jpeg.outPath);
  check("...com a assinatura JPEG real (FF D8 FF)", jpegBytes.subarray(0, 3).toString("hex"), "ffd8ff");

  check("captura+escrita+wrap real de PDF resolveu ok", results.pdf.ok, true);
  const pdfBytes = readFileSync(results.pdf.outPath);
  check("...começa com %PDF de verdade", pdfBytes.subarray(0, 4).toString(), "%PDF");

  // Verificação de verdade, não só "arquivo existe": pdfinfo/pdftoppm
  // (poppler-utils) conseguem abrir e rasterizar de volta o PDF gerado
  // pelo wrapper mínimo (pdf-export.ts) — prova que não é um PDF
  // corrompido/malformado que só "parece certo" nos bytes iniciais.
  try {
    const info = execFileSync("pdfinfo", [results.pdf.outPath], { encoding: "utf8" });
    const pageSizeLine = info.split("\n").find((l) => l.startsWith("Page size:"));
    check("pdfinfo (poppler) consegue abrir o PDF sem erro", true, true);
    const match = pageSizeLine?.match(/([\d.]+) x ([\d.]+)/);
    const pdfW = match ? Math.round(Number(match[1])) : null;
    const pdfH = match ? Math.round(Number(match[2])) : null;
    // `capturePage`'s NativeImage (and `wrapJpegAsPdf`'s page size, a raw
    // 1-pixel-= 1-point wrap with no DPI conversion) comes back in
    // PHYSICAL/device pixels — `devicePixelRatio` on this machine is
    // 1.5, not 1, so the PDF's real page size is CSS `rect` scaled by
    // that ratio, not `rect` itself. Achado ao vivo: this check
    // originally compared against raw `rect.width/height` and failed on
    // any HiDPI display for that reason alone — the PDF itself was
    // always correct (page size == embedded image size, no distortion).
    const dpr = await page.evalJs(`window.devicePixelRatio`);
    check("...com a largura da página batendo com o recorte (em pixels físicos)", pdfW, Math.round(rect.width * dpr));
    check("...e a altura também", pdfH, Math.round(rect.height * dpr));

    const ppmOut = `${OUT_DIR}/recorte-rasterizado`;
    execFileSync("pdftoppm", ["-png", "-r", "72", results.pdf.outPath, ppmOut]);
    const rasterized = `${ppmOut}-1.png`;
    check("pdftoppm consegue RASTERIZAR o PDF de volta pra um PNG real (não só declarar válido)", existsSync(rasterized), true);
    check("...com tamanho substancial (a imagem embutida decodificou, não é lixo/branco)", statSync(rasterized).size > 2000, true);
  } catch (err) {
    check(`pdfinfo/pdftoppm processaram o PDF sem lançar (${err.message?.slice(0, 120)})`, false, true);
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();

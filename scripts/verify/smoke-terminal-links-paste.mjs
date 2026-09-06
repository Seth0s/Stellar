// Pedido ao vivo (2026-08-27): "não consigo mandar foto pelo terminal" +
// "overlay de links atrapalhando na frente do terminal, acima do
// footer". Dois achados reais, dois fixes:
// 1. A tira de chips de URL era `position: absolute` por cima das linhas
//    do terminal, sem limite/expiração — virou um badge no footer +
//    popover sob demanda (TerminalCard.tsx/cards.css).
// 2. Não existia handler de paste de imagem — `useTerminal.ts` intercepta
//    um paste com conteúdo image/* (capture phase, antes do handler
//    padrão do xterm.js), salva um PNG real via main/clipboard-image.ts,
//    escreve o caminho no PTY.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-links-paste-${CDP_PORT}`, import.meta.url).pathname;

function pngFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => `${dir}/${f}`);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // spawnTerminal:true (default) já cria um terminal bash real.
  await bootIntoFreshSession(page, "Links e Paste Teste");
  await new Promise((r) => setTimeout(r, 600));

  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );
  check("terminal card id resolved", typeof cardId === "string" && cardId.length > 0, true);

  // ---- overlay de links: badge no footer + popover, nunca por cima do terminal ----
  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, "echo https://example.com/one https://example.com/two\\r")`);
  // Espera especificamente por "2", não só "truthy" — bash ecoa o
  // próprio comando digitado ANTES de rodá-lo, então o primeiro URL
  // costuma aparecer um instante antes do segundo; parar no primeiro
  // valor truthy pegaria "1" como se fosse o estado final.
  const deadline1 = Date.now() + 6000;
  let badgeText = null;
  while (Date.now() < deadline1) {
    badgeText = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('[data-role="terminal-url-badge"]')?.textContent ?? null)`));
    if (badgeText === "2") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("badge de links aparece no footer depois do bash imprimir 2 URLs", badgeText, "2");
  check(
    "o badge vive DENTRO do .card-foot (nunca mais uma tira absolute por cima do terminal)",
    await page.evalJs(`!!document.querySelector('[data-role="terminal-url-badge"]')?.closest('.card-foot')`),
    true,
  );
  check("a classe antiga (overlay absolute) não existe mais no DOM", await page.evalJs(`!document.querySelector('.terminal-card-urls')`), true);

  const badgeCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('[data-role="terminal-url-badge"]'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(badgeCoords.x, badgeCoords.y);
  await new Promise((r) => setTimeout(r, 250));
  check("popover abre com a lista completa de links", await page.evalJs(`document.querySelectorAll('[data-role="terminal-url-chip"]').length`), 2);

  // Clique no chip = copiar pro clipboard, com feedback visual real (só
  // depois que navigator.clipboard.writeText de fato resolveu).
  const chipCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('[data-role="terminal-url-chip"]'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(chipCoords.x, chipCoords.y);
  const deadline2 = Date.now() + 3000;
  let copied = false;
  while (Date.now() < deadline2) {
    copied = JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('[data-role="terminal-url-chip"][data-copied="true"]'))`));
    if (copied) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  check("clicar no link copia pro clipboard e mostra feedback visual real (não otimista)", copied, true);
  const clipboardText = await page.evalJs(`navigator.clipboard.readText()`);
  check("...e o clipboard do SO genuinamente contém a URL", clipboardText.includes("example.com"), true);

  // Botão "abrir" pede confirmação — ConfirmModal, não abertura direta.
  const openBtnCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('[data-role="terminal-url-open"]'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  const cardCountBefore = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.length);
      })()
    `),
  );
  await page.click(openBtnCoords.x, openBtnCoords.y);
  await new Promise((r) => setTimeout(r, 250));
  check("clicar em 'abrir' pede confirmação (ConfirmModal), não abre direto", await page.evalJs(`!!document.querySelector('.modal-root h3')`), true);
  check(
    "...com o título certo",
    await page.evalJs(`document.querySelector('.modal-root h3')?.textContent`),
    "Abrir link no navegador",
  );
  const cancelCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.modal-actions button.ghost'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(cancelCoords.x, cancelCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  const cardCountAfterCancel = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.length);
      })()
    `),
  );
  check("...cancelar realmente não abre nenhum card novo", cardCountAfterCancel, cardCountBefore);

  // Cancelar fecha o modal E, por ser um clique "fora" do popover, fecha
  // o Popover de links também (mesmo pointerdown-fora-fecha de
  // Popover.tsx) — o antigo `openBtnCoords` não existe mais no DOM.
  // Reabre o badge e relê as coordenadas antes do segundo round-trip.
  await page.click(badgeCoords.x, badgeCoords.y);
  await new Promise((r) => setTimeout(r, 250));
  const openBtnCoordsAgain = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('[data-role="terminal-url-open"]'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(openBtnCoordsAgain.x, openBtnCoordsAgain.y);
  await new Promise((r) => setTimeout(r, 250));
  const confirmCoords = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.modal-actions button.primary'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); })()`),
  );
  await page.click(confirmCoords.x, confirmCoords.y);
  await new Promise((r) => setTimeout(r, 400));
  const cardCountAfterConfirm = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.length);
      })()
    `),
  );
  check("...confirmar de fato abre um card de navegador novo", cardCountAfterConfirm, cardCountBefore + 1);

  // ---- paste de imagem: interceptado, salvo de verdade em disco, caminho enviado ao PTY ----
  // Diretório real (app.getPath('temp')/stellar-pastes) resolvido pelo
  // próprio app, não hardcoded aqui — via um round-trip real de
  // clipboardImage.save(), a MESMA função que o handler de paste chama.
  const testSaveResult = JSON.parse(await page.evalJs(`window.clipboardImage.save().then(JSON.stringify)`));
  check("...clipboard.save() falha honestamente quando NÃO há imagem real no clipboard ainda", testSaveResult.ok, false);

  await page.evalJs(`window.clipboardImage.testWriteImage()`);
  const realSaveResult = JSON.parse(await page.evalJs(`window.clipboardImage.save().then(JSON.stringify)`));
  check("depois de escrever uma imagem real no clipboard do SO, save() funciona", realSaveResult.ok, true);
  check("...e o PNG realmente existe em disco", existsSync(realSaveResult.path), true);
  const pngBytes = readFileSync(realSaveResult.path);
  check("...com assinatura PNG real (não um arquivo vazio/lixo)", pngBytes[0] === 0x89 && pngBytes[1] === 0x50, true);
  const stellarPastesDir = realSaveResult.path.slice(0, realSaveResult.path.lastIndexOf("/"));

  // Agora o caminho completo: dispatch de um paste sintético (com um
  // item image/* real) no container do terminal — meu listener de
  // captura deve interceptar (preventDefault), chamar o MESMO
  // clipboardImage.save() real (não mock), e escrever o caminho no PTY.
  const filesBefore = pngFilesIn(stellarPastesDir).length;
  const dispatchResultImage = JSON.parse(
    await page.evalJs(`
      (() => {
        const body = document.querySelector('[data-role="terminal-body"]');
        const dt = new DataTransfer();
        const file = new File([new Uint8Array([0])], 'paste.png', { type: 'image/png' });
        dt.items.add(file);
        const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const notPrevented = body.dispatchEvent(evt);
        return JSON.stringify(notPrevented);
      })()
    `),
  );
  check("um paste com imagem é interceptado (preventDefault chamado)", dispatchResultImage, false);
  const deadline3 = Date.now() + 3000;
  let toastSeen = false;
  while (Date.now() < deadline3) {
    toastSeen = JSON.parse(await page.evalJs(`JSON.stringify([...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('imagem colada')))`));
    if (toastSeen) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  check("toast de sucesso aparece depois do paste de imagem", toastSeen, true);
  await new Promise((r) => setTimeout(r, 300));
  const filesAfter = pngFilesIn(stellarPastesDir).length;
  check("...e um PNG NOVO de verdade foi criado em disco (não só a UI dizendo que sim)", filesAfter, filesBefore + 1);

  // Negativo: paste só de texto NÃO deve ser interceptado nem criar arquivo.
  const filesBeforeText = pngFilesIn(stellarPastesDir).length;
  const dispatchResultText = JSON.parse(
    await page.evalJs(`
      (() => {
        const body = document.querySelector('[data-role="terminal-body"]');
        const dt = new DataTransfer();
        dt.setData('text/plain', 'oi');
        const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        const notPrevented = body.dispatchEvent(evt);
        return JSON.stringify(notPrevented);
      })()
    `),
  );
  check("um paste só de texto NÃO é interceptado (comportamento padrão do xterm intacto)", dispatchResultText, true);
  await new Promise((r) => setTimeout(r, 300));
  check("...e nenhum PNG novo aparece por causa dele", pngFilesIn(stellarPastesDir).length, filesBeforeText);

  page.close();
} finally {
  await stopApp(app);
}
finish();

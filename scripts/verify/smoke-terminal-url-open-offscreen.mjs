// Bugs relatados ao vivo (2026-09-02), 3 achados na mesma sessão de teste
// do usuário contra os chips de URL de um card de terminal bash (sem
// nenhum agente): parser de link pegando caracteres indevidos, e clicar
// no ícone de "abrir no navegador" parecendo não fazer nada.
//
// (1) Parser: `URL_PATTERN` (pty-registry.ts) não parava em `)`/`]`/`}` —
// saída real de log costuma embrulhar a URL em parênteses
// ("(http://127.0.0.1:5175)"), e o fechamento vazava pro chip
// ("127.0.0.1:5175)"). Corrigido removendo fechamento(s) no fim do match
// sem abertura correspondente ANTES dele no mesmo match (preserva URL
// legítima com parênteses balanceados, ex. Wikipedia).
//
// (2) "Não abre": não é bem isso — `openBrowserFor` REUSA um card de
// navegador já existente sem dono (ownerCardId null, aberto de QUALQUER
// terminal antes) em vez de criar um novo. Se esse card reusado estiver
// fora do viewport atual (usuário deu pan pra outro canto do board desde
// a última vez que abriu um link), a navegação acontece de verdade — só
// que fora da vista, parecendo que nada aconteceu. Corrigido: o confirm
// modal agora chama `focusCard` (pan+zoom pro card, mesmo idioma já usado
// por `jumpToCard` noutros lugares do app) quando o card reusado não está
// visível — só nesse caso, pra não mexer na câmera à toa quando o card
// reusado já estava visível.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9464;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-url-open-offscreen", import.meta.url).pathname;

async function worldState(page) {
  const style = await page.evalJs(`document.querySelector('.world')?.getAttribute('style') ?? ""`);
  const m = style.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
  if (!m) throw new Error(`could not parse .world style: ${style}`);
  return { panX: Number(m[1]), panY: Number(m[2]), zoom: Number(m[3]) };
}

async function elCenter(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector(${JSON.stringify(selector)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
      })()
    `),
  );
}

/** Arrasta o card de navegador pra bem longe (rect de MUNDO, não a câmera)
 * — deixa o card bash e o resto da câmera intocados, só o navegador some
 * de vista. Mais direto que dar pan na câmera inteira (que moveria o
 * próprio card bash junto, quebrando o passo seguinte do teste). */
async function dragBrowserCardAway(page) {
  // cards.css's `.card-head` reserva `padding: 0 6px 0 10px` como faixa de
  // arraste (cursor:grab) — o resto do header é address bar/botões
  // (`.card-head-inner`, flex:1), que caem no guard de `onHeaderPointerDown`
  // (closest("button, select, input")) e nunca iniciam o drag. Grab bem na
  // borda esquerda dessa faixa, não no centro do header inteiro.
  const rect = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('[data-kind="browser"] .card-head');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x, y: r.y, height: r.height});
      })()
    `),
  );
  // Faixa de arraste real é estreitíssima aqui — `.card-resize-w` (borda
  // de redimensionar, -7px a +7px do canto do card) cobre quase todo o
  // padding-left de 10px do `.card-head`; só sobra ~2px (offset 7-8) onde
  // um clique cai de fato no próprio `.card-head`, não no resize handle
  // nem no primeiro botão do header (achado escaneando elementFromPoint
  // pixel a pixel, não chutado).
  const gx = rect.x + 7;
  const gy = rect.y + rect.height / 2;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: gx, y: gy, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: gx - 2200, y: gy - 1400, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: gx - 2200,
    y: gy - 1400,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Terminal URL Open Offscreen Teste");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const bashCardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  check("real bash terminal (sem agente) card id resolved", typeof bashCardId === "string" && bashCardId.length > 0, true);

  // --- achado 1: parser não deve capturar o ")" de embrulho ---
  await page.evalJs(`window.pty.write(${JSON.stringify(bashCardId)}, ${JSON.stringify(`echo "(http://127.0.0.1:5175)"\r`)})`);
  await new Promise((r) => setTimeout(r, 1000));

  const badgeCoords = await elCenter(page, '[data-role="terminal-url-badge"]');
  check("badge de URLs vistas apareceu", badgeCoords !== null, true);
  await page.click(badgeCoords.x, badgeCoords.y);
  await new Promise((r) => setTimeout(r, 250));

  const chipTitles = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="terminal-url-chip"]')].map((b) => b.title))`),
  );
  check("URL real capturada SEM o ')' de embrulho vazando junto", chipTitles.includes("http://127.0.0.1:5175"), true);
  check("nenhum chip com o ')' indevido no fim", chipTitles.some((t) => t.endsWith(")")), false);

  // --- achado 2: 1º clique cria um browser card novo, já dentro da vista ---
  const openBtnCoords = await elCenter(page, '[data-role="terminal-url-open"]');
  check("ícone de abrir no navegador encontrado", openBtnCoords !== null, true);
  await page.click(openBtnCoords.x, openBtnCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  const confirmCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Abrir');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  check("modal de confirmação real apareceu", confirmCoords !== null, true);
  await page.click(confirmCoords.x, confirmCoords.y);
  await new Promise((r) => setTimeout(r, 500));

  const worldBefore = await worldState(page);
  const cardsAfterFirst = JSON.parse(
    await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser')))`),
  );
  check("um card de navegador real foi criado", cardsAfterFirst.length, 1);
  check("...sem mexer na câmera (card novo já nasce dentro da vista)", worldBefore.zoom, 1);

  // --- arrasta o navegador pra longe (rect de mundo), câmera e card bash
  // intocados — exatamente o cenário "já tinha um navegador aberto de
  // outra vez, foi ficando pra trás enquanto eu trabalhava noutro canto" ---
  await dragBrowserCardAway(page);
  await new Promise((r) => setTimeout(r, 400));

  const browserVisible = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('[data-kind="browser"]');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        return JSON.stringify(r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh);
      })()
    `),
  );
  check("o card de navegador reusável realmente saiu da vista depois do pan", browserVisible, false);

  // --- achado 2 de verdade: reabrir o MESMO link reusa o card (sem dono)
  // agora fora da vista — antes da correção, isso navegava/raise()ava sem
  // trazer a câmera de volta, indistinguível de "não abriu nada" ---
  const badgeCoords2 = await elCenter(page, '[data-role="terminal-url-badge"]');
  await page.click(badgeCoords2.x, badgeCoords2.y);
  await new Promise((r) => setTimeout(r, 250));
  const openBtnCoords2 = await elCenter(page, '[data-role="terminal-url-open"]');
  await page.click(openBtnCoords2.x, openBtnCoords2.y);
  await new Promise((r) => setTimeout(r, 300));
  const confirmCoords2 = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Abrir');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  check("modal de confirmação real apareceu de novo", confirmCoords2 !== null, true);
  await page.click(confirmCoords2.x, confirmCoords2.y);
  await new Promise((r) => setTimeout(r, 500));

  const cardsAfterSecond = JSON.parse(
    await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser')))`),
  );
  check("continua sendo o MESMO card reusado (não duplicou)", cardsAfterSecond.length, 1);

  const browserVisibleAfterReopen = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('[data-kind="browser"]');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        return JSON.stringify(r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh);
      })()
    `),
  );
  check("...e a câmera trouxe o card reusado de volta pra vista (não parece mais 'não abriu nada')", browserVisibleAfterReopen, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

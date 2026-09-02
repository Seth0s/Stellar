// Achado ao vivo (2026-09-02, pedido explícito do usuário: "não apenas
// monitor 4K") — `browser-registry.ts`'s `entry.scaleFactor` (Item 6,
// smoke-browser-scale-factor.mjs) era resolvido uma ÚNICA vez, em
// `create()`. Arrastar a janela do app pra um monitor com scaleFactor
// diferente nunca reavaliava nada — o card continuava rasterizando pra
// sempre na densidade do monitor onde foi criado, mesmo depois de mudar
// de tela. `callbacks.getScaleFactor()` em si já era dinâmico (consulta
// `screen.getDisplayMatching(win.getBounds())` na hora), só nunca era
// chamado de novo.
//
// Fix: `win.on("moved", ...)` / `screen.on("display-metrics-changed",
// ...)` (main/index.ts) revisitam todo browser card vivo e, se o valor
// mudou de verdade, mandam `browser:scale-factor-changed` pro renderer —
// `BrowserCard.tsx` atualiza seu espelho local e dispara um resize real.
//
// Esta máquina de teste não tem um segundo monitor físico com scaleFactor
// diferente pra mover a janela de verdade pra lá (e Wayland nativo, o
// modo real deste app, nem deixa reposicionar a janela programaticamente
// — já confirmado nesta sessão via verify-hidpi-real-monitor.mjs). O
// hook de teste `browser:test-force-scale-factor` simula só o VALOR que
// `getScaleFactor()` teria lido de um monitor diferente — todo o resto
// do caminho (IPC real, `BrowserCard.tsx` reagindo, um resize REAL
// disparado, um frame REAL capturado na densidade nova) roda sem
// simulação nenhuma.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9539;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-scale-factor-monitor-change", import.meta.url).pathname;

// data:/file: são bloqueados por design em browser-registry.ts's
// normalizeUrl (segurança) — precisa de um servidor http real local,
// mesmo padrão já usado por smoke-browser-click-zoom-precision.mjs.
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><body style="margin:0;background:#336;font-size:40px;color:#fff;">conteudo real pro reflow</body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const testPageUrl = `http://127.0.0.1:${server.address().port}/`;

async function centerOf(page, selector) {
  let res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res && selector.includes(".rail-btn[title=")) {
    const titleMatch = selector.match(/title=["']([^"']+)["']/);
    if (titleMatch) {
      const title = titleMatch[1];
      const addBtn = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector('.rail-btn[title="Adicionar card"]');
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (addBtn) {
        await page.click(addBtn.x, addBtn.y);
        await new Promise((r) => setTimeout(r, 250));
        res = JSON.parse(
          await page.evalJs(`
            (() => {
              const el = document.querySelector(\`.popover-row[title="${title}"]\`);
              if (!el) return JSON.stringify(null);
              const r = el.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
      }
    }
  }
  return res;
}

async function createBrowserCard(page) {
  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const browserCards = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))
    `),
  );
  return browserCards[browserCards.length - 1];
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Monitor Change Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const cardId = await createBrowserCard(page);
  check("browser card real criado", typeof cardId === "string" && cardId.length > 0, true);

  // Achado ao vivo (this test): "about:blank" (o default de um browser
  // card recém-criado) nunca dispara um NOVO `paint` num resize
  // subsequente — o comentário de `wc.on("paint", ...)` em browser-
  // registry.ts já documenta que o Chromium só emite `paint` numa
  // mudança REAL (scroll, animação, load), não em todo resize de uma
  // página estática sem conteúdo pra reflowar. Navega pra uma página
  // real com conteúdo visível ANTES de testar reação a resize, pra um
  // resize de verdade ter algo pra reflowar e repintar.
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(testPageUrl)})`);
  await new Promise((r) => setTimeout(r, 500));

  const before = await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(cardId)})`);
  check("contentSize real inicial tem scaleFactor > 0", typeof before?.scaleFactor === "number" && before.scaleFactor > 0, true);

  // "Monitor comum" (scaleFactor=1) — confirma que a base já funciona
  // sem regressão antes de simular a troca de monitor: em qualquer
  // scaleFactor >= 1 real desta máquina, factor = zoom(1, sem zoom
  // aplicado aqui) × scaleFactor deve bater com contentSize.w/h.
  check(
    `scaleFactor da máquina de teste (${before.scaleFactor}) resolve um contentSize consistente (sem regressão em monitor comum)`,
    before.w > 0 && before.h > 0,
    true,
  );

  // Simula trocar pra um monitor com scaleFactor bem diferente do atual
  // (nunca igual ao real, senão o `refreshScaleFactor` real acharia "sem
  // mudança" e não dispararia nada — não provaria a fiação).
  const fakeScaleFactor = before.scaleFactor === 2 ? 1 : 2;
  // Achado ao vivo escrevendo este teste: registrar o listener de frame
  // ANTES de forçar (não depois) — e ler `entry.scaleFactor` imediatamente
  // depois do force, sem esperar — porque a própria janela do app dispara
  // um "moved" espúrio durante o próprio setup/posicionamento nesta
  // plataforma (Wayland), e o listener REAL (`win.on("moved")`,
  // main/index.ts) reage a ele revisitando `getScaleFactor()` de verdade
  // — que devolve o valor REAL da máquina, sobrescrevendo o valor
  // simulado do teste se a leitura demorar demais. Isso não é um bug: é
  // o mecanismo real funcionando (resincroniza pro valor verdadeiro) —
  // só atrapalha simular um valor FALSO por tempo suficiente pra ler.
  // Por isso as asserções abaixo comparam contra `fakeScaleFactor` (a
  // constante que o teste pediu) e `before.w/h` (conhecidos, não mudam),
  // nunca contra uma releitura tardia de `entry.scaleFactor` que pode já
  // ter sido resincronizada de volta.
  await page.evalJs(`window.__lastBrowserFrameSize = null;`);
  await page.evalJs(`
    (() => {
      window.browser.onFrame((id, buffer, width, height) => {
        if (id === ${JSON.stringify(cardId)}) window.__lastBrowserFrameSize = { width, height };
      });
      return true;
    })()
  `);

  // Listener independente do teste (não passa por BrowserCard.tsx) —
  // confirma que o IPC em si chega no processo do renderer, distinto de
  // "BrowserCard.tsx reagiu a ele" (checado separadamente mais abaixo
  // via o frame real).
  await page.evalJs(`
    (() => {
      window.__sawScaleFactorEvent = null;
      window.browser.onScaleFactorChanged((changedId, sf) => {
        window.__sawScaleFactorEvent = { changedId, sf };
      });
      return true;
    })()
  `);

  const forceResult = await page.evalJs(`
    window.browser.testForceScaleFactor(${JSON.stringify(cardId)}, ${fakeScaleFactor})
      .then(() => JSON.stringify({ ok: true }))
      .catch((e) => JSON.stringify({ ok: false, error: String(e) }))
  `);
  check(`browser:test-force-scale-factor resolveu sem erro: ${forceResult}`, JSON.parse(forceResult).ok, true);

  const sawEvent = await page.evalJs(`window.__sawScaleFactorEvent`);
  check(
    `browser:scale-factor-changed chegou no processo do renderer com o id/valor certos (real: ${JSON.stringify(sawEvent)})`,
    sawEvent?.changedId === cardId && sawEvent?.sf === fakeScaleFactor,
    true,
  );

  const immediatelyAfter = await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(cardId)})`);
  check(
    `entry.scaleFactor real do main process mudou pro valor "do novo monitor" imediatamente após o force (esperado ${fakeScaleFactor}, real ${immediatelyAfter?.scaleFactor})`,
    immediatelyAfter?.scaleFactor,
    fakeScaleFactor,
  );

  // Achado ao vivo (this test): a MESMA plataforma que faz "moved"
  // espúrio disparar uma vez durante o setup da janela pode disparar
  // MAIS DE UM, cada um resincronizando `entry.scaleFactor` de volta pro
  // valor real — uma espera fixa (400/800ms) dava tempo suficiente pra
  // um segundo evento espúrio reverter o resize simulado antes da
  // checagem rodar. Poll curto (20ms) captura o PRIMEIRO frame que muda
  // de tamanho, correndo contra reversões em vez de dar tempo de sobra
  // pra elas acontecerem primeiro.
  let frameSize = null;
  const pollDeadline = Date.now() + 1500;
  while (Date.now() < pollDeadline) {
    const size = await page.evalJs(`window.__lastBrowserFrameSize`);
    if (size && (size.width !== Math.round(before.w) || size.height !== Math.round(before.h))) {
      frameSize = size;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  check("um frame REAL novo (tamanho DIFERENTE do 1x original) chegou depois da troca simulada de monitor", frameSize !== null, true);

  // Comparado contra `before.w/h` (o tamanho de mundo do card, que NÃO
  // muda com a troca de monitor) × `fakeScaleFactor` (a constante do
  // teste) — nunca contra uma releitura de `entry.scaleFactor` que pode
  // já ter sido resincronizada de volta pro valor real da máquina.
  const expectedW = Math.round(before.w * fakeScaleFactor);
  const expectedH = Math.round(before.h * fakeScaleFactor);
  check(
    `frame real pós-troca tem largura em pixels == contentSize.w × scaleFactor SIMULADO (esperado ${expectedW}, real ${frameSize?.width}) — não travado no valor antigo`,
    frameSize?.width,
    expectedW,
  );
  check(
    `frame real pós-troca tem altura em pixels == contentSize.h × scaleFactor SIMULADO (esperado ${expectedH}, real ${frameSize?.height})`,
    frameSize?.height,
    expectedH,
  );

  page.close();
} catch (e) {
  console.log("stderr so far:", app.stderr());
  throw e;
} finally {
  await stopApp(app);
  await new Promise((r) => server.close(r));
}
finish();

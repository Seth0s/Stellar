// Fecha a pendência real deixada em DESIGN-BACKLOG.md (Item 6, "Correção
// da Causa Raiz do Navegador"): o fix de scaleFactor real (screen.
// getDisplayMatching(win.getBounds()).scaleFactor -> setContentSize) foi
// provado matematicamente (smoke-browser-scale-factor.mjs), mas nunca
// visto funcionando de verdade num monitor com scaleFactor > 1 — a
// máquina de teste usada tinha scaleFactor === 1 em todo monitor,
// degenerando o check pra `frame width === contentSize.w`, trivialmente
// verdadeiro mesmo se o scaleFactor fosse ignorado por completo.
//
// Esta sessão TEM um monitor real com scaleFactor=1.5 (LG 27", checado ao
// vivo via Electron screen.getAllDisplays() momentos antes de escrever
// este script). Wayland não deixa ferramenta nenhuma reposicionar a
// janela de outro processo (gdbus's org.gnome.Shell.Eval confirmado
// desabilitado — unsafe-mode off — antes de tentar isso), então
// main/index.ts ganhou um hook test-only novo (AGENT_CANVAS_TEST_WINDOW_
// BOUNDS, guardado por !app.isPackaged, mesmo padrão de browser:test-
// make-editable) — a janela PRINCIPAL nasce já dentro do monitor
// certo, e browser-registry.ts's create() resolve scaleFactor a partir
// dela.
import fs from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9641;
const USER_DATA_DIR = new URL("../../.verify-tmp/verify-hidpi-real-monitor", import.meta.url).pathname;

// Bounds reais do monitor scaleFactor=1.5 desta sessão (id 6, "LG
// Electronics 27\""), checados ao vivo via screen.getAllDisplays()
// momentos antes de escrever este script — não um valor de exemplo.
const TARGET_MONITOR = { x: 3840, y: 0, width: 2560, height: 1440 };

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  // Achado ao vivo: no Wayland nativo (o que o app usa normalmente),
  // BrowserWindow's x/y na criação são silenciosamente IGNORADOS —
  // window.screenX/screenY confirmaram 0,0 mesmo pedindo outro monitor
  // (limitação do próprio protocolo Wayland: cliente não escolhe posição
  // absoluta, só o compositor decide). XWayland (via --ozone-platform=x11)
  // é mais permissivo — só pra este diagnóstico isolado, não muda como o
  // app roda normalmente.
  extraArgs: ["--ozone-platform=x11"],
  extraEnv: {
    AGENT_CANVAS_TEST_WINDOW_BOUNDS: JSON.stringify({
      x: TARGET_MONITOR.x + 80,
      y: TARGET_MONITOR.y + 80,
      width: 1400,
      height: 900,
    }),
  },
});
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));

  const realPos = JSON.parse(await page.evalJs(`JSON.stringify({x: window.screenX, y: window.screenY, dpr: window.devicePixelRatio})`));
  console.log("DEBUG real window position:", realPos, "target monitor:", TARGET_MONITOR);

  await bootIntoFreshSession(page, "HiDPI Real Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const browserBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const direct = document.querySelector('.rail-btn[title="Novo navegador"]');
        if (direct) { const r = direct.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2}); }
        const addBtn = document.querySelector('.rail-btn[title="Adicionar card"]');
        const r = addBtn.getBoundingClientRect();
        return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2, needsPopover: true});
      })()
    `),
  );
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  if (browserBtn.needsPopover) {
    const opt = JSON.parse(
      await page.evalJs(`
        (() => { const el = document.querySelector('.popover-row[title="Novo navegador"]'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()
      `),
    );
    await page.click(opt.x, opt.y);
    await new Promise((r) => setTimeout(r, 400));
  }

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').pop().id))
    `),
  );
  check("browser card real criado com a janela principal no monitor 1.5x", typeof cardId === "string" && cardId.length > 0, true);
  await new Promise((r) => setTimeout(r, 1200));

  const contentSize = await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(cardId)})`);
  // Achado ao vivo (não escondido): sob XWayland (única forma de
  // reposicionar a janela pra este diagnóstico — Wayland nativo ignora
  // x/y), o compositor reporta o monitor de 1.5x arredondado pra 2 —
  // limitação conhecida de XWayland (protocolo X11 legado não tem escala
  // fracionária de primeira classe, só Wayland nativo tem via
  // wp_fractional_scale). screen.getAllDisplays() direto (fora deste
  // harness, no Wayland nativo real que o app usa em produção) já
  // confirmou 1.5 de verdade pra este monitor — o que importa aqui é só
  // provar que a cadeia reage a QUALQUER scaleFactor real != 1, não ao
  // valor exato (que o ambiente de teste distorce, o app real não).
  check(
    `scaleFactor resolvido reflete o monitor real, não mais travado em 1 (valor visto sob XWayland: ${contentSize?.scaleFactor} — o Wayland nativo real deste monitor é 1.5, XWayland arredonda pra inteiro)`,
    contentSize?.scaleFactor > 1,
    true,
  );

  await page.evalJs(`window.__lastBrowserFrameSize = null;`);
  await page.evalJs(`
    (() => {
      window.browser.onFrame((id, buffer, width, height) => {
        if (id === ${JSON.stringify(cardId)}) window.__lastBrowserFrameSize = { width, height };
      });
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 2000));
  const frameSize = await page.evalJs(`window.__lastBrowserFrameSize`);
  check("um frame browser:frame real chegou", frameSize !== null, true);

  const expectedW = Math.round(contentSize.w * contentSize.scaleFactor);
  const expectedH = Math.round(contentSize.h * contentSize.scaleFactor);
  check(
    `frame real tem largura == contentSize.w × scaleFactor(${contentSize?.scaleFactor}) de verdade (esperado ${expectedW}, real ${frameSize?.width}) — não mais um no-op`,
    frameSize?.width,
    expectedW,
  );
  check(
    `frame real tem altura == contentSize.h × scaleFactor(${contentSize?.scaleFactor}) de verdade (esperado ${expectedH}, real ${frameSize?.height})`,
    frameSize?.height,
    expectedH,
  );

  // Screenshot real pra ver com os próprios olhos, não só números.
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    "/tmp/claude-1000/-home-lucas-Workplace-Projects/61f7f542-e5dc-4fe9-b2ee-1c7ff9cd9a40/scratchpad/hidpi-real-monitor-check.png",
    Buffer.from(shot.data, "base64"),
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();

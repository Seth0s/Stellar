// Relatado ao vivo (2026-09-06, screenshot): a bússola (`Compass.tsx`)
// sobrepunha o breadcrumb da topbar (`.topbar-title`) quando ele ficava
// comprido o bastante — a fita usava `left:50%` da JANELA inteira, sem
// nenhuma noção da largura real dos vizinhos na mesma linha. Fix:
// `Compass.tsx` mede `.topbar-title`/`.zoom-pill` (ResizeObserver) e
// encolhe/reposiciona a própria largura (`stripWidth`/`stripLeft`) pra
// nunca desenhar por cima deles — pedido do usuário: "apenas coloque
// limites de tamanho ocupado" + a mesma ideia de "bolinhas de gude numa
// linha reta" (acumular/comprimir em vez de vazar) que o empacotamento
// de chips já fazia internamente, agora aplicada contra os VIZINHOS
// externos também.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-compass-topbar-collision-${CDP_PORT}`, import.meta.url).pathname;
const LONG_NAME =
  "Sessao Com Um Nome Extremamente Comprido De Proposito Para Forcar Colisao Com A Bussola No Meio Da Topbar";

async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res) throw new Error(`element not found: ${selector}`);
  return res;
}

async function rectOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width });
      })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Bussola Colisao");
  await new Promise((r) => setTimeout(r, 500));

  // 3 cards fora da tela (mesma receita de smoke-compass.mjs) — sem isso
  // a bússola nem renderiza, nada pra colidir.
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === 'Bussola Colisao');
      const base = { board_id: board.id, provider: '', resume_id: null, model: null, system_prompt: null, group_id: null, updated_at: Date.now() };
      await window.store.upsert({ ...base, id: 'ccol-a', kind: 'files', cwd: '/tmp', label: 'alvo-a', x: 100, y: 1000, w: 200, h: 150 });
      await window.store.upsert({ ...base, id: 'ccol-b', kind: 'files', cwd: '/tmp', label: 'alvo-b', x: 2400, y: 100, w: 200, h: 150 });
      await window.store.upsert({ ...base, id: 'ccol-c', kind: 'files', cwd: '/tmp', label: 'alvo-c', x: -4200, y: 100, w: 200, h: 150 });
    })()
  `);

  // Reabre a sessão (mesmo fluxo do smoke-compass.mjs) pra loadBoard
  // pegar as 3 cards novas do banco — um upsert cru não atualiza o
  // estado `cards` ao vivo do App.tsx sozinho.
  const homeBtn = await centerOf(page, ".topbar-home");
  await page.click(homeBtn.x, homeBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const sessionBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.home-session-name')].find((x) => x.textContent.includes('Bussola Colisao'))?.closest('button');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!sessionBtn) throw new Error("session button not found");
  await page.click(sessionBtn.x, sessionBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  // Renomeia via o fluxo REAL de UI (não outro upsert cru, que não
  // atualiza o `activeBoard` em memória do App.tsx) — abre o popover do
  // breadcrumb, clica o lápis de editar da própria sessão ativa, digita
  // um nome bem comprido no campo controlado (setter nativo + evento
  // 'input', truque padrão pra um <input> controlado por React) e salva.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const editBtn = await centerOf(page, '[data-role="edit-session"]');
  await page.click(editBtn.x, editBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  await page.evalJs(`
    (() => {
      const input = document.querySelector('.modal .resume-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(LONG_NAME)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const saveBtn = await centerOf(page, ".modal-actions button.primary");
  await page.click(saveBtn.x, saveBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  const stripFound = await page.evalJs(`JSON.stringify(!!document.querySelector('[data-role="compass"]'))`);
  check("com nome de board comprido, a bússola ainda aparece (3 cards fora da tela)", stripFound, "true");

  const titleRect = await rectOf(page, ".topbar-title");
  const stripRect = await rectOf(page, '[data-role="compass"]');
  const zoomRect = await rectOf(page, ".zoom-pill");
  console.log("DEBUG rects:", { titleRect, stripRect, zoomRect });

  check(
    "a fita da bússola não começa antes do fim do breadcrumb comprido (.topbar-title)",
    stripRect.left >= titleRect.right,
    true,
  );
  check(
    "a fita da bússola não termina depois do início da área de zoom (.zoom-pill)",
    stripRect.right <= zoomRect.left,
    true,
  );
  check("a fita ainda tem uma largura utilizável (não colapsou a zero)", stripRect.width > 50, true);

  // Ainda clicável / funcional depois de encolhida — não virou decoração morta.
  async function anyFilesCardInView() {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const frames = [...document.querySelectorAll('.files-card')].map((f) => f.closest('.card-frame'));
          return JSON.stringify(frames.some((f) => {
            const r = f.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            return cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
          }));
        })()
      `),
    );
  }
  const firstChip = JSON.parse(
    await page.evalJs(`
      (() => {
        const chip = document.querySelector('[data-role="compass-chip"]');
        if (!chip) return JSON.stringify(null);
        const r = chip.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(firstChip.x, firstChip.y);
  await new Promise((r) => setTimeout(r, 400));
  check("mesmo encolhida, clicar num chip ainda foca o card correspondente", await anyFilesCardInView(), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

// Pendentes #188 — achado ao vivo (2026-09-06, screenshot real): 2 chips
// de rótulo comprido se sobrepunham quase inteiros ("terminal" escondia
// outro chip atrás), porque o espaçador original usava um "gap" fixo de
// centro-a-centro em vez da largura REAL de cada chip. Pedido do usuário:
// "imagina pra 20 cards diferentes, deve ter uma organização, talvez
// apenas ícones dependendo da situação". Este teste cobre os dois casos:
// poucos cards (modo completo, espaçamento real por largura estimada) e
// muitos cards (modo compacto, só ícone, sem sobreposição nenhuma).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-compass-scale-${CDP_PORT}`, import.meta.url).pathname;

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

// `angles` (graus): quando dado, usa esses rumos exatos em vez de
// distribuir uniformemente — é assim que se reproduz o bug real (2 chips
// com rumo quase igual, rótulo comprido, se sobrepondo).
async function seedCardsAtAngles(page, boardName, angles, labelPrefix, idPrefix) {
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === ${JSON.stringify(boardName)});
      const base = { board_id: board.id, provider: '', resume_id: null, model: null, system_prompt: null, group_id: null, updated_at: Date.now() };
      const R = 3000;
      const angles = ${JSON.stringify(angles)};
      for (let i = 0; i < angles.length; i++) {
        const rad = (angles[i] * Math.PI) / 180;
        const x = Math.round(R * Math.cos(rad));
        const y = Math.round(R * Math.sin(rad));
        await window.store.upsert({
          ...base,
          id: ${JSON.stringify(idPrefix)} + i,
          kind: 'files',
          cwd: '/tmp',
          label: ${JSON.stringify(labelPrefix)} + i,
          x, y, w: 200, h: 150,
        });
      }
    })()
  `);
}

async function seedCardsOnRing(page, boardName, count, labelPrefix, idPrefix) {
  const angles = Array.from({ length: count }, (_, i) => (i / count) * 360);
  await seedCardsAtAngles(page, boardName, angles, labelPrefix, idPrefix);
}

async function reopenSession(page, boardName) {
  const homeBtn = await centerOf(page, ".topbar-home");
  await page.click(homeBtn.x, homeBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const sessionBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.home-session-name')].find((x) => x.textContent.includes(${JSON.stringify(boardName)}))?.closest('button');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(sessionBtn.x, sessionBtn.y);
  await new Promise((r) => setTimeout(r, 800));
}

async function chipRects(page) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const chips = [...document.querySelectorAll('[data-role="compass-chip"]')];
        return JSON.stringify(chips.map((c) => {
          const r = c.getBoundingClientRect();
          return { left: r.left, right: r.right, title: c.getAttribute('title') };
        }));
      })()
    `),
  );
}

function anyOverlap(rects) {
  const sorted = [...rects].sort((a, b) => a.left - b.left);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].left < sorted[i - 1].right) return { a: sorted[i - 1], b: sorted[i] };
  }
  return null;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));

  // --- Caso 1: poucos cards, rótulo curto (modo completo) — a regressão
  // relatada ao vivo era JUSTAMENTE com poucos chips (2, rótulo tipo
  // "terminal") colidindo, rumos bem próximos um do outro. 2 dos 4 ângulos
  // abaixo ficam a só 8° de distância de propósito — exatamente o cenário
  // que colidia com o espaçador antigo (gap fixo de centro-a-centro).
  // Rótulo CURTO de propósito: a soma de larguras cabe na fita, então
  // exercita o modo completo (não o compacto — esse é o caso 2 abaixo).
  await bootIntoFreshSession(page, "Bussola Escala Poucos");
  await new Promise((r) => setTimeout(r, 500));
  await seedCardsAtAngles(page, "Bussola Escala Poucos", [40, 48, 160, 260], "term-", "few-");
  await reopenSession(page, "Bussola Escala Poucos");

  const fewInfo = JSON.parse(
    await page.evalJs(`JSON.stringify({ compact: document.querySelector('[data-role="compass"]')?.getAttribute('data-compact'), count: document.querySelectorAll('[data-role="compass-chip"]').length })`),
  );
  check("com 4 cards de rótulo curto (cabe na fita), a fita usa o modo COMPLETO", fewInfo.compact, "false");
  check("...e mostra os 4 chips (nenhum truncado)", fewInfo.count, 4);

  const fewRects = await chipRects(page);
  const fewOverlap = anyOverlap(fewRects);
  console.log("DEBUG modo completo, rects:", JSON.stringify(fewRects), "overlap:", JSON.stringify(fewOverlap));
  check("nenhum par de chips (modo completo) se sobrepõe de verdade", fewOverlap, null);

  // --- Caso 2: muitos cards (modo compacto) — o pedido original do
  // usuário, "imagina pra 20 cards diferentes". `bootIntoFreshSession` só
  // cria sessão nova quando a `.home` está na tela — depois do caso 1 já
  // estamos DENTRO de um board, então volta pra home primeiro.
  const homeBtnBack = await centerOf(page, ".topbar-home");
  await page.click(homeBtnBack.x, homeBtnBack.y);
  await new Promise((r) => setTimeout(r, 300));
  await bootIntoFreshSession(page, "Bussola Escala Muitos");
  await new Promise((r) => setTimeout(r, 500));
  await seedCardsOnRing(page, "Bussola Escala Muitos", 20, "card-", "many-");
  await reopenSession(page, "Bussola Escala Muitos");

  const manyInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const strip = document.querySelector('[data-role="compass"]');
        return JSON.stringify({
          compact: strip?.getAttribute('data-compact'),
          chipCount: document.querySelectorAll('[data-role="compass-chip"]').length,
          moreText: document.querySelector('.compass-more')?.textContent ?? null,
        });
      })()
    `),
  );
  console.log("DEBUG modo compacto info:", JSON.stringify(manyInfo));
  check("com 20 cards fora da tela, a fita troca pro modo COMPACTO", manyInfo.compact, "true");
  check("...mostra pelo menos alguns chips (não fica vazia)", manyInfo.chipCount > 0, true);
  check("...e o restante vira um chip \"+N\" (não trava nem estoura em ícones minúsculos demais)", manyInfo.moreText !== null, true);

  const manyRects = await chipRects(page);
  const manyOverlap = anyOverlap(manyRects);
  console.log("DEBUG modo compacto, overlap:", JSON.stringify(manyOverlap));
  check("nenhum par de chips (modo compacto, 20 cards) se sobrepõe de verdade", manyOverlap, null);

  // Clicar num chip específico ainda funciona no modo compacto (o rótulo
  // só existe no title/tooltip agora, mas o clique continua indo pro card
  // certo).
  const someTitle = manyRects[Math.floor(manyRects.length / 2)].title;
  const target = JSON.parse(
    await page.evalJs(`
      (() => {
        const chip = [...document.querySelectorAll('[data-role="compass-chip"]')].find((c) => c.getAttribute('title') === ${JSON.stringify(someTitle)});
        if (!chip) return JSON.stringify(null);
        const r = chip.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(target.x, target.y);
  await new Promise((r) => setTimeout(r, 400));
  const anyInView = JSON.parse(
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
  check("clicar um chip compacto ainda traz um card pra viewport", anyInView, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

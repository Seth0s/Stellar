// Pendentes #188 — bússola de navegação na topbar (2026-09-06, pedido do
// usuário: "aceito a bússola centralizada, será organizado — antes ficava
// espalhado pela tela"). Substitui os antigos offscreen-pips (D3) por um
// único pill centralizado que aponta pro card mais PRÓXIMO fora da tela e,
// a cada clique, foca o atual e avança pro próximo — visita todos em
// sequência sem lista nenhuma (decisão do usuário).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-compass-${CDP_PORT}`, import.meta.url).pathname;

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Bussola Teste");
  await new Promise((r) => setTimeout(r, 500));

  check(
    "sem nenhum card fora da tela, a bússola não aparece",
    await page.evalJs(`JSON.stringify(!document.querySelector('[data-role="compass"]'))`),
    "true",
  );

  // 3 cards bem fora da viewport, em direções distintas (mundo == tela
  // aqui: board recém-carregado, pan/zoom padrão) — cada um com um `label`
  // único, que vira o texto da bússola (Compass.tsx: `card.label ?? ...`),
  // dando uma forma de identificar QUAL foi visitado sem precisar
  // reimplementar a transformação pan/zoom aqui pra mapear DOM -> id.
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === 'Bussola Teste');
      const base = { board_id: board.id, provider: '', resume_id: null, model: null, system_prompt: null, group_id: null, updated_at: Date.now() };
      await window.store.upsert({ ...base, id: 'compass-right', kind: 'files', cwd: '/tmp', label: 'alvo-direita', x: 2400, y: 100, w: 200, h: 150 });
      await window.store.upsert({ ...base, id: 'compass-below', kind: 'files', cwd: '/tmp', label: 'alvo-abaixo', x: 100, y: 1600, w: 200, h: 150 });
      await window.store.upsert({ ...base, id: 'compass-farleft', kind: 'files', cwd: '/tmp', label: 'alvo-longe-esquerda', x: -1900, y: -1900, w: 200, h: 150 });
    })()
  `);

  // Reabre a sessão pra loadBoard pegar as linhas novas do banco.
  const homeBtn = await centerOf(page, ".topbar-home");
  await page.click(homeBtn.x, homeBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const sessionBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.home-session-name')].find((x) => x.textContent.includes('Bussola Teste'))?.closest('button');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(sessionBtn.x, sessionBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  const compassInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const c = document.querySelector('[data-role="compass"]');
        return JSON.stringify({ found: !!c, title: c?.getAttribute('title') });
      })()
    `),
  );
  check("com 3 cards fora da tela, a bússola aparece", compassInfo.found, true);
  check("...e o título indica 3 cards fora da tela", compassInfo.title.includes("3"), true);

  const compassCoords = await centerOf(page, '[data-role="compass"]');
  const LABELS = ["alvo-direita", "alvo-abaixo", "alvo-longe-esquerda"];

  // Qual dos 3 alvos a bússola aponta ANTES do clique (extrai do título:
  // "Focar em <label> — N/3 cards fora da tela").
  async function compassTargetLabel() {
    const title = await page.evalJs(`document.querySelector('[data-role="compass"]')?.getAttribute('title') ?? ''`);
    return LABELS.find((l) => title.includes(l)) ?? null;
  }

  // Depois do clique, o alvo deve ter sido trazido de fato pra viewport —
  // checa via DOM real (getBoundingClientRect pós-transform), não
  // reimplementando a matemática de pan/zoom aqui. `.files-card` não
  // carrega o `label` como atributo, então soma quantos `.files-card`
  // frames têm o centro dentro da tela — o alvo focado deve ser um deles.
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

  const visitedTargets = [];
  const broughtIntoView = [];
  for (let i = 0; i < 3; i++) {
    const target = await compassTargetLabel();
    visitedTargets.push(target);
    await page.click(compassCoords.x, compassCoords.y);
    await new Promise((r) => setTimeout(r, 400));
    broughtIntoView.push(await anyFilesCardInView());
  }
  console.log("DEBUG visitedTargets:", JSON.stringify(visitedTargets), "broughtIntoView:", JSON.stringify(broughtIntoView));

  check("cada clique na bússola traz um card de arquivos pra dentro da viewport", broughtIntoView.every(Boolean), true);

  const allThreeDistinctTargets = new Set(visitedTargets);
  check("em 3 cliques, a bússola apontou pros 3 alvos diferentes (cicla, não repete)", allThreeDistinctTargets.size, 3);

  page.close();
} finally {
  await stopApp(app);
}
finish();

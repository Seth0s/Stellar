// Pendentes #188 — bússola de navegação na topbar (2026-09-06, pedido do
// usuário). 2ª versão no mesmo dia: a 1ª (pill único que ciclava um alvo
// por vez) não era o que o usuário tinha em mente — pediu um estilo de
// jogo, fita horizontal com vários ícones clicáveis ao mesmo tempo,
// posicionados pelo rumo real (setas, não texto de ângulo), com selo de
// "níveis de distância" por ícone, medida a partir do centro da viewport
// atual (não do centro fixo do board).
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

  // 3 cards bem fora da viewport, em direções e distâncias distintas
  // (mundo == tela aqui: board recém-carregado, pan/zoom padrão) — cada um
  // com um `label` único (vira o `title` do chip), e escolhidos pra cair
  // em 3 níveis de distância diferentes (perto/médio/longe, ver
  // Compass.tsx's `distanceTier`: viewport ~1280x800, diagonal ~1509).
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === 'Bussola Teste');
      const base = { board_id: board.id, provider: '', resume_id: null, model: null, system_prompt: null, group_id: null, updated_at: Date.now() };
      // dist ~807 (<=1509) -> tier 3 (perto)
      await window.store.upsert({ ...base, id: 'compass-near', kind: 'files', cwd: '/tmp', label: 'alvo-perto', x: 100, y: 1000, w: 200, h: 150 });
      // dist ~1785 (<=3772) -> tier 2 (médio)
      await window.store.upsert({ ...base, id: 'compass-mid', kind: 'files', cwd: '/tmp', label: 'alvo-medio', x: 2400, y: 100, w: 200, h: 150 });
      // dist ~4849 (>3772) -> tier 1 (longe)
      await window.store.upsert({ ...base, id: 'compass-far', kind: 'files', cwd: '/tmp', label: 'alvo-longe', x: -4200, y: 100, w: 200, h: 150 });
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

  const chipsInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const strip = document.querySelector('[data-role="compass"]');
        const chips = [...document.querySelectorAll('[data-role="compass-chip"]')];
        return JSON.stringify({
          stripFound: !!strip,
          count: chips.length,
          titles: chips.map((c) => c.getAttribute('title')),
        });
      })()
    `),
  );
  check("com 3 cards fora da tela, a fita da bússola aparece", chipsInfo.stripFound, true);
  check("...e existe um chip clicável por card fora da tela (3)", chipsInfo.count, 3);
  check(
    "...e os 3 chips têm rótulos distintos (um por alvo)",
    new Set(chipsInfo.titles.map((t) => t.replace("Focar em ", ""))).size,
    3,
  );

  async function ringsFilledFor(labelSubstr) {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const chip = [...document.querySelectorAll('[data-role="compass-chip"]')].find((c) => c.getAttribute('title').includes(${JSON.stringify(labelSubstr)}));
          if (!chip) return JSON.stringify(null);
          return JSON.stringify(chip.querySelectorAll('.compass-ring.filled').length);
        })()
      `),
    );
  }

  const nearRings = await ringsFilledFor("alvo-perto");
  const midRings = await ringsFilledFor("alvo-medio");
  const farRings = await ringsFilledFor("alvo-longe");
  console.log("DEBUG rings (near/mid/far):", nearRings, midRings, farRings);
  check("selo de distância: o alvo PERTO tem mais anéis preenchidos que o MÉDIO", nearRings > midRings, true);
  check("selo de distância: o alvo MÉDIO tem mais anéis preenchidos que o LONGE", midRings > farRings, true);

  // Cada chip clicado deve trazer de fato seu próprio card pra viewport —
  // checa via DOM real (getBoundingClientRect pós-transform), não
  // reimplementando a matemática de pan/zoom aqui.
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

  async function clickChip(labelSubstr) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const chip = [...document.querySelectorAll('[data-role="compass-chip"]')].find((c) => c.getAttribute('title').includes(${JSON.stringify(labelSubstr)}));
          if (!chip) return JSON.stringify(null);
          const r = chip.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    await page.click(coords.x, coords.y);
    await new Promise((r) => setTimeout(r, 400));
  }

  await clickChip("alvo-medio");
  check("clicar num chip específico traz o card correspondente pra viewport", await anyFilesCardInView(), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

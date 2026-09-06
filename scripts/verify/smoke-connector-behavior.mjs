// Pendentes #188 — "conectores 100% decorativos (App.tsx), sem efeito
// real nenhum". Este teste cobre o que deixou de ser decorativo: (1) o
// `kind` do conector (antes só no banco, invisível pro render) agora
// muda a classe CSS/cor da linha; (2) clicar na curva do conector (não
// só no ×) navega de verdade pro card de destino — reusa `jumpToCard`,
// o mesmo mecanismo da bússola.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-connector-behavior-${CDP_PORT}`, import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Conector Runtime", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  // 3 cards: "a" (âncora, dentro da viewport), "b" bem fora dela
  // (destino do conector kind:'spawned' — testa clique-navega), "c"
  // perto de "a" (ambos em tela — testa que o × de deletar continua
  // funcionando; um conector com um extremo fora de tela deixa o midpoint
  // do próprio × também fora de tela, então não dá pra testar delete no
  // mesmo par a→b).
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === 'Conector Runtime');
      const base = { board_id: board.id, provider: '', resume_id: null, model: null, system_prompt: null, group_id: null, updated_at: Date.now() };
      await window.store.upsert({ ...base, id: 'conn-a', kind: 'files', cwd: '/tmp', label: 'origem', x: 100, y: 100, w: 200, h: 150 });
      await window.store.upsert({ ...base, id: 'conn-b', kind: 'files', cwd: '/tmp', label: 'destino', x: 5000, y: 100, w: 200, h: 150 });
      await window.store.upsert({ ...base, id: 'conn-c', kind: 'files', cwd: '/tmp', label: 'vizinho', x: 500, y: 400, w: 200, h: 150 });
      await window.store.connectors.upsert({
        id: 'conn-spawned-1', board_id: board.id, from_card_id: 'conn-a', to_card_id: 'conn-b',
        updated_at: Date.now(), kind: 'spawned',
      });
      await window.store.connectors.upsert({
        id: 'conn-manual-1', board_id: board.id, from_card_id: 'conn-a', to_card_id: 'conn-c',
        updated_at: Date.now(), kind: null,
      });
    })()
  `);

  // Reabre a sessão pra loadBoard pegar as linhas novas do banco (cards E
  // conector, incluindo o `kind` — useBoardStore.ts's loadBoard).
  const homeBtn = await centerOf(page, ".topbar-home");
  await page.click(homeBtn.x, homeBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const sessionBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.home-session-name')].find((x) => x.textContent.includes('Conector Runtime'))?.closest('button');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(sessionBtn.x, sessionBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  const lineInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const line = document.querySelector('.connector-line--spawned');
        if (!line) return JSON.stringify(null);
        const title = line.querySelector('title')?.textContent ?? null;
        return JSON.stringify({ found: true, title, className: line.getAttribute('class') });
      })()
    `),
  );
  console.log("DEBUG lineInfo:", JSON.stringify(lineInfo));
  check("conector kind:'spawned' renderiza com a classe connector-line--spawned (não mais 100% decorativo)", lineInfo?.found, true);
  check("...e carrega um <title> com o rótulo do kind (tooltip real)", lineInfo?.title, "spawn: quem criou quem");

  // "destino" nasce bem fora da viewport (x=5000) — nenhum .files-card
  // dele deveria estar visível ainda.
  async function destinoInView() {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const frames = [...document.querySelectorAll('.files-card')].map((f) => f.closest('.card-frame'));
          const target = frames.find((f) => f && f.textContent.includes('destino'));
          if (!target) return JSON.stringify(false);
          const r = target.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          return JSON.stringify(cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight);
        })()
      `),
    );
  }
  check("antes do clique, o card 'destino' está fora da viewport", await destinoInView(), false);

  // Testa o × do conector manual a→"vizinho" ANTES do clique-navega
  // abaixo — este ainda está com "origem"/"vizinho" em tela, no pan/zoom
  // original (o clique-navega em seguida move a viewport pra perto de
  // "destino", o que tiraria "vizinho" de tela e quebraria esta checagem
  // se rodasse depois).
  const delCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const del = document.querySelector('.connector-group--manual .connector-delete');
        if (!del) return JSON.stringify(null);
        const box = del.getBBox();
        const pt = del.ownerSVGElement.createSVGPoint();
        pt.x = box.x + box.width / 2;
        pt.y = box.y + box.height / 2;
        const screenPt = pt.matrixTransform(del.getScreenCTM());
        return JSON.stringify({ x: screenPt.x, y: screenPt.y });
      })()
    `),
  );
  if (!delCoords) throw new Error("connector-group--manual .connector-delete not found");
  await page.click(delCoords.x, delCoords.y);
  await new Promise((r) => setTimeout(r, 400));
  const removed = JSON.parse(await page.evalJs(`JSON.stringify(!document.querySelector('.connector-group--manual'))`));
  check("clicar no × do conector manual ainda deleta normalmente (não quebrou com o novo hit-path por baixo)", removed, true);

  // Clica na FAIXA DE HIT do conector spawned→destino (não no × de
  // deletar) — deve navegar pro card de destino (toCardId), efeito real
  // de verdade. Pega um ponto a 5% do comprimento da curva (perto de
  // "origem", que está em tela) em vez do centro geométrico do bbox: com
  // "destino" longe fora de tela, o meio da curva também cai fora da
  // viewport e o clique não acertaria nada visível.
  const hitCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const hit = document.querySelector('.connector-group--spawned .connector-hit');
        if (!hit) return JSON.stringify(null);
        const len = hit.getTotalLength();
        const pt = hit.getPointAtLength(len * 0.05);
        const screenPt = new DOMPoint(pt.x, pt.y).matrixTransform(hit.getScreenCTM());
        return JSON.stringify({ x: screenPt.x, y: screenPt.y });
      })()
    `),
  );
  if (!hitCoords) throw new Error("connector-hit not found");
  await page.click(hitCoords.x, hitCoords.y);
  await new Promise((r) => setTimeout(r, 500));

  check("clicar na curva do conector navega pro card de destino (jumpToCard)", await destinoInView(), true);

  // O conector continua existindo (clicar na curva não some com ele) e o
  // × de deletar continua funcionando isolado do clique de navegação.
  const stillThere = JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.connector-line--spawned'))`));
  check("o conector não foi removido pelo clique de navegação", stillThere, true);

  const spawnedStillThere = JSON.parse(
    await page.evalJs(`JSON.stringify(!!document.querySelector('.connector-line--spawned'))`),
  );
  check("...e o conector spawned (outro par) não foi afetado", spawnedStillThere, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

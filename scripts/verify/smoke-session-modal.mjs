// DESIGN-BACKLOG.md item 11 — session popover split into a pure switcher
// (Topbar.tsx) + a dedicated create/edit modal (SessionModal.tsx). Also
// covers a real bug caught building this: useBoardStore's old two-call
// rename+changeProject sequence could silently revert whichever field
// changed first in the persisted row (each call read `boards` from its own
// stale render closure) — replaced with one combined `updateBoard`. This
// checks the actual persisted DB row, not just in-memory React state, so a
// regression back to the two-call version would fail here.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9407;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-session-modal", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  // DESIGN-BACKLOG.md item 8 — boots to Home now; Topbar (and its switcher
  // popover, what this script actually tests) only exists once a board is
  // loaded, so get a first session in via Home before touching Topbar.
  await bootIntoFreshSession(page, "Sessão Inicial");

  async function clickByText(selector, text) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}));
          if (!el) return JSON.stringify(null);
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!coords) throw new Error(`element matching ${selector} / "${text}" not found`);
    await page.click(coords.x, coords.y);
  }

  // open the switcher
  const titleCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.topbar-title');
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(titleCoords.x, titleCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  const popoverOpen = await page.evalJs(`JSON.stringify(!!document.querySelector('.board-list'))`);
  check("switcher popover opens", JSON.parse(popoverOpen), true);

  // no inline create form left in the popover — just the list + one CTA
  const noInlineCreate = await page.evalJs(`JSON.stringify(!document.querySelector('.board-list ~ .popover-field'))`);
  check("popover has no inline create form (moved to modal)", JSON.parse(noInlineCreate), true);

  // "+ nova sessão" opens the create modal
  await clickByText(".popover-actions-stretch button", "nova sessão");
  await new Promise((r) => setTimeout(r, 300));
  const createModalOpen = await page.evalJs(`JSON.stringify(!!document.querySelector('.modal-root'))`);
  check("create modal opens", JSON.parse(createModalOpen), true);

  // fill it out, pick the "claude+bash+arquivos" template, submit
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.modal input.resume-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'Sessão de Teste');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await clickByText(".template-option", "Claude + bash + arquivos");
  await new Promise((r) => setTimeout(r, 100));
  const templateSelected = await page.evalJs(`
    JSON.stringify([...document.querySelectorAll('.template-option')].find((b) => b.textContent.includes('Claude'))?.classList.contains('active'))
  `);
  check("template option becomes selected on click", JSON.parse(templateSelected), true);

  await clickByText(".modal-actions button", "Criar");
  await new Promise((r) => setTimeout(r, 800));

  const afterCreate = JSON.parse(
    await page.evalJs(`
      (() => {
        const crumb = document.querySelector('.topbar-title strong');
        const tags = [...document.querySelectorAll('.card-tag')].map((t) => t.textContent.trim());
        return JSON.stringify({
          modalGone: !document.querySelector('.modal-root'),
          activeName: crumb?.textContent,
          cardCount: document.querySelectorAll('.card-frame').length,
          tags,
        });
      })()
    `),
  );
  check("create modal closes after submit", afterCreate.modalGone, true);
  check("new session becomes active (auto-switch)", afterCreate.activeName, "Sessão de Teste");
  check("template seeds 3 cards (claude+bash+arquivos)", afterCreate.cardCount, 3);
  check("seeded terminals use the template's providers", afterCreate.tags.includes("claude") && afterCreate.tags.includes("bash"), true);

  // reopen switcher, edit the new session via its pencil button
  await page.click(titleCoords.x, titleCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  await clickByText(".board-row.active button[title='Editar sessão']", "");
  await new Promise((r) => setTimeout(r, 300));
  const editPrefill = JSON.parse(
    await page.evalJs(`
      (() => {
        const inp = document.querySelector('.modal input.resume-input');
        return JSON.stringify({ open: !!document.querySelector('.modal-root'), value: inp?.value });
      })()
    `),
  );
  check("edit modal opens", editPrefill.open, true);
  check("edit modal pre-fills the current name", editPrefill.value, "Sessão de Teste");

  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.modal input.resume-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'Sessão Renomeada');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await clickByText(".modal-actions button", "Salvar");
  await new Promise((r) => setTimeout(r, 800));

  // Check the PERSISTED row, not just React state — this is what the
  // stale-closure bug above actually corrupted (name reverting once the
  // project write landed with an old name).
  const persisted = JSON.parse(
    await page.evalJs(`
      (async () => {
        const rows = await window.store.boards.list();
        const row = rows.find((r) => r.name === 'Sessão Renomeada' || r.name === 'Sessão de Teste');
        return JSON.stringify(row ? { name: row.name, project: row.project } : null);
      })()
    `),
  );
  check("renamed session's name persisted to the DB row", persisted?.name, "Sessão Renomeada");

  // delete it via the edit modal (>1 session exists, so it's enabled)
  await page.click(titleCoords.x, titleCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  const renamedRowCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const row = [...document.querySelectorAll('.board-row')].find((r) => r.textContent.includes('Sessão Renomeada'));
        const btn = row?.querySelector("button[title='Editar sessão']");
        if (!btn) return JSON.stringify(null);
        const r = btn.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(renamedRowCoords.x, renamedRowCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  await clickByText(".modal-actions button", "Excluir");
  await new Promise((r) => setTimeout(r, 800));
  const afterDelete = await page.evalJs(`
    (async () => {
      const rows = await window.store.boards.list();
      return JSON.stringify(!rows.some((r) => r.name === 'Sessão Renomeada'));
    })()
  `);
  check("deleting from the edit modal removes the session", JSON.parse(afterDelete), true);

  // DESIGN-BACKLOG.md item 21, ponto 4 — deleting the LAST session used to
  // do literally nothing visible: `disabled` on the button blocks
  // `onClick` from ever firing, and the button kept its normal vivid red
  // look (no dimmed/disabled affordance either). Only "Sessão Inicial" is
  // left now — its Excluir must look disabled AND explain why via toast
  // when clicked, without actually deleting it.
  await page.click(titleCoords.x, titleCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  await clickByText(".board-row button[title='Editar sessão']", "");
  await new Promise((r) => setTimeout(r, 300));
  const lastDeleteBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.modal-actions .danger');
        const cs = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ isDisabledClass: b.classList.contains('is-disabled'), ariaDisabled: b.getAttribute('aria-disabled'), opacity: cs.opacity, x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  check("last session's Excluir carries the disabled look (class)", lastDeleteBtn.isDisabledClass, true);
  check("last session's Excluir carries aria-disabled", lastDeleteBtn.ariaDisabled, "true");
  check("last session's Excluir is visibly dimmed (opacity < 1)", Number(lastDeleteBtn.opacity) < 1, true);

  await page.click(lastDeleteBtn.x, lastDeleteBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const guardToastShown = JSON.parse(
    await page.evalJs(
      `JSON.stringify([...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('não é possível excluir')))`,
    ),
  );
  check("clicking the disabled-looking Excluir shows an explanatory toast", guardToastShown, true);

  const stillOneBoard = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b.length === 1))`),
  );
  check("the guarded click did NOT delete the last session", stillOneBoard, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

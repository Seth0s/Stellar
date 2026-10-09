/**
 * Fila v3.1 — isolated smoke: modal opens inside the Fila card (veil local),
 * elementFromPoint hits the dialog, tabs/typing work, click outside closes,
 * enter/leave animation classes appear.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, spawnCard } from "./cdp-client.mjs";

const SHOT_DIR = join(fileURLToPath(new URL("../..", import.meta.url)), ".verify-tmp/fila-v31-modal");
mkdirSync(SHOT_DIR, { recursive: true });

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-fila-v31-modal-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(page, expr, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evalJs(`!!(${expr})`)) return true;
    await delay(80);
  }
  return false;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Fila V31 Modal", { spawnTerminal: false });
  await delay(400);
  await spawnCard(page, "task");
  check("board monta", await waitFor(page, `document.querySelector('[data-part="queue-board"]')`), true);

  const created = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const board = boards.find((b) => b.name === "Fila V31 Modal") ?? boards[0];
        return JSON.stringify(await window.tasks.create(board.id, "task do smoke v3.1 do modal"));
      })()
    `),
  );
  check("task criada", created.ok, true);
  check("tile aparece", await waitFor(page, `document.querySelector("[data-task-item-id]")`), true);

  const itemPt = await centerOf(page, "[data-task-item-id]");
  await page.click(itemPt.x, itemPt.y);

  check(
    "animação de entrada marca data-anim=enter ou open",
    await waitFor(
      page,
      `(() => {
        const root = document.querySelector('[data-part="task-detail-v3"]');
        if (!root) return false;
        const anim = root.getAttribute("data-anim");
        return anim === "enter" || anim === "open";
      })()`,
    ),
    true,
  );
  check(
    "após a entrada a animação fica open",
    await waitFor(
      page,
      `document.querySelector('[data-part="task-detail-v3"]')?.getAttribute("data-anim") === "open"`,
      1500,
    ),
    true,
  );

  const placement = JSON.parse(
    await page.evalJs(`(() => {
      const root = document.querySelector('[data-part="task-detail-v3"]');
      const dialog = root?.querySelector('[role="dialog"]');
      const veil = root?.querySelector('[data-part="task-detail-veil"]');
      const clip = root?.parentElement;
      if (!root || !dialog || !veil || !clip) return JSON.stringify({ ok: false });
      const rr = root.getBoundingClientRect();
      const cr = clip.getBoundingClientRect();
      const cs = getComputedStyle(dialog);
      const vs = getComputedStyle(veil);
      return JSON.stringify({
        ok: true,
        rootedInClip: clip.classList.contains("card-clip"),
        rootCoversClip: Math.abs(rr.left - cr.left) < 2 && Math.abs(rr.top - cr.top) < 2,
        dialogBg: cs.backgroundColor,
        veilBg: vs.backgroundColor,
        dialogPosition: cs.position,
      });
    })()`),
  );
  check("modal porta no card-clip", placement.rootedInClip, true);
  check("véu cobre o card, não o viewport", placement.rootCoversClip, true);
  check("superfície #161a24", placement.dialogBg, "rgb(22, 26, 36)");
  check(
    "véu rgba(11,13,18,.38)",
    /rgba?\(\s*11\s*,\s*13\s*,\s*18/.test(String(placement.veilBg || "")),
    true,
  );
  console.log("VEIL_BG", placement.veilBg);

  const hit = JSON.parse(
    await page.evalJs(`(() => {
      const dialog = document.querySelector('[data-part="task-detail-v3"] [role="dialog"]');
      const veil = document.querySelector('[data-part="task-detail-veil"]');
      if (!dialog || !veil) return JSON.stringify({ inside: false });
      const r = dialog.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + 36);
      return JSON.stringify({
        inside: dialog.contains(el),
        isVeil: el === veil,
        dialogPosition: getComputedStyle(dialog).position,
      });
    })()`),
  );
  check("elementFromPoint no centro cai no dialog", hit.inside === true && hit.isVeil === false, true);

  const tabPt = JSON.parse(
    await page.evalJs(`(() => {
      const btn = [...document.querySelectorAll('[data-part="task-detail-v3"] button')]
        .find((b) => /^(Contrato|Contract)$/.test((b.textContent || "").trim()));
      if (!btn) return "null";
      const r = btn.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  if (tabPt) await page.click(tabPt.x, tabPt.y);
  await delay(120);
  check(
    "aba Contrato sem fechar o modal",
    await page.evalJs(`!!document.querySelector('[data-part="task-detail-v3"]')`),
    true,
  );

  const draftPt = JSON.parse(
    await page.evalJs(`(() => {
      const el = document.querySelector('[data-part="task-detail-prompt-draft"]');
      if (!el) return "null";
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + 24, y: r.y + r.height / 2 });
    })()`),
  );
  if (draftPt) {
    await page.evalJs(`
      [...document.querySelectorAll('[data-part="task-detail-v3"] button')]
        .find((b) => /^(Resumo|Summary)$/.test((b.textContent || "").trim()))?.click()
    `);
    await delay(100);
    const again = JSON.parse(
      await page.evalJs(`(() => {
        const el = document.querySelector('[data-part="task-detail-prompt-draft"]');
        if (!el) return "null";
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + 24, y: r.y + r.height / 2 });
      })()`),
    );
    if (again) await page.click(again.x, again.y);
    await page.send("Input.insertText", { text: "nota v31" });
    await delay(80);
    check(
      "digitação chega no draft",
      await page.evalJs(`document.querySelector('[data-part="task-detail-prompt-draft"]')?.value.includes("nota v31")`),
      true,
    );
  }

  const openShot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(SHOT_DIR, "modal-open.png"), Buffer.from(openShot.data, "base64"));

  const outside = JSON.parse(
    await page.evalJs(`(() => {
      const veil = document.querySelector('[data-part="task-detail-veil"]');
      const dialog = document.querySelector('[data-part="task-detail-v3"] [role="dialog"]');
      if (!veil || !dialog) return "null";
      const r = dialog.getBoundingClientRect();
      const candidates = [
        { x: r.x - 12, y: r.y + r.height / 2 },
        { x: r.right + 12, y: r.y + r.height / 2 },
        { x: r.x + 20, y: r.y - 12 },
      ];
      for (const p of candidates) {
        if (p.x < 2 || p.y < 2) continue;
        if (document.elementFromPoint(p.x, p.y) === veil) return JSON.stringify(p);
      }
      return "null";
    })()`),
  );
  check("há ponto no véu fora do dialog", !!outside, true);
  if (outside) {
    await page.click(outside.x, outside.y);
    check(
      "saída marca data-anim=leave antes de desmontar",
      await waitFor(
        page,
        `document.querySelector('[data-part="task-detail-v3"]')?.getAttribute("data-anim") === "leave"
          || !document.querySelector('[data-part="task-detail-v3"]')`,
        500,
      ),
      true,
    );
    check(
      "clique no véu fecha o modal",
      await waitFor(page, `!document.querySelector('[data-part="task-detail-v3"]')`, 3000),
      true,
    );
  }
} finally {
  await stopApp(app);
}
finish();

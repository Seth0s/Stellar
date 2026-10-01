// TASK b3237a17, item 2 — "qualquer função aplicada ao card PUXA o foco do
// viewport de forma obrigatória".
//
// Causa medida: `addCard` e `createBrowserCard` faziam
// `if (world.zoom !== 1) setZoomAbs(1)` — todo spawn (rail, MCP spawn_card/
// spawn_agent, open_url, duplicate) empurrava o zoom do board para 100%,
// ancorado no centro do viewport, MUDANDO a câmera sem o usuário pedir.
//
// Este smoke: põe o board a 150%, cria um card de TERMINAL e um de NAVEGADOR
// pela UI, e exige que o zoom continue 150% — a câmera não se move sozinha.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-camera-${CDP_PORT}`, import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Camera Teste", { spawnTerminal: false });
  await delay(500);

  const centerOf = (sel) =>
    page.evalJs(`
      (() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()
    `);
  const readout = () => page.evalJs(`document.querySelector(".zoom-readout")?.textContent?.trim() ?? ""`);

  // Sobe o zoom do board para 150% pela entrada direta do zoom-pill.
  const zc = await centerOf(".zoom-readout");
  await page.click(zc.x, zc.y);
  await delay(200);
  const zi = await centerOf(".zoom-input");
  await page.click(zi.x, zi.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector(".zoom-input");
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      s.call(inp, "150");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await delay(400);
  const atStart = await readout();
  check(`board em 150% antes de criar card (lido: "${atStart}")`, atStart, "150%");

  async function spawnViaRail(kind) {
    const add = await centerOf('[data-role="rail-add-card"]');
    await page.click(add.x, add.y);
    await delay(250);
    const opt = await centerOf(`.popover-row[data-kind="${kind}"]`);
    if (!opt) throw new Error(`opcao ${kind} nao encontrada`);
    await page.click(opt.x, opt.y);
    await delay(250);
    if (kind === "terminal") {
      const create = await centerOf(".popover-actions button.primary");
      if (create) {
        await page.click(create.x, create.y);
        await delay(400);
      }
    }
    await delay(500);
  }

  await spawnViaRail("terminal");
  const afterTerminal = await readout();
  check(`criar um TERMINAL não rouba a câmera (zoom continua "${afterTerminal}")`, afterTerminal, "150%");

  await spawnViaRail("browser");
  const afterBrowser = await readout();
  check(`criar um NAVEGADOR não rouba a câmera (zoom continua "${afterBrowser}")`, afterBrowser, "150%");

  page.close();
} finally {
  await stopApp(app);
}
finish();

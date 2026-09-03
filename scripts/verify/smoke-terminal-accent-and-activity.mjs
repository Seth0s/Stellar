// "Terminal, Revisitado" (2026-09-02) — cobre os dois mecanismos genuinamente
// NOVOS da leva de mudanças (o resto — scrollback/ligaduras/cursor tingido —
// é configuração passiva já coberta pelo build+typecheck limpos e pelas
// suítes smoke-terminal-* existentes continuando verdes):
//
// 1. `isActive` (useTerminal.ts) — sinal real por trás da barra de
//    atividade: liga com bytes reais chegando do PTY, desliga sozinho
//    depois de ACTIVITY_IDLE_MS de silêncio. Prova o efeito DOM visível
//    (`.terminal-card-activity.on`), não um accessor interno. Testado
//    ANTES do item 2 abaixo — precisa de um provider com binário real
//    instalado nesta máquina pra emitir `pty:data` de verdade.
// 2. Gap real fechado: `antigravity` era provider de verdade sem entrada em
//    PROVIDER_ACCENT (tokens.css), caindo no cinza do bash sem ninguém ter
//    decidido isso — prova que o card-tag renderizado de um terminal
//    antigravity NÃO usa mais a cor do bash.
import fs from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-accent-activity-${Date.now()}`, import.meta.url).pathname;
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Accent+Activity Teste");
  await delay(600);

  // ---- 1. antigravity accent gap ----
  // Muda o provider do card bash já spawnado pra antigravity direto no
  // store (mesmo padrão de seed direto do smoke-terminal-image-mask-
  // claude.mjs) — mais barato que spawnar um segundo terminal, e o que
  // importa aqui é só o CSS resolvido, não o processo real rodando.
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const cards = await window.store.list(${JSON.stringify(boardId)});
        const term = cards.find((c) => c.kind === 'terminal');
        return JSON.stringify(term.id);
      })()
    `),
  );
  const bashTagColor = await page.evalJs(`
    (() => {
      const tag = document.querySelector('.card-tag');
      return window.getComputedStyle(tag).color;
    })()
  `);

  // ---- 2. isActive real, efeito visível na barra de atividade ----
  // Feito AQUI, antes de trocar o provider pra antigravity abaixo — um
  // provider sem binário real instalado nesta máquina nunca chegaria a
  // emitir nenhum `pty:data`, o que provaria o teste errado (falso
  // negativo), não o mecanismo.
  //
  // Espera extra antes do primeiro check: o boot do bash em si já produz
  // `pty:data` real (prompt inicial) — checar "idle" cedo demais pega essa
  // atividade genuína de spawn ainda dentro do debounce, não um bug.
  await delay(1200);
  const activityOffAtStart = await page.evalJs(`
    (() => document.querySelector('[data-role="terminal-activity"]')?.dataset.active !== "true")()
  `);
  check("barra de atividade começa desligada (idle)", activityOffAtStart, true);

  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify("echo terminal-activity-proof\n")})`);
  await delay(250);
  const activityOnAfterWrite = await page.evalJs(`
    (() => document.querySelector('[data-role="terminal-activity"]')?.dataset.active === "true")()
  `);
  check("barra de atividade liga com bytes reais chegando do PTY (echo real, não simulado)", activityOnAfterWrite, true);

  // ACTIVITY_IDLE_MS = 900 (useTerminal.ts) — espera passar disso sem
  // nenhum byte novo (o echo já terminou de imprimir bem antes).
  await delay(1400);
  const activityOffAfterIdle = await page.evalJs(`
    (() => document.querySelector('[data-role="terminal-activity"]')?.dataset.active !== "true")()
  `);
  check("...e desliga sozinha depois do silêncio (debounce real, não travada em 'on')", activityOffAfterIdle, true);

  // ---- 1. antigravity accent gap ----
  // Muda o provider do card bash já spawnado pra antigravity direto no
  // store (mesmo padrão de seed direto do smoke-terminal-image-mask-
  // claude.mjs) — mais barato que spawnar um segundo terminal, e o que
  // importa aqui é só o CSS resolvido, não o processo real rodando.
  await page.evalJs(`
    (async () => {
      const cards = await window.store.list(${JSON.stringify(boardId)});
      const term = cards.find((c) => c.id === ${JSON.stringify(cardId)});
      await window.store.upsert({ ...term, provider: 'antigravity' });
    })()
  `);
  // `store.upsert()` out-of-band não move o card já renderizado (mesmo
  // achado documentado em smoke-terminal-image-mask-claude.mjs) — precisa
  // do mesmo round-trip Home->voltar que os testes de seed direto usam
  // pra forçar o board a reler o store.
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await delay(500);
  const sessionCard = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('.home-session-card')].find((c) => c.querySelector('.home-session-name')?.textContent === 'Accent+Activity Teste');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!sessionCard) throw new Error("could not find the seeded session back on Home");
  await page.click(sessionCard.x, sessionCard.y);
  await delay(700);
  const antigravityTagColor = await page.evalJs(`
    (() => {
      const tag = document.querySelector('.card-tag');
      return window.getComputedStyle(tag).color;
    })()
  `);
  check(
    `antigravity ganhou cor própria, não caiu mais no cinza do bash (bash=${bashTagColor}, antigravity=${antigravityTagColor})`,
    antigravityTagColor !== bashTagColor,
    true,
  );
  // --accent-antigravity real (tokens.css) é #4f7fc9 = rgb(79, 127, 201).
  check("...e é especificamente o azul pedido (rgb(79, 127, 201))", antigravityTagColor, "rgb(79, 127, 201)");

  page.close();
} finally {
  await stopApp(app);
}
finish();

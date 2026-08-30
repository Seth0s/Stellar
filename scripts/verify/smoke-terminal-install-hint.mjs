// DESIGN-BACKLOG.md item 57 ponto 13 — pedido ao vivo: um observador
// por-provider que sugere o comando de instalação real (não um texto de
// erro morto) quando o binário não é encontrado, num terminal PRÉ-
// PREENCHIDO (nunca executado sozinho — o humano ainda aperta Enter).
// Prova real: "gemini" genuinamente não está instalado NESTA máquina
// (confirmado antes de escrever este teste, mesma situação que
// smoke-provider-gemini.mjs já explora) — sem fake key nem mock nenhum,
// o próprio `which()` real do app falha de verdade. Verifica o botão
// aparece com o comando real, que clicar cria um SEGUNDO terminal (bash,
// mesmo cwd), e que o texto do comando chega no PTY real (via
// `window.pty.onData`, a mesma camada de dados crus que a detecção de URL
// já usa — xterm.js renderiza em canvas/WebGL, sem texto de DOM
// confiável) SEM nenhum `\r` — provando "digitado, não executado".
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9467;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-install-hint", import.meta.url).pathname;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Install Hint Teste");
  await new Promise((r) => setTimeout(r, 800));

  // `bootIntoFreshSession` já semeia um bash terminal padrão — guarda o id
  // dele agora pra distinguir do bash NOVO que o botão de instalação cria
  // mais adiante (os dois teriam `provider === 'bash'`).
  const originalBashId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'bash').id);
      })()
    `),
  );

  // Cria um terminal card com provider "gemini" — mesma abordagem do
  // popover de criação já usada por outros testes (smoke-provider-gemini.mjs).
  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const geminiBtnCoords = await centerOf(page, '.provider-picker-btn[title="gemini"]');
  if (!geminiBtnCoords) throw new Error("botão de provider 'gemini' não encontrado no popover de criação de terminal");
  await page.click(geminiBtnCoords.x, geminiBtnCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarBtn.x, criarBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  check("um terminal card 'gemini' foi criado (+ o bash padrão semeado)", await page.evalJs(`document.querySelectorAll('.terminal-card').length`), 2);

  const errorText = await page.evalJs(`document.querySelector('.terminal-card-exited')?.textContent`);
  check('a mensagem de erro honesta ainda aparece ("gemini" não encontrado)', errorText?.includes("gemini") && errorText?.includes("não encontrado"), true);

  const installBtnTitle = await page.evalJs(`document.querySelector('.terminal-card-install-btn')?.title`);
  check("o botão de instalação existe, com o comando real no tooltip", installBtnTitle?.includes("npm install -g @google/gemini-cli"), true);

  const installBtn = await centerOf(page, ".terminal-card-install-btn");
  // Grava tudo que chega via pty:data ANTES de clicar, pra capturar o
  // texto real escrito no novo terminal assim que ele existir.
  await page.evalJs(`
    (() => {
      window.__ptyChunks = {};
      window.pty.onData((id, data) => {
        window.__ptyChunks[id] = (window.__ptyChunks[id] ?? '') + data;
      });
    })()
  `);
  await page.click(installBtn.x, installBtn.y);
  await new Promise((r) => setTimeout(r, 1000));

  check("um novo terminal (bash) foi criado pelo botão de instalação", await page.evalJs(`document.querySelectorAll('.terminal-card').length`), 3);

  const newCard = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const bashCard = cards.find((c) => c.kind === 'terminal' && c.provider === 'bash' && c.id !== ${JSON.stringify(originalBashId)});
        return JSON.stringify({ id: bashCard?.id ?? null, label: bashCard?.label ?? null, cwd: bashCard?.cwd ?? null, geminiCwd: cards.find((c) => c.provider === 'gemini')?.cwd ?? null });
      })()
    `),
  );
  check("o novo terminal é mesmo bash", newCard.id !== null, true);
  check("...com o mesmo cwd do card gemini original", newCard.cwd, newCard.geminiCwd);
  check("...e o header traz uma legenda identificando o motivo", newCard.label?.includes("gemini") ?? false, true);

  const chunk = await page.evalJs(`window.__ptyChunks[${JSON.stringify(newCard.id)}] ?? ''`);
  check("o comando de instalação real chegou no PTY do novo terminal", chunk.includes("npm install -g @google/gemini-cli"), true);
  check("...SEM nenhum \\r/\\n junto (digitado, não executado sozinho)", /\r|\n/.test(chunk), false);

  page.close();
} finally {
  await stopApp(app);
}
finish();

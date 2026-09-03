// DESIGN-BACKLOG.md item 57 ponto 13 — pedido ao vivo: um observador
// por-provider que sugere o comando de instalação real (não um texto de
// erro morto) quando o binário não é encontrado, num terminal PRÉ-
// PREENCHIDO (nunca executado sozinho — o humano ainda aperta Enter).
// Prova real: sem fake key nem mock nenhum, o próprio `which()` real do
// app falha de verdade pra "antigravity" — não porque o binário nunca
// existe nesta máquina (`agy` está genuinamente instalado aqui, achado ao
// vivo em 2026-08-31 depois do provider ter sido renomeado de "gemini"
// pra "antigravity"), mas porque o diretório real dele é removido do
// `PATH` do processo Electron filho ANTES do launch (ver bloco logo
// abaixo) — o app enxerga o mesmo "não encontrado" que veria numa máquina
// sem o binário, sem tocar em nenhum código de produto. Verifica o botão
// aparece com o comando real, que clicar cria um SEGUNDO terminal (bash,
// mesmo cwd), e que o texto do comando chega no PTY real (via
// `window.pty.onData`, a mesma camada de dados crus que a detecção de URL
// já usa — xterm.js renderiza em canvas/WebGL, sem texto de DOM
// confiável) SEM nenhum `\r` — provando "digitado, não executado".
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9467;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-install-hint", import.meta.url).pathname;

async function centerOf(page, selector) {
  let res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res && selector.includes(".rail-btn[title=")) {
    const titleMatch = selector.match(/title=["']([^"']+)["']/);
    if (titleMatch) {
      const title = titleMatch[1];
      const addBtn = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector('.rail-btn[title="Adicionar card"]');
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (addBtn) {
        await page.click(addBtn.x, addBtn.y);
        await new Promise((r) => setTimeout(r, 250));
        res = JSON.parse(
          await page.evalJs(`
            (() => {
              const el = document.querySelector(\`.popover-row[title="${title}"]\`);
              if (!el) return JSON.stringify(null);
              const r = el.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
      }
    }
  }
  return res;
}

// Achado ao vivo (2026-08-31) — este teste dependia de "antigravity"
// genuinamente não estar instalado nesta máquina; deixou de ser verdade
// assim que `agy` passou a estar instalado aqui (ambiente mudou, não o
// produto). `which()` (providers.ts) resolve pelo `process.env.PATH` real
// do processo main — como `startApp` (cdp-client.mjs) repassa
// `...process.env` pro processo Electron que ele lança, remover o
// diretório real do binário do PATH ANTES de chamar `startApp` faz o app
// filho genuinamente não encontrar "antigravity", sem tocar em nenhum
// código de produto nem inventar um provider fake.
const realAgyDir = (() => {
  try {
    return dirname(execFileSync("which", ["agy"], { encoding: "utf8" }).trim());
  } catch {
    return null; // já não instalado — nada a remover, o teste funciona igual
  }
})();
const originalPath = process.env.PATH;
if (realAgyDir) {
  process.env.PATH = (process.env.PATH ?? "")
    .split(":")
    .filter((p) => p !== realAgyDir)
    .join(":");
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
process.env.PATH = originalPath; // só o processo filho já lançado precisava do PATH raspado
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

  // Cria um terminal card com provider "antigravity" — mesma abordagem do
  // popover de criação já usada por outros testes (smoke-provider-antigravity.mjs).
  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const antigravityBtnCoords = await centerOf(page, '.provider-picker-btn[title="antigravity"]');
  if (!antigravityBtnCoords) throw new Error("botão de provider 'antigravity' não encontrado no popover de criação de terminal");
  await page.click(antigravityBtnCoords.x, antigravityBtnCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarBtn.x, criarBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  check("um terminal card 'antigravity' foi criado (+ o bash padrão semeado)", await page.evalJs(`document.querySelectorAll('.terminal-card').length`), 2);

  const errorText = await page.evalJs(`document.querySelector('.terminal-card-exited')?.textContent`);
  check('a mensagem de erro honesta ainda aparece ("antigravity" não encontrado)', errorText?.includes("antigravity") && errorText?.includes("não encontrado"), true);

  const installBtnTitle = await page.evalJs(`document.querySelector('.terminal-card-install-btn')?.title`);
  check("o botão de instalação existe, com o comando real no tooltip", installBtnTitle?.includes("curl -fsSL https://antigravity.google/cli/install.sh | bash"), true);

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
        return JSON.stringify({ id: bashCard?.id ?? null, label: bashCard?.label ?? null, cwd: bashCard?.cwd ?? null, antigravityCwd: cards.find((c) => c.provider === 'antigravity')?.cwd ?? null });
      })()
    `),
  );
  check("o novo terminal é mesmo bash", newCard.id !== null, true);
  check("...com o mesmo cwd do card antigravity original", newCard.cwd, newCard.antigravityCwd);
  check("...e o header traz uma legenda identificando o motivo", newCard.label?.includes("antigravity") ?? false, true);

  const chunk = await page.evalJs(`window.__ptyChunks[${JSON.stringify(newCard.id)}] ?? ''`);
  check("o comando de instalação real chegou no PTY do novo terminal", chunk.includes("curl -fsSL https://antigravity.google/cli/install.sh | bash"), true);
  // Pre-release audit P1 — achado ao vivo escrevendo esse item: um `\r`
  // no chunk sozinho não prova mais "Enter foi apertado" com segurança —
  // o memo novo em TerminalCard muda LIGEIRAMENTE o timing de quando o
  // container real é medido/redimensionado depois do spawn, e um resize
  // do PTY nesse meio-tempo faz o bash redesenhar a linha atual
  // (prompt+buffer ainda não submetido) com exatamente essa sequência
  // `\r` + apaga-linha + `\r` + reimpressão — confirmado inspecionando o
  // chunk bruto: o MESMO prompt e o MESMO comando reaparecem, sem
  // NENHUMA saída de verdade do npm nem um prompt novo entre as duas
  // ocorrências, o que uma execução real deixaria. Critério mais preciso
  // pro que este teste realmente quer provar ("digitado, não
  // executado"): depois de remover só os códigos ANSI de controle, o
  // texto tem que terminar exatamente no comando digitado — uma
  // execução real deixaria SAÍDA (ou um prompt novo) depois dele, um
  // redraw de resize nunca deixa.
  const ESC = String.fromCharCode(27);
  const CSI_TERMINATOR = String.fromCharCode(7);
  const ANSI = new RegExp(
    "[" + ESC + "][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?" + CSI_TERMINATOR + ")" +
      "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
    "g",
  );
  const cleaned = chunk.replace(ANSI, "").replace(/\r/g, "");
  check(
    "...terminando exatamente no comando digitado (nenhuma saída/prompt novo depois dele — não executado)",
    cleaned.trimEnd().endsWith("curl -fsSL https://antigravity.google/cli/install.sh | bash"),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();

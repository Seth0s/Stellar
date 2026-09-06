// DESIGN-BACKLOG.md item 57 ponto 13, revisitado ao vivo (2026-09-03) — o
// aviso de "CLI de agente não instalada" morava dentro do fluxo de spawn
// de um card (só aparecia DEPOIS de tentar e falhar), quebrando o fluxo do
// usuário. Movido: checagem proativa (useAgentAvailability.ts) exposta
// como um badge no Topbar, visível ANTES de qualquer tentativa de spawn,
// com um popover listando as CLIs faltando e um botão por linha que abre
// um terminal PRÉ-PREENCHIDO com o comando real (nunca executado sozinho
// — o humano ainda aperta Enter).
//
// Prova real, sem fake key nem mock nenhum: mesmo truque do teste antigo
// — `which()` real do app falha de verdade pra "antigravity" porque o
// diretório real do binário é removido do PATH do processo Electron ANTES
// do launch (ver bloco logo abaixo), não porque o binário nunca existe
// nesta máquina.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-agent-availability-hint-${CDP_PORT}`, import.meta.url).pathname;
const SHIM_BIN_DIR = new URL(`../../.verify-tmp/smoke-agent-availability-hint-bin-${CDP_PORT}`, import.meta.url).pathname;

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
  // Rail consolidada (DESIGN-BACKLOG.md §2.2, "Simplificação da Rail") —
  // os botões de criação de card por tipo viraram itens dentro do popover
  // de "Adicionar card", não mais botões diretos na régua.
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

// Achado ao vivo (2026-09-03, escrevendo este teste) — nesta máquina
// `claude`/`codex`/`agent`(cursor)/`agy`(antigravity) são todos shims na
// MESMA pasta (`~/.local/bin`), então o truque antigo (remover só o
// diretório real do PATH) escondia os QUATRO de uma vez, não só
// "antigravity" — o teste antigo nunca notava porque só olhava um card
// isolado, mas o Topbar novo lista TODAS as CLIs faltando, e um popover
// com 4 linhas em vez de 1 quebrava as asserções abaixo (achado ao vivo:
// a checagem batia contra a primeira linha, "Claude", não "Antigravity").
// Fix: um PATH hermético só pra este processo filho — symlinks reais (via
// `which`, sem inventar/mockar nada) pra tudo MENOS antigravity, isolado
// numa pasta própria. `agy` fica de fora de propósito: é o único que este
// teste quer genuinamente "não encontrado".
rmSync(SHIM_BIN_DIR, { recursive: true, force: true });
mkdirSync(SHIM_BIN_DIR, { recursive: true });
for (const name of ["claude", "codex", "agent", "cursor-agent"]) {
  try {
    const real = execFileSync("which", [name], { encoding: "utf8" }).trim();
    symlinkSync(real, join(SHIM_BIN_DIR, name));
  } catch {
    // não instalado nesta máquina — já ficaria de fora do PATH hermético
    // de qualquer forma, nada a fazer.
  }
}

// O wrapper do Electron (`#!/usr/bin/env node`) e o próprio runtime
// precisam de `node`/utilitários de sistema no PATH pra sequer subir —
// `/usr/bin:/bin:/usr/local/bin` entram DEPOIS do diretório hermético
// (nenhuma colisão de nome com os 4 shims acima; confirmado que "agy" não
// existe em nenhum desses três, então continua genuinamente ausente).
const hermeticPath = `${SHIM_BIN_DIR}:/usr/bin:/bin:/usr/local/bin`;
const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, extraEnv: { PATH: hermeticPath } });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Availability Hint Teste");
  await new Promise((r) => setTimeout(r, 800));

  // O aviso é proativo — deve estar visível ANTES de qualquer spawn de
  // agente, só de ter entrado no board.
  check("o badge de CLI ausente aparece no Topbar, sem nenhum spawn ainda", await page.evalJs(`!!document.querySelector('.topbar-agents-warn')`), true);

  const badge = await centerOf(page, ".topbar-agents-warn");
  await page.click(badge.x, badge.y);
  await new Promise((r) => setTimeout(r, 250));

  const rowText = await page.evalJs(`document.querySelector('.agent-availability-row')?.textContent`);
  check('o popover lista "Antigravity" como não encontrada', rowText?.includes("Antigravity"), true);

  const installBtnTitle = await page.evalJs(`document.querySelector('.agent-availability-install-btn')?.title`);
  check("o botão de instalação existe, com o comando real (POSIX) no tooltip", installBtnTitle?.includes("curl -fsSL https://antigravity.google/cli/install.sh | bash"), true);

  const originalBashId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'bash').id);
      })()
    `),
  );

  const installBtn = await centerOf(page, ".agent-availability-install-btn");
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

  check("um novo terminal (bash) foi criado pelo botão de instalação", await page.evalJs(`document.querySelectorAll('[data-kind="terminal"]').length`), 2);
  check("o popover fechou depois do clique", await page.evalJs(`!document.querySelector('.agent-availability-row')`), true);

  const newCard = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const bashCard = cards.find((c) => c.kind === 'terminal' && c.provider === 'bash' && c.id !== ${JSON.stringify(originalBashId)});
        return JSON.stringify({ id: bashCard?.id ?? null, label: bashCard?.label ?? null });
      })()
    `),
  );
  check("o novo terminal é mesmo bash", newCard.id !== null, true);
  check("...e o header traz uma legenda identificando o motivo", newCard.label?.includes("antigravity") ?? false, true);

  const chunk = await page.evalJs(`window.__ptyChunks[${JSON.stringify(newCard.id)}] ?? ''`);
  check("o comando de instalação real chegou no PTY do novo terminal", chunk.includes("curl -fsSL https://antigravity.google/cli/install.sh | bash"), true);
  // Achado ao vivo herdado do teste antigo — um `\r` sozinho no chunk não
  // prova mais "Enter foi apertado" com segurança (um resize do PTY nesse
  // meio-tempo pode redesenhar a linha atual com `\r` + apaga-linha +
  // reimpressão). Critério mais preciso: depois de remover só os códigos
  // ANSI de controle, o texto tem que terminar exatamente no comando
  // digitado — uma execução real deixaria saída (ou um prompt novo) depois
  // dele, um redraw de resize nunca deixa.
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

  // A parte que este teste substitui: um card "antigravity" que falha ao
  // spawnar mostra o erro honesto, mas SEM o botão de instalação embutido
  // (removido — a checagem proativa acima é o único lugar que oferece
  // instalar agora).
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

  const errorText = await page.evalJs(`document.querySelector('[data-role="terminal-exited"]')?.textContent`);
  check('a mensagem de erro honesta ainda aparece ("antigravity" não encontrado)', errorText?.includes("antigravity") && errorText?.includes("não encontrado"), true);
  check("...mas sem o botão de instalação embutido no spawn (removido, item 57 ponto 13)", await page.evalJs(`!!document.querySelector('.terminal-card-install-btn')`), false);

  page.close();
} finally {
  await stopApp(app);
}
finish();

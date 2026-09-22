// PROVA AO VIVO (task 56604aca, fase 1): o card de diffs diz QUEM DECLAROU
// cada arquivo sujo, avisa quando é disputa, declara o limite da fatia e
// oferece os dois caminhos (verificar sob consentimento, ou só orientar).
//
// PERFIL ISOLADO (padrão do harness): o userData do dono não é lido nem escrito.
// O card aponta para o REPOSITÓRIO REAL (é o cwd do board criado pelo harness),
// e por isso ele LÊ estado real: a asserção é sobre o que a tela diz do que
// existe, nunca sobre um fixture inventado.
//
// O QUE ESTE SMOKE **NÃO** FAZ, dito para ninguém supor o contrário: ele NÃO
// dispara a verificação (worktree + tsc/vitest levariam minutos e escreveriam
// em /tmp a cada run da suíte). O caminho de execução está provado por teste
// unitário do plano e do runner, e o fluxo inteiro foi medido à mão no repo do
// dono — worktree + symlink + apply + tsc passando, e o controle negativo com
// consumidor sem produtor dando exit 2.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-changes-attribution-${CDP_PORT}`, import.meta.url).pathname;
/** O REPOSITÓRIO REAL — é ele que dá estado verdadeiro ao card (o cwd do board
 * passa a apontar para cá, ver abaixo). */
const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { check, finish } = makeChecker();

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  await bootIntoFreshSession(page, "Atribuição do diff");
  await delay(600);

  await spawnCard(page, "changes");
  await delay(1000);

  // O ROOT DO CARD é o `cwd` DELE, e o spawn nasce com o cwd DEFAULT do app (a
  // home — que não é repositório, então o card diria "não é um repositório
  // git"). Aponta o card e o board para o REPOSITÓRIO REAL e recarrega.
  //
  // LIMITE DECLARADO deste smoke, para ninguém ler mais do que ele prova: num
  // perfil ISOLADO não existem cards nem tasks ligados a este repo (as tabelas
  // nascem vazias), então os estados vão sair todos "unknown" — e ISSO É a
  // resposta honesta ali. Os degraus DECLARADO/DISPUTADO/JANELA dependem do
  // dado vivo do perfil do dono (medido contra ele: 24 únicos, 17 disputados,
  // 18 sem declarante nos 59 arquivos de um commit real); aqui se prova o que a
  // TELA faz com cada estado, o aviso de granularidade, o consentimento e o
  // modo orientado.
  execFileSync("sqlite3", [
    join(USER_DATA_DIR, "agent-canvas.db"),
    `UPDATE cards SET cwd='${REPO_ROOT}'; UPDATE boards SET cwd='${REPO_ROOT}';`,
  ]);
  await page.send("Page.reload", {});
  await delay(2500);
  // Depois do reload o app cai na Home: entra no board EXISTENTE (o que tem o
  // card). `bootIntoFreshSession` aqui CRIARIA um segundo board — e o card, com
  // ele, sumiria da tela (medido: 0 entradas).
  if (!(await page.evalJs(`!!document.querySelector('.topbar')`))) {
    await page.evalJs(`document.querySelector('.home-session-card')?.click()`);
    await delay(1200);
  }
  await delay(400);

  const ready = async (expr, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await page.evalJs(`!!(${expr})`)) return true;
      await delay(150);
    }
    return false;
  };

  check(
    "o card de diffs montou com a lista de arquivos",
    await ready(`document.querySelector('[data-role="changes-entry"]')`),
    true,
  );

  const board = JSON.parse(
    await page.evalJs(`
      (() => {
        const rows = [...document.querySelectorAll('[data-role="changes-entry"]')].map((r) => ({
          path: r.getAttribute('data-path'),
          state: r.querySelector('[data-role="changes-attribution"]')?.getAttribute('data-state') ?? null,
          text: r.querySelector('[data-role="changes-attribution"]')?.textContent ?? null,
        }));
        return JSON.stringify({
          rows,
          granularity: !!document.querySelector('[data-role="changes-file-granularity"]'),
          coverage: document.querySelector('[data-role="changes-gate-coverage"]')?.textContent ?? null,
        });
      })()
    `),
  );

  check("toda linha tem um ESTADO de atribuição (nunca vazio)", board.rows.every((r) => r.state !== null), true);
  const estados = new Set(board.rows.map((r) => r.state));
  check(
    "os estados vêm do vocabulário fechado (declared/disputed/window/mention/unknown)",
    [...estados].every((s) => ["declared", "disputed", "window", "mention", "unknown"].includes(s)),
    true,
  );
  console.log(
    `[56604aca] ${board.rows.length} arquivos sujos · estados: ${[...estados].join(",")} · disputados: ${board.rows.filter((r) => r.state === "disputed").length}`,
  );
  check("a cobertura dos gates é dita (tsc tipa src/; vitest não tipa)", (board.coverage ?? "").includes("src/"), true);
  // O aviso de limite é da SELEÇÃO: antes de marcar, ele não existe.
  check("o aviso de granularidade só aparece com seleção", board.granularity, false);

  // Seleciona o primeiro arquivo e confere o aviso + os dois caminhos.
  await page.evalJs(`document.querySelector('[data-role="changes-select"]')?.click()`);
  await delay(300);
  check("o aviso 'fatia por ARQUIVO' aparece na seleção", await ready(`document.querySelector('[data-role="changes-file-granularity"]')`), true);

  const warning = await page.evalJs(`document.querySelector('[data-role="changes-file-granularity"]')?.textContent ?? ''`);
  check("e ele diz que arrasta hunk de terceiro", warning.includes("hunk de terceiro"), true);

  // O MODO ORIENTADO: pede o plano (sem executar) e mostra o resultado.
  await page.evalJs(`
    (() => {
      document.querySelector('[data-role="changes-orient"]')?.click();
    })()
  `);
  check("o modo orientado responde (copia ou mostra os comandos)", await ready(`document.querySelector('[data-role="changes-orient-notice"]')`), true);

  // O CONSENTIMENTO: o botão de verificar abre o modal e NADA roda antes.
  await page.evalJs(`document.querySelector('[data-role="changes-verify"]')?.click()`);
  check("a verificação pede consentimento", await ready(`document.querySelector('.modal')`), true);
  const modal = await page.evalJs(`document.querySelector('.modal')?.textContent ?? ''`);
  check("o modal diz que o trabalho é em /tmp", modal.includes("/tmp"), true);
  check("e que a dependência entra por symlink", modal.includes("node_modules"), true);
  await page.evalJs(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Cancelar')?.click()`);
  await delay(300);
  check("cancelar fecha o modal sem rodar nada", await page.evalJs(`!!document.querySelector('.modal')`), false);

  page.close();
} finally {
  await stopApp(app);
}

if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });
finish();

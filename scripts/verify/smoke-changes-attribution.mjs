// PROVA AO VIVO (task 56604aca): o card de diffs diz QUEM DECLAROU cada arquivo
// sujo, avisa quando é disputa, declara o limite da fatia e oferece os dois
// caminhos (verificar sob consentimento, ou só orientar).
//
// PERFIL ISOLADO (padrão do harness): o userData do dono não é lido nem escrito.
//
// 2ª RODADA — O QUE MUDOU, e por quê. A versão anterior apontava o card para o
// REPOSITÓRIO DO DONO. Duas consequências medidas, e o revisor reprovou por
// elas: (a) o smoke passava a DEPENDER de a árvore estar suja — numa árvore
// limpa o board vinha vazio, e `[].every(...)` fazia as asserções de estado
// passarem por VACUIDADE; (b) num perfil isolado não existem cards nem tasks, e
// os degraus DECLARADO e DISPUTADO — o coração da feature — NUNCA eram
// alcançados (tudo saía `unknown`).
//
// Agora o smoke monta um WORKTREE DESCARTÁVEL DA ÁRVORE REAL (`git worktree add`
// em /tmp — nunca dentro do repo), suja LÁ arquivos REAIS do projeto (README.md
// modificado, com hunk; um untracked novo) e INJETA, via sqlite3, a forma que a
// leitura de produção exige: dois cards de terminal no escopo, uma task de cada
// um com `filesChanged` no schema, e os relatórios. Assim `README.md` sai
// DISPUTADO (dois declarantes, listados) e `smoke-untracked.txt` sai DECLARADO
// (um). A árvore do dono NÃO é tocada — nem para ser sujada, nem para ser lida
// como pré-requisito —, e o worktree sai no `finally`.
//
// O QUE ESTE SMOKE **NÃO** FAZ, dito para ninguém supor o contrário: ele NÃO
// dispara a verificação (worktree + tsc/vitest levariam minutos e escreveriam
// em /tmp a cada run da suíte). O caminho de execução está provado por teste
// unitário do plano e do runner — incluindo o vazamento de worktree numa
// limpeza que falha, medido e corrigido na mesma rodada.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-changes-attribution-${CDP_PORT}`, import.meta.url).pathname;
/** A ÁRVORE REAL do projeto — dela sai o worktree descartável, e é isso que faz
 * os arquivos sujos deste smoke serem arquivos REAIS do projeto. */
const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { check, finish } = makeChecker();

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
/** O worktree DESCARTÁVEL, declarado FORA do `try` porque o `finally` precisa
 * dele para limpar. Ele nasce em /tmp: worktree dentro do repo é justamente o
 * que o app recusa, e a árvore compartilhada não pode receber esse diretório. */
const WT = mkdtempSync(join(tmpdir(), "fatia-host-wt-"));
try {
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  await bootIntoFreshSession(page, "Atribuição do diff");
  await delay(600);

  await spawnCard(page, "changes");
  await delay(1000);

  /**
   * O WORKTREE DA ÁRVORE REAL, e por que ele substituiu o repo do dono (e também
   * o fixture da primeira versão deste conserto): os arquivos sujos têm de ser
   * REAIS, e neste repo o único jeito de ter arquivo sujo real, determinístico e
   * sem sujar a árvore compartilhada é o idioma que o próprio projeto usa —
   * `git worktree add` de um caminho DESCARTÁVEL (nunca dentro do repo), mexer
   * LÁ e remover no fim. A árvore do dono não é tocada: nenhum arquivo dela é
   * escrito, e o worktree sai no `finally`.
   *
   * O que isso conserta, medido pelo revisor: apontar o card para o repo do dono
   * fazia o smoke DEPENDER de a árvore estar suja — com a árvore limpa (é o
   * estado de hoje) o board vinha VAZIO, `[].every(...)` passava por VACUIDADE e
   * os degraus DECLARADO/DISPUTADO nunca eram alcançados.
   */
  execFileSync("git", ["-C", REPO_ROOT, "worktree", "add", "--detach", "-q", WT, "HEAD"], {
    stdio: "pipe",
  });
  // Sujeira REAL, em arquivo REAL do projeto: um versionado MODIFICADO (com
  // hunk) e um untracked novo.
  appendFileSync(join(WT, "README.md"), "\n<!-- linha do smoke de atribuicao -->\n");
  writeFileSync(join(WT, "smoke-untracked.txt"), "untracked\n");

  const DB = join(USER_DATA_DIR, "agent-canvas.db");
  const sql = (q) => execFileSync("sqlite3", [DB, q]).toString().trim();
  const boardId = sql("SELECT id FROM boards LIMIT 1;");
  const now = Date.now();

  // O CARD e o BOARD passam a olhar o worktree (o card nasce com o cwd default do
  // app, que é a home — não é repositório git).
  sql(`UPDATE cards SET cwd='${WT}'; UPDATE boards SET cwd='${WT}';`);

  /**
   * A INJEÇÃO — o que faltava para o smoke alcançar os degraus, já que perfil
   * isolado nasce com o banco VAZIO. As linhas são escritas com a FORMA que a
   * leitura de produção exige (conferida em `diffAttributionFor`): dois cards
   * TERMINAL com cwd dentro da raiz do card, uma task de cada um com
   * `report_schema_json` declarando `filesChanged`, e os relatórios. `README.md`
   * é declarado pelos DOIS (→ DISPUTADO, lista os dois);
   * `smoke-untracked.txt` só pelo primeiro (→ DECLARADO).
   */
  sql(
    `
    DELETE FROM reports WHERE card_id IN ('smoke-decl-a','smoke-decl-b');
    DELETE FROM tasks WHERE id='smoke-task-a' OR id='smoke-task-b';
    DELETE FROM cards WHERE id IN ('smoke-decl-a','smoke-decl-b');
    INSERT INTO cards (id,provider,cwd,x,y,w,h,updated_at,kind,board_id,label,created_at)
      VALUES ('smoke-decl-a','bash','${WT}',0,0,320,200,${now},'terminal','${boardId}','Smoke declarante A',${now}),
             ('smoke-decl-b','bash','${WT}',0,0,320,200,${now},'terminal','${boardId}','Smoke declarante B',${now});
    INSERT INTO tasks (id,prompt,provider,status,card_id,created_at,updated_at,board_id,report_schema_json)
      VALUES ('smoke-task-a','fixture','bash','running','smoke-decl-a',${now},${now},'${boardId}','["filesChanged"]'),
             ('smoke-task-b','fixture','bash','running','smoke-decl-b',${now},${now},'${boardId}','["filesChanged"]');
    INSERT INTO reports (card_id,report_json,updated_at)
      VALUES ('smoke-decl-a','{"filesChanged":["README.md","smoke-untracked.txt"]}',${now}),
             ('smoke-decl-b','{"filesChanged":["README.md"]}',${now});
    `,
  );

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

  // ANTI-VACUIDADE — e é a razão de esta rodada existir (objeção do revisor):
  // com o board VAZIO, `[].every(...)` é `true`, então as duas checagens abaixo
  // passavam sem tocar em nada. A contagem vem PRIMEIRO e é o piso.
  check("o worktree expôs os arquivos sujos (o board NUNCA passa vazio)", board.rows.length >= 2, true);
  check("toda linha tem um ESTADO de atribuição (nunca vazio)", board.rows.every((r) => r.state !== null), true);
  const estados = new Set(board.rows.map((r) => r.state));
  check(
    "os estados vêm do vocabulário fechado (declared/disputed/window/mention/unknown)",
    [...estados].every((s) => ["declared", "disputed", "window", "mention", "unknown"].includes(s)),
    true,
  );
  // OS DOIS DEGRAUS QUE A OBJEÇÃO PEDIU — alcançados de verdade, pelo caminho
  // de produção (`diffAttributionFor`): `b.txt` tem UM declarante; `a.txt` tem
  // DOIS, e o segundo não pode ser escolhido nem escondido.
  const declaredRows = board.rows.filter((r) => r.state === "declared");
  const disputedRows = board.rows.filter((r) => r.state === "disputed");
  check(
    "o degrau DECLARADO é alcançado (smoke-untracked.txt: 1 declarante)",
    declaredRows.some((r) => r.path === "smoke-untracked.txt"),
    true,
  );
  check(
    "o degrau DISPUTADO é alcançado (README.md: 2 declarantes)",
    disputedRows.some((r) => r.path === "README.md"),
    true,
  );
  const disputeText = disputedRows.find((r) => r.path === "README.md")?.text ?? "";
  check(
    "e a disputa LISTA os dois declarantes, sem escolher um",
    disputeText.includes("Smoke declarante A") && disputeText.includes("Smoke declarante B"),
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
  // O WORKTREE SAI NO FIM, sempre — e com `prune` atrás, porque `remove` pode
  // falhar e a árvore compartilhada não pode ficar com registro órfão apontando
  // para um diretório que já era.
  try {
    execFileSync("git", ["-C", REPO_ROOT, "worktree", "remove", "--force", WT], { stdio: "pipe" });
  } catch {
    /* o prune abaixo resolve o registro */
  }
  try {
    execFileSync("git", ["-C", REPO_ROOT, "worktree", "prune"], { stdio: "pipe" });
  } catch {
    /* nada mais a fazer: o smoke já terminou */
  }
  rmSync(WT, { recursive: true, force: true });
}

if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });
finish();

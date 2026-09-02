// Bug relatado ao vivo (2026-09-02): um `claude` aberto num card de
// terminal ora reabria dentro de uma sessão alheia, ora só mostrava
// "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".
// Causa raiz: quando o próprio Stellar é lançado a partir de um processo
// que é (ou descende de) uma sessão do Claude Code — dev via `npm run dev`
// num terminal do Claude Code, ou o app empacotado aberto de dentro de um
// card de terminal que já roda `claude` — essas variáveis de identidade de
// sessão ficam no `process.env` do processo main inteiro. `pty-registry.ts`
// espalhava tudo cegamente em todo card spawnado (`env: { ...process.env }`),
// então qualquer card novo (claude, codex, bash) herdava a identidade da
// sessão ALHEIA que por acaso lançou o app, nunca uma sessão nova de
// verdade.
//
// Verificado sem precisar do binário `claude` instalado: um card de bash
// real roda `env` e o stream real do PTY (via `window.pty.onData`) é
// inspecionado por essas chaves — se a fix regredir, elas reaparecem no
// terminal de verdade.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9461;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-pty-strips-claude-session-env", import.meta.url).pathname;

// Valores fabricados de propósito — não dependemos do ambiente de quem
// roda a suíte já ter (ou não) essas variáveis setadas de verdade; o
// próprio harness (`startApp`/`extraEnv`) as injeta no processo main como
// se este Stellar tivesse sido lançado de dentro de uma sessão alheia do
// Claude Code, reproduzindo o cenário relatado de forma determinística.
const FORGED = {
  CLAUDECODE: "1",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_SESSION_ID: "forged-outer-session-id",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/forged-outer.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "forged-outer-token",
  CLAUDE_PID: "999999",
  CLAUDE_EFFORT: "high",
  AI_AGENT: "claude-code_forged-outer",
};

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, extraEnv: FORGED });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "PTY Strips Claude Session Env Teste");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const bashCardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  check("real bash terminal card id resolved", typeof bashCardId === "string" && bashCardId.length > 0, true);

  await page.evalJs(`
    (() => {
      window.__chunks = "";
      window.pty.onData((id, data) => { if (id === ${JSON.stringify(bashCardId)}) window.__chunks += data; });
      return true;
    })()
  `);

  const marker = "ENV-DUMP-DONE-83214";
  await page.evalJs(`
    window.pty.write(${JSON.stringify(bashCardId)}, ${JSON.stringify(`env; echo ${marker}\r`)})
  `);
  await new Promise((r) => setTimeout(r, 2000));

  const chunks = await page.evalJs(`JSON.stringify(window.__chunks)`).then(JSON.parse);
  check("comando 'env' de verdade rodou até o fim no PTY real", chunks.includes(marker), true);

  for (const key of Object.keys(FORGED)) {
    // `KEY=valor` inteiro, não só o valor (valores curtos como "1" ou
    // "high" aparecem à toa em outras variáveis do dump real de `env`).
    check(`${key} NÃO vaza pro card spawnado (não é mais uma sessão alheia herdada)`, chunks.includes(`${key}=${FORGED[key]}`), false);
  }

  // Confirma que a fix é cirúrgica: PATH (que o registry monta de propósito
  // a partir do process.env herdado) continua chegando no card.
  check("PATH real ainda chega no processo spawnado (fix não zera o env inteiro)", chunks.includes("PATH="), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

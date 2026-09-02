// Achado ao vivo (2026-09-02) — usuário relatou "trava ao reabrir sessão
// com histórico grande de agente". Investigação ao vivo (CDP, sessão real
// de 56MB via `claude --resume`) descartou trava de main-thread/render
// (Stellar respondeu round-trips normalmente o tempo todo) — o gap real é
// zero feedback visual entre "PTY spawnado" e "primeiro byte de output",
// que pra uma sessão grande pode levar vários segundos e é indistinguível
// de um card travado de verdade.
//
// `useTerminal.ts`'s `hasReceivedOutput` (true no primeiro `pty:data`) +
// `TerminalCard.tsx`'s `showLoadingHint` (debounced 1200ms, pra não
// piscar num spawn normal) cobrem isso. Forçar deterministicamente um
// provider real que fique >1.2s em silêncio sem depender de uma sessão
// externa grande (frágil/lenta pra CI) não é prático — este teste cobre
// o caso que TEM que ser sólido: um spawn normal (bash) nunca mostra o
// aviso, mesmo puxando 5 amostras ao longo do primeiro segundo real.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9497;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-loading-hint", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "LoadingHint", { spawnTerminal: true });

  // Amostra os primeiros ~1s reais depois do spawn (bash real, prompt
  // chega bem antes dos 1200ms de debounce) — o badge nunca deve aparecer.
  let sawBadge = false;
  for (let i = 0; i < 10; i++) {
    const has = JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.terminal-card-loading'))`));
    if (has) sawBadge = true;
    await new Promise((r) => setTimeout(r, 100));
  }
  check("spawn normal (bash) nunca mostra 'carregando sessão' (prompt chega bem antes do debounce)", sawBadge, false);

  // Ainda depois de esperar passar o próprio delay de debounce (1200ms) —
  // confirma que não é só "ainda não deu tempo de aparecer".
  await new Promise((r) => setTimeout(r, 800));
  const badgeAfterDebounceWindow = JSON.parse(
    await page.evalJs(`JSON.stringify(!!document.querySelector('.terminal-card-loading'))`),
  );
  check("...e continua ausente depois de passar a janela inteira de debounce", badgeAfterDebounceWindow, false);

  page.close();
} finally {
  await stopApp(app);
}
finish();

// Pedido ao vivo (2026-09-06) — "pros providers sem hook oficial, por
// enquanto desativa as notificações, e melhore o sistema atual com lógica:
// no codex sempre acaba um turno quando aparece 'Worked for 1m 06s'".
// Esse marcador virou DECLARAÇÃO (task 0dd5c145): `providers.ts`'s
// `capacity.delivery.turnEnd` do codex carrega este padrão, a projeção do
// canal de disponibilidade o entrega ao renderer e `useTerminal.ts` o aplica —
// mesmo bypass do relógio de 900ms de silêncio que o `claude` já tinha pelo
// hook `Stop`, só que vindo de TEXTO renderizado em vez de um evento (o codex
// não tem hook para "o turno do agente principal acabou" — confirmado
// investigando o binário).
//
// OS DOIS CAMINHOS — e é isto que este smoke cobre agora:
//
//   1. NATIVO (codex): a declaração mora em `providers.ts`;
//   2. DINÂMICO (commandcode): a declaração mora no spec em DISCO
//      (`appProviders`), passa pelo validador, pelo remount do
//      `dynamicProviderDef` e só então vira projeção. É a motivação da task
//      (8 dos terminais do board real são commandcode) e era o único caminho
//      sem prova viva commitada — o round-trip unitário cobre disco→def, não
//      o PTY.
//
// E O TERCEIRO CASO É A INFERÊNCIA: o shim do commandcode imprime
// `Worked for 45 seconds`, a forma com PALAVRA, que o padrão declara por
// INFERÊNCIA do verbo irmão (`Thought for 1 second`) e que NUNCA foi observada
// no verbo `Worked`. Se ela não fechar o turno, este smoke cai — a inferência
// deixa de ser suposição e passa a ter prova viva.
//
// SEM CORRIDA: o shim só revela o marcador quando o TESTE manda (arquivo
// sentinela), e toda mudança de estado é esperada com `waitFor` + prazo. Antes
// disto a asserção tinha 600ms de margem contra um `sleep 2.5` do shim, e
// falhava sob carga.
//
// Can't drive a real `codex`/`commandcode` turn here (costs real API tokens,
// needs auth) — this swaps in tiny fake executables (bash scripts, no real CLI
// involved) ahead of the real ones on PATH, so `providers.ts`'s `which()`
// resolves to OUR scripts.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-turn-end-pattern-${CDP_PORT}`, import.meta.url).pathname;
const FAKE_BIN_DIR = new URL(`../../.verify-tmp/fake-turn-end-bin-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll com PRAZO — o idioma dos outros smokes. Devolve o valor quando a
 * condição fica verdadeira, ou `null` quando o prazo vence (e aí o `check`
 * seguinte acusa). */
async function waitFor(fn, { timeoutMs = 10_000, everyMs = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) return null;
    await delay(everyMs);
  }
}

mkdirSync(FAKE_BIN_DIR, { recursive: true });

/** Um shim que só revela o marcador quando o teste deixa (arquivo sentinela).
 * É o que torna determinística a asserção "o sinal é o MARCADOR, não o relógio
 * de silêncio": enquanto a sentinela não existe, é IMPOSSÍVEL o marcador
 * aparecer. */
function writeShim(binary, { marker, sentinel }) {
  writeFileSync(
    `${FAKE_BIN_DIR}/${binary}`,
    `#!/bin/bash\n` +
      `echo "shim ${binary}: trabalhando..."\n` +
      `for _ in $(seq 1 900); do [ -f "${sentinel}" ] && break; sleep 0.1; done\n` +
      `echo "${marker}"\n` +
      `sleep 60\n`,
  );
  chmodSync(`${FAKE_BIN_DIR}/${binary}`, 0o755);
}

// O nativo, com o marcador do padrão declarado no codex.
const CODEX_SENTINEL = `${FAKE_BIN_DIR}/release-codex`;
writeShim("codex", { marker: "Worked for 1m 06s", sentinel: CODEX_SENTINEL });
// O dinâmico — nome do binário == o que o spec do commandcode declara —, e com
// a forma por PALAVRA: o ramo INFERIDO do padrão (ver o cabeçalho).
const COMMANDCODE_SENTINEL = `${FAKE_BIN_DIR}/release-commandcode`;
writeShim("commandcode", { marker: "Worked for 45 seconds", sentinel: COMMANDCODE_SENTINEL });

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function clickModalButton(page, label) {
  const findCoords = async () =>
    JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
        })()
      `),
    );
  // O modal abre por IPC: espera o BOTÃO existir (com prazo) em vez de
  // adivinhar com um `sleep`.
  const coords = await waitFor(findCoords, { timeoutMs: 8000 });
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}
async function isCardActive(page, cardId) {
  return JSON.parse(
    await page.evalJs(
      `JSON.stringify(document.querySelector('[data-role="terminal-activity"][data-card-id=${JSON.stringify(cardId)}]')?.dataset.active === "true")`,
    ),
  );
}
/** O nome que a NOTIFICAÇÃO carrega (`TerminalCard` monta o título com o
 * `displayName` do card) — é o que permite escopar a asserção ao card sob teste
 * em vez de cobrar o app inteiro. */
async function notificationsFor(page, cardId) {
  const listed = JSON.parse((await callTool("list_cards", {})).content[0].text);
  const name = listed.cards.find((c) => c.id === cardId)?.displayName ?? null;
  // VACUIDADE, e é o defeito que isto fecha: com `name === null` o filtro
  // devolvia `[]` e a asserção de "nenhuma notificação" PASSAVA sem ter
  // olhado nada. Um card sem nome não é evidência de silêncio — é filtro
  // quebrado, e falha ALTO.
  if (name === null) throw new Error(`card ${cardId} has no displayName — the notification filter would pass vacuously`);
  const calls = JSON.parse(await page.evalJs(`JSON.stringify(window.__notificationCalls)`));
  return calls.filter((c) => typeof c.title === "string" && c.title.includes(name));
}
/** Sobe um card e espera ele ficar ATIVO — sem `sleep` adivinhando o boot do
 * PTY. */
async function spawnAndWaitActive(page, provider) {
  const spawnPromise = callTool("spawn_agent", { provider, reason: `smoke turn-end (${provider})` });
  await clickModalButton(page, "Permitir");
  const result = JSON.parse((await spawnPromise).content[0].text);
  if (result.ok !== true) return { cardId: null, active: null };
  const cardId = result.cardId;
  const active = await waitFor(() => isCardActive(page, cardId));
  return { cardId, active };
}

const { check, finish } = makeChecker();

/**
 * O SHIM PRECISA SER O ÚNICO ALCANÇÁVEL, e não basta mexer no PATH:
 * `commandcode` está GENUINAMENTE instalado nesta máquina
 * (`~/.local/bin/commandcode`), e `user-env.ts`'s `composePath` REÚNE
 * `knownBinDirs()` no fim do PATH efetivo — que inclui
 * `join(homedir(), ".local", "bin")`. Tirar o diretório do PATH herdado não
 * resolve: ele volta como rede.
 *
 * `isolatedHome: true` dá um `$HOME` próprio ao Electron filho, e é de
 * `homedir()` que essa rede deriva — então ela desliga inteira. O caso inteiro
 * (e as duas armadilhas desta classe) está documentado no cabeçalho do
 * `cdp-client.mjs`.
 */
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}` },
  isolatedHome: true,
});
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);

  // Mock ANTES do boot — smoke-terminal-focus-notification.mjs's mesma
  // técnica: window.Notification real dispararia um toast de SO de
  // verdade, sem jeito de observar via DOM/CDP.
  await page.evalJs(`
    window.__notificationCalls = [];
    window.Notification = class {
      constructor(title, options) {
        window.__notificationCalls.push({ title, options });
      }
    };
  `);

  await bootIntoFreshSession(page, "Turn End Pattern Smoke");
  await delay(300);

  // A PROJEÇÃO, lida do RENDERER. É o que pina o caminho dinâmico ponta a ponta
  // (spec em disco → validador → remount → def vivo → projeção) sem depender
  // do resto do smoke: se o campo morrer em algum dos quatro sítios, este
  // `check` cai antes de qualquer coisa de PTY.
  const projected = JSON.parse(
    await page.evalJs(
      `window.agents.checkAvailability().then((all) => JSON.stringify(all.find((a) => a.id === "commandcode")?.turnEndSignal ?? null))`,
    ),
  );
  check("a projeção do commandcode chega ao renderer com um padrão de TELA", projected?.mechanism, "screen");
  check(
    "…e a FONTE é a declarada no spec em disco (texto, como o arquivo guarda)",
    projected?.source,
    "Worked for (?:\\d+h\\s*)?(?:\\d+m\\s*)?\\d+(?:s| seconds?)",
  );

  // ---------------------------------------------------------------------
  // 1) O NATIVO (codex): o sinal é o MARCADOR, não o silêncio.
  // ---------------------------------------------------------------------
  const codex = await spawnAndWaitActive(page, "codex");
  check("spawn_agent(codex, shim falso) resolve ok com um cardId real", typeof codex.cardId, "string");
  check("isActive vira true assim que o shim imprime a 1ª linha", codex.active, true);

  // O shim está MUDO (a sentinela não existe): a única coisa que poderia
  // desligar a barra seria o relógio de silêncio — exatamente o comportamento
  // que a feature removeu. Aqui o `delay` É a asserção (não há evento para
  // esperar), e a sentinela é o que impede a corrida.
  await delay(1500);
  check(
    "isActive continua true depois de >900ms de silêncio (o bug do 900ms puro não se repete)",
    await isCardActive(page, codex.cardId),
    true,
  );

  writeFileSync(CODEX_SENTINEL, "");
  check(
    "isActive vira false SÓ depois do marcador 'Worked for …' aparecer de verdade",
    await waitFor(async () => (await isCardActive(page, codex.cardId)) === false),
    true,
  );

  // ---------------------------------------------------------------------
  // 2) O DINÂMICO (commandcode): spec em disco → validador → remount →
  //    def → projeção. E a forma por PALAVRA, que o padrão declara por
  //    inferência.
  // ---------------------------------------------------------------------
  const dyn = await spawnAndWaitActive(page, "commandcode");
  check("spawn_agent(commandcode) resolve ok — o provider vem do catálogo embutido em disco", typeof dyn.cardId, "string");
  check("isActive vira true no card DINÂMICO (a projeção chegou ao renderer)", dyn.active, true);

  writeFileSync(COMMANDCODE_SENTINEL, "");
  const markerLanded = await waitFor(async () => {
    const text = (await callTool("read_card", { target: dyn.cardId, lines: 20 })).content[0].text;
    return text.includes("Worked for 45 seconds");
  });
  check("o shim imprimiu o marcador no PTY do card dinâmico", markerLanded, true);
  check(
    "o marcador INFERIDO ('Worked for 45 seconds') fecha o turno do provider DINÂMICO",
    await waitFor(async () => (await isCardActive(page, dyn.cardId)) === false),
    true,
  );

  // ---------------------------------------------------------------------
  // 3) Notificação de SO — ESCOPADA ao card sob teste.
  // ---------------------------------------------------------------------
  // A versão anterior cobrava "zero notificações no app inteiro": o terminal
  // que a sessão nova semeia sozinha pode notificar (um card de shell notifica
  // pelo relógio de silêncio), e isso derrubava a rodada sem que houvesse nada
  // de errado com os cards daqui. A pergunta certa é sobre ESTES cards: nenhum
  // dos dois sinaliza por `hook`, então nenhum dos dois pode disparar aviso.
  check(
    "nenhuma notificação de SO do card codex (marcador de TELA não basta para aviso)",
    (await notificationsFor(page, codex.cardId)).length,
    0,
  );
  check(
    "nenhuma notificação de SO do card commandcode (idem)",
    (await notificationsFor(page, dyn.cardId)).length,
    0,
  );
} finally {
  finish();
  await stopApp(app);
}

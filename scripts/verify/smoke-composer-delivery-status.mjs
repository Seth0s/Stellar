// SMOKE (isolated instance only): o composer global NÃO mostra "Sem confirmação"
// para uma entrega que chegou, e a linha de controles SEMPRE cabe dentro do
// bloco — mesmo com um status longo na largura mínima (adendo do dono, 2026-10-05).
//
// Por que shims FALSOS e não as CLIs reais: o CI não pode gastar tokens nem
// depender de login (mesma decisão de `smoke-terminal-turn-end-pattern.mjs`).
// Cada shim imprime a SAÍDA REAL medida (`read_card`, 2026-10-05) depois de
// receber um prompt — é essa saída que as declarações `submitStartedPattern`
// casam, então o caminho exercitado (projeção → laço de confirmação → veredito
// → pílula) é o de produção.
//
//   claude:      `✽ Drizzling… (12s · ↓ 1.2k tokens)`
//   commandcode: `○ Crystallizing…  esc to interrupt • 12s • ↓ 1.2k tokens`
//
// E um terceiro shim (opencode, que não declara marcador) ECOA o texto dentro da
// moldura do composer → `unsent` → `failed`: é ele que produz a pílula LONGA e
// PERSISTENTE que o teste de layout estressa.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-composer-delivery-status-${CDP_PORT}`, import.meta.url).pathname;
const FAKE_BIN_DIR = new URL(`../../.verify-tmp/fake-composer-bin-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 12_000, everyMs = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) return null;
    await delay(everyMs);
  }
}

mkdirSync(FAKE_BIN_DIR, { recursive: true });

/** Shim simples: mostra o composer e, a CADA linha submetida, imprime a linha
 * de spinner MEDIDA daquele provider (é ela o sinal que o laço lê). */
function writeSpinnerShim(binary, spinnerLine) {
  writeFileSync(
    `${FAKE_BIN_DIR}/${binary}`,
    `#!/bin/bash\n` +
      `echo "❯ "\n` +
      `while IFS= read -r _line; do echo ${JSON.stringify(spinnerLine)}; done\n`,
  );
  chmodSync(`${FAKE_BIN_DIR}/${binary}`, 0o755);
}

/** Shim que NUNCA submete: ecoa o texto DENTRO da moldura do composer (duas
 * réguas + 2 linhas de rodapé) — `deriveComposerZone` reconhece a zona e a
 * agulha fica lá → `unsent` → `failed` (pílula longa e persistente). */
function writeStuckShim(binary) {
  writeFileSync(
    `${FAKE_BIN_DIR}/${binary}`,
    `#!/bin/bash\n` +
      `rule="────────────────────────────────"\n` +
      `first=""\n` +
      `echo "❯ "\n` +
      `while IFS= read -r line; do\n` +
      `  [ -n "$line" ] && first="$line"\n` +
      `  echo "$rule"\n` +
      `  echo "❯ $first"\n` +
      `  echo "$rule"\n` +
      `  echo "  rodapé do composer"\n` +
      `  echo "  dica do composer"\n` +
      `done\n`,
  );
  chmodSync(`${FAKE_BIN_DIR}/${binary}`, 0o755);
}

writeSpinnerShim("claude", "✽ Drizzling… (12s · ↓ 1.2k tokens)");
writeSpinnerShim("commandcode", "○ Crystallizing…  esc to interrupt • 12s • ↓ 1.2k tokens");
writeStuckShim("opencode");

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
  const coords = await waitFor(findCoords, { timeoutMs: 8000 });
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}` },
  isolatedHome: true,
});
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Composer Delivery Status");
  await delay(300);

  const boardId = await page.evalJs(
    `(async () => { const b = await window.store.boards.list(); const x = b.find((x) => x.name === "Composer Delivery Status") ?? b[0]; return x.id; })()`,
  );

  // Captura o TEXTO do chip por observação de DOM (o objeto `window.bus` é
  // exposto por `contextBridge` e é somente-leitura — não dá para embrulhar o
  // `send`; o veredito é lido por `list_deliveries` do lado do MCP).
  await page.evalJs(`
    window.__pillTexts = [];
    const mo = new MutationObserver(() => {
      const el = document.querySelector('[data-role="composer-status"]');
      if (el) window.__pillTexts.push(el.textContent || "");
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  `);

  /** O veredito da entrega MAIS RECENTE para um card, via MCP. */
  async function latestDelivery(cardId) {
    const res = JSON.parse((await callTool("list_deliveries", { target: cardId })).content[0].text);
    const settled = (res.deliveries ?? []).filter((d) => d.delivery && d.delivery !== "queued");
    return settled.length > 0 ? settled[settled.length - 1] : null;
  }

  async function spawnAgent(provider, label) {
    const spawn = callTool("spawn_agent", { provider, reason: `smoke composer (${provider})`, label });
    await delay(400);
    await clickModalButton(page, "Permitir");
    const res = JSON.parse((await spawn).content[0].text);
    if (res.ok !== true) return null;
    // O composer relê a lista de cards a cada 3s — espera ele listar o card.
    const listed = await waitFor(async () => {
      const ids = JSON.parse(
        await page.evalJs(`(async () => JSON.stringify((await window.store.list(${JSON.stringify(boardId)})).map((c) => c.id)))()`),
      );
      return ids.includes(res.cardId);
    }, { timeoutMs: 8000 });
    return listed ? res.cardId : null;
  }

  /** Clique REAL (CDP) no centro do elemento — eventos de portal do React não
   * são disparados de forma confiável por `element.click()`. */
  async function clickSelector(selector) {
    const box = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return "null";
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    if (!box) throw new Error(`selector not found: ${selector}`);
    await page.click(box.x, box.y);
  }

  async function sendViaComposer(cardId, text) {
    // 1) O TEXTO primeiro: preencher a caixa é o que REVELA a barra (ela fica
    //    ancorada fora da viewport até ter foco/texto). Sem isto, os cliques
    //    cairiam numa barra invisível abaixo da borda.
    await page.evalJs(`
      (() => {
        const ta = document.querySelector('[data-role="composer-input"]');
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await delay(400); // deixa a animação de revelação assentar
    // 2) Destino: abre o popover e escolhe a linha do card. O seletor é ESCOPADO
    //    ao popover do composer — `[data-card-id]` também existe nas barras de
    //    atividade dos cards do board e casaria o elemento errado.
    const rowSel = `.popover--composer [data-card-id=${JSON.stringify(cardId)}]`;
    await clickSelector('[data-role="composer-target"]');
    const rowReady = await waitFor(async () => page.evalJs(`!!document.querySelector(${JSON.stringify(rowSel)})`));
    if (!rowReady) throw new Error(`composer did not list card ${cardId}`);
    await clickSelector(rowSel);
    await delay(200);
    await clickSelector('[data-role="composer-send"]');
    await delay(300);
  }

  // ---------------------------------------------------------------------------
  // 1) ENTREGA: claude e commandcode — chip NÃO diz "Sem confirmação".
  // ---------------------------------------------------------------------------
  for (const provider of ["claude", "commandcode"]) {
    const cardId = await spawnAgent(provider, `smoke-${provider}`);
    check(`spawn_agent(${provider}) resolveu com um cardId real`, typeof cardId, "string");
    await sendViaComposer(cardId, `probe-${provider}-marker-abcdefghij`);

    const settled = await waitFor(async () => latestDelivery(cardId), { timeoutMs: 8000 });
    check(`${provider}: veredito é delivered (não unconfirmed)`, settled?.delivery, "delivered");

    await delay(300);
    const pills = JSON.parse(await page.evalJs(`JSON.stringify(window.__pillTexts)`));
    check(
      `${provider}: nenhuma pílula disse "Sem confirmação"`,
      pills.some((x) => x.includes("Sem confirmação")),
      false,
    );
    await page.evalJs(`window.__pillTexts = []`);
  }

  // ---------------------------------------------------------------------------
  // 2) LAYOUT: status longo tem de caber no bloco (mic/enviar nunca saem).
  // ---------------------------------------------------------------------------
  const stuckCard = await spawnAgent("opencode", "smoke-stuck-" + "x".repeat(40));
  check("spawn_agent(opencode) resolveu (card da pílula longa)", typeof stuckCard, "string");
  await sendViaComposer(stuckCard, "estoque o texto no composer para forcar unsent");
  const failed = await waitFor(async () => {
    const d = await latestDelivery(stuckCard);
    return d && d.delivery === "failed" ? d : null;
  }, { timeoutMs: 12_000 });
  check("o card que trava fecha em failed (pílula persistente)", failed?.delivery, "failed");

  // Janela na largura mínima da barra e status artificialmente LONGO no chip.
  await page.send("Emulation.setDeviceMetricsOverride", { width: 520, height: 820, deviceScaleFactor: 1, mobile: false });
  await delay(200);
  const geom = JSON.parse(
    await page.evalJs(`
      (() => {
        const bar = document.querySelector('[data-role="global-composer"]');
        const toolbar = document.querySelector('[data-role="composer-toolbar"]');
        const pill = document.querySelector('[data-role="composer-status"]');
        if (pill) {
          const label = pill.querySelector('[class*="statusLabel"]');
          if (label) label.textContent = 'Sem confirmação do card Master com um motivo bem comprido para estourar a barra — tentar de novo';
        }
        const r = (el) => (el ? el.getBoundingClientRect() : null);
        const barR = r(bar), toolR = r(toolbar), sendR = r(document.querySelector('[data-role="composer-send"]'));
        const voiceR = r(document.querySelector('[data-role="composer-voice"]'));
        const targetR = r(document.querySelector('[data-role="composer-target"]'));
        return JSON.stringify({
          hasPill: !!pill,
          barLeft: barR.left, barRight: barR.right,
          targetLeft: targetR.left, sendRight: sendR.right, voiceLeft: voiceR.left,
          toolOverflow: toolbar.scrollWidth - toolbar.clientWidth,
          pillRight: r(pill) ? r(pill).right : null,
        });
      })()
    `),
  );
  check("a pílula longa existe para o teste de layout", geom.hasPill, true);
  check("a toolbar NÃO transborda (scrollWidth <= clientWidth)", geom.toolOverflow <= 1, true);
  check("destino não passa da borda esquerda do bloco", geom.targetLeft >= geom.barLeft - 1, true);
  check("enviar não passa da borda direita do bloco", geom.sendRight <= geom.barRight + 1, true);
  check("microfone continua dentro do bloco", geom.voiceLeft >= geom.barLeft - 1, true);
  check("a pílula longa fica dentro do bloco", geom.pillRight === null || geom.pillRight <= geom.barRight + 1, true);

  page.close();
} finally {
  finish();
  await stopApp(app);
}

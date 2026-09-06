// DESIGN-BACKLOG.md item 59 — opt-in autonomous mode. The human-in-the-
// loop path (every spawn_agent shows AgentAskModal) stays the default
// everywhere; this is the second, explicit, per-board opt-in path that
// coexists with it. Every consent-architecture claim here is checked
// against the real DOM (.modal presence/absence), not just the MCP
// response — a wrong auto-approve that skips the modal only shows up if
// you actually look for the modal.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-autonomous-mode-${CDP_PORT}`, import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  // DESIGN-BACKLOG.md item 60, peça 1 — a call that waits in the spawn
  // queue can hold the HTTP request open long enough for the SSE
  // transport to interleave a ": keepalive" comment line before the real
  // "data:" frame (achado ao vivo: `JSON.parse` crashava nesse caso).
  // Always search for the data line by content, never gate on the FIRST
  // line's prefix.
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}
async function hasModal(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.modal'))`));
}
async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}
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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Board 1 Autônomo Teste");
  await new Promise((r) => setTimeout(r, 500));

  const board1Cards = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const board1BashId = board1Cards.cards.find((c) => c.kind === "terminal").id;

  const modeBefore = await toolJson("board_mode", { target: board1BashId });
  check(
    "board novo nasce com autonomous:false, nunca herdado, cap efetivo é o default (3), fila vazia",
    JSON.stringify(modeBefore),
    JSON.stringify({ ok: true, autonomous: false, concurrencyCap: 3, queueLength: 0 }),
  );

  // Baseline: com o modo desligado (padrão), spawn_agent ainda mostra o
  // modal — sem regressão no fluxo human-in-the-loop.
  const baselinePromise = callTool("spawn_agent", { provider: "bash", callerCardId: board1BashId, reason: "baseline" });
  await new Promise((r) => setTimeout(r, 500));
  check("com o modo desligado, spawn_agent ainda mostra o AgentAskModal", await hasModal(page), true);
  await clickModalButton(page, "Negar");
  await baselinePromise;
  await new Promise((r) => setTimeout(r, 300));

  // Liga o modo autônomo via UI REAL — clique no título do topbar, lápis
  // de editar, checkbox, fechar. Nenhuma tool MCP faz isso.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[title="Editar sessão"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));
  const cancelBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === 'Cancelar');
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(cancelBtn.x, cancelBtn.y);
  await new Promise((r) => setTimeout(r, 300));

  const modeAfter = await toolJson("board_mode", { target: board1BashId });
  check("depois do clique real na UI, board_mode reflete autonomous:true", modeAfter.autonomous, true);
  check(
    "o indicador visual real aparece no Topbar",
    await page.evalJs(`document.querySelector('.topbar-autonomous-badge')?.textContent`),
    "autônomo",
  );

  // Em modo autônomo, spawn_agent do MESMO board resolve na hora, SEM
  // modal — até bater o teto de concorrência (default 3, só agentes
  // não-bash contam).
  const autoSpawnedIds = [];
  for (let i = 0; i < 3; i++) {
    const result = await toolJson("spawn_agent", { provider: "claude", callerCardId: board1BashId, reason: `autônomo #${i + 1}` });
    check(`spawn autônomo #${i + 1} resolve ok:true sem modal`, result.ok && typeof result.cardId === "string", true);
    check(`...e nenhum modal apareceu depois dele`, await hasModal(page), false);
    autoSpawnedIds.push(result.cardId);
    // Dá tempo real do processo (registry.spawn, main process) registrar
    // antes do próximo spawn checar o teto de concorrência — sem isso o
    // teto contaria menos processos vivos do que realmente existem.
    await new Promise((r) => setTimeout(r, 700));
  }

  // Teto batido — DESIGN-BACKLOG.md item 60, peça 1 reverteu a recusa
  // estrutural antiga: agora entra numa fila real em vez de ser recusado.
  // Disparado SEM await (a chamada MCP fica pendurada até um slot liberar
  // — testado a fundo em smoke-mcp-spawn-queue.mjs; aqui só confirma que
  // o fluxo autônomo completo integra com a fila, sem regressão pro
  // comportamento antigo).
  const overCapPromise = callTool("spawn_agent", { provider: "claude", callerCardId: board1BashId, reason: "excede o teto, deveria entrar na fila" });
  await new Promise((r) => setTimeout(r, 800));
  check("ao bater o teto em modo autônomo, o 4º spawn ENTRA NA FILA (não é mais recusado)", (await toolJson("board_mode", { target: board1BashId })).queueLength, 1);
  check("...sem mostrar modal", await hasModal(page), false);
  // Libera um slot matando um dos 3 rodando — o da fila deve disparar sozinho.
  await page.evalJs(`window.pty.kill(${JSON.stringify(autoSpawnedIds[0])})`);
  await new Promise((r) => setTimeout(r, 1500));
  const overCap = JSON.parse((await overCapPromise).content[0].text);
  check("...e resolve ok:true sozinho assim que um slot libera", overCap.ok && typeof overCap.cardId === "string", true);
  check("a fila volta a ficar vazia depois do despacho", (await toolJson("board_mode", { target: board1BashId })).queueLength, 0);
  // Precisa entrar na exclusão do board2BashId lá embaixo — é mais um
  // card real do board1, senão o `find` que procura "o card do board2"
  // acha este por engano (mesmo card, board errado).
  if (overCap.ok) autoSpawnedIds.push(overCap.cardId);

  // MAX_SPAWN_DEPTH continua valendo, mesmo em modo autônomo. Pre-release
  // audit S4 fechou a confiança cega em `depth` client-declarado — um
  // `depth: 3` autodeclarado por um card cuja profundidade real (rastreada
  // no servidor) é 0 não é mais levado a sério, então a única forma real
  // de bater o teto agora é uma cadeia de verdade: `provider: "bash"` pra
  // não competir com o teto de concorrência (só agentes não-bash contam),
  // auto-aprovado por já estar em board autônomo (sem modal).
  // Libera o teto de concorrência antes da cadeia de profundidade abaixo —
  // achado ao vivo: o gate de `autonomousSpawn` compara `running` (agentes
  // não-bash vivos) contra o teto pra QUALQUER novo spawn, mesmo um de
  // provider bash — bash só fica de fora da CONTAGEM, não do próprio gate.
  // Sem isso, os spawns bash abaixo entrariam na fila atrás dos 3 agentes
  // claude ainda vivos da rodada de teto acima, e só resolveriam quando o
  // timeout da fila (10 minutos) vencesse.
  for (const id of autoSpawnedIds) {
    await page.evalJs(`window.pty.kill(${JSON.stringify(id)}).catch(() => {})`);
  }
  await new Promise((r) => setTimeout(r, 1000));
  check("teto de concorrência livre antes da cadeia de profundidade", (await toolJson("board_mode", { target: board1BashId })).queueLength, 0);

  const fakeDepthGuard = await toolJson("spawn_agent", { provider: "bash", callerCardId: board1BashId, depth: 3, reason: "declara depth 3, real é 0" });
  check("um depth:3 autodeclarado por um card de profundidade real 0 NÃO é confiado — resolve ok normalmente", fakeDepthGuard.ok, true);
  // Precisa entrar na exclusão do board2BashId lá embaixo, mesmo motivo do
  // `autoSpawnedIds.push` acima — são mais cards reais do board1.
  if (fakeDepthGuard.ok) autoSpawnedIds.push(fakeDepthGuard.cardId);

  let chainCardId = board1BashId;
  for (let i = 1; i <= 3; i++) {
    const hop = await toolJson("spawn_agent", { provider: "bash", callerCardId: chainCardId, reason: `cadeia real de profundidade ${i}` });
    check(`cadeia real de profundidade ${i} resolve ok`, hop.ok && typeof hop.cardId === "string", true);
    chainCardId = hop.cardId;
    autoSpawnedIds.push(hop.cardId);
  }
  const depthGuard = await toolJson("spawn_agent", { provider: "bash", callerCardId: chainCardId, reason: "profundidade 4, deveria recusar" });
  check("MAX_SPAWN_DEPTH ainda recusa em modo autônomo (razão distinta do teto de concorrência)", depthGuard.error?.includes("depth"), true);

  // DESIGN-BACKLOG.md item 60, peça 5 — modo autônomo completo: reverte o
  // limite antigo do item 59 (auto-approve só pra spawn_agent).
  // open_url/spawn_card agora TAMBÉM resolvem na hora, sem modal.
  const openResult = await toolJson("open_url", { url: "https://example.com", callerCardId: board1BashId, reason: "smoke item 60 peça 5" });
  check("open_url resolve ok:true SEM modal em modo autônomo (peça 5)", openResult.ok, true);
  check("...de fato sem nenhum modal no DOM", await hasModal(page), false);

  const spawnCardResult = await toolJson("spawn_card", { kind: "sticky", callerCardId: board1BashId });
  check("spawn_card resolve ok:true SEM modal em modo autônomo (peça 5)", spawnCardResult.ok && typeof spawnCardResult.cardId === "string", true);
  check("...de fato sem nenhum modal no DOM", await hasModal(page), false);

  // Nenhuma tool MCP liga/desliga o modo — só board_mode existe, e é
  // read-only (confirmado pela ausência de qualquer outra tool com
  // "board"/"autonomous" no nome).
  const toolsList = await mcpCall("tools/list", {});
  const relevantTools = (toolsList.result?.tools ?? []).map((t) => t.name).filter((n) => /board|autonomous/i.test(n));
  check("a única tool relacionada a board/autonomous é board_mode (read-only)", JSON.stringify(relevantTools), JSON.stringify(["board_mode"]));

  // Isolamento entre boards — um board novo nasce false mesmo com outro
  // board autônomo, e um card daquele board novo ainda pede consentimento.
  const newSessionBtn = await centerOf(page, ".topbar-title");
  await page.click(newSessionBtn.x, newSessionBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const plusBtn = await centerOf(page, ".board-create button.primary");
  await page.click(plusBtn.x, plusBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.modal input.resume-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'Board 2 Teste');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const createBtn = await centerOf(page, ".modal-actions button.primary");
  await page.click(createBtn.x, createBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  // "Vazio" (o template default) nasce genuinamente com zero cards, de
  // propósito (achado real ao vivo, ver git blame de seedCards) — precisa
  // criar um terminal explicitamente, mesmo passo que
  // cdp-client.mjs's bootIntoFreshSession já faz pro board inicial.
  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const criarTerminalBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarTerminalBtn.x, criarTerminalBtn.y);

  const deadline = Date.now() + 8000;
  let board2BashId = null;
  while (Date.now() < deadline && !board2BashId) {
    await new Promise((r) => setTimeout(r, 300));
    const board2Cards = await toolJson("list_cards", {});
    // `kind === "terminal"` explícito (2026-09-01): `list_cards` passou a
    // devolver TODOS os cards vivos, não só terminais. Sem o filtro, este
    // "primeiro card que não é o do board 1" cai no card de navegador (ou
    // no sticky) que os testes de open_url/spawn_card acima criaram NO
    // BOARD 1 — e aí as duas checagens seguintes mediam o board errado.
    board2BashId =
      board2Cards.cards.find((c) => c.kind === "terminal" && c.id !== board1BashId && !autoSpawnedIds.includes(c.id))?.id ?? null;
  }
  check("um segundo board real foi criado, com um novo card seedado", board2BashId !== null, true);
  if (board2BashId !== null) {
    const board2Mode = await toolJson("board_mode", { target: board2BashId });
    check("um board novo nasce autonomous:false mesmo com outro board já autônomo", board2Mode.autonomous, false);

    const board2SpawnPromise = callTool("spawn_agent", { provider: "bash", callerCardId: board2BashId, reason: "board isolado" });
    await new Promise((r) => setTimeout(r, 500));
    check("um card de OUTRO board (não-autônomo) ainda pede consentimento — o modo não vaza entre boards", await hasModal(page), true);
    await clickModalButton(page, "Negar");
    await board2SpawnPromise;
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();

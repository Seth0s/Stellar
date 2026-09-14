// Live proof: Fila flips pending→running on PTY birth and back on death
// WITHOUT a task-row write in between. Isolates the onLivenessChanged
// invalidation (CAMADA 3) — not the linkImplementerToTask push.
import { setTimeout as delay } from "node:timers/promises";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
  spawnCard,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-fila-liveness-${CDP_PORT}`, import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  // Spawn can hold the HTTP long enough for an SSE ": keepalive" before
  // the real data frame — always find `data:`, never assume first line.
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function toolJson(url, name, args) {
  const rpc = await mcpCall(url, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Fila Liveness", { spawnTerminal: true });
  await delay(400);

  // Arm push recorder BEFORE any task work — captures every task:changed.
  await page.evalJs(`
    (() => {
      window.__filaPushLog = [];
      if (window.__filaPushOff) window.__filaPushOff();
      window.__filaPushOff = window.tasks.onChanged((boardId, tasks) => {
        window.__filaPushLog.push({
          at: Date.now(),
          boardId,
          tasks: tasks.map((t) => ({
            id: t.id,
            status: t.status,
            cardAlive: t.cardAlive,
            cardId: t.cardId,
            updatedAt: t.updatedAt,
          })),
        });
      });
      return true;
    })()
  `);

  await spawnCard(page, "task");
  check("Fila monta", await page.evalJs(`!!document.querySelector('[data-part="create-task-input"]')`), true);

  const boardId = await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "Fila Liveness") ?? boards[0];
      await window.store.boards.setAutonomous(board.id, true);
      return board.id;
    })()
  `);

  const created = await toolJson(MCP_URL, "create_task", {
    prompt: "prova liveness — sem gravação no meio",
    provider: "bash",
    boardId,
  });
  check("create_task ok", created.ok, true);
  const taskId = created.taskId;

  await delay(300);
  // Capture updatedAt from the last push BEFORE spawn — create only.
  const beforeSpawn = JSON.parse(
    await page.evalJs(`
      (() => {
        const log = window.__filaPushLog ?? [];
        const last = log[log.length - 1];
        const t = last?.tasks?.find((x) => x.id === ${JSON.stringify(taskId)});
        return JSON.stringify({
          pushes: log.length,
          status: t?.status ?? null,
          cardAlive: t?.cardAlive ?? null,
          updatedAt: t?.updatedAt ?? null,
        });
      })()
    `),
  );
  check("antes do spawn a Fila vê pending", beforeSpawn.status, "pending");
  check("antes do spawn cardAlive=false", beforeSpawn.cardAlive, false);

  const cards = await toolJson(MCP_URL, "list_cards", {});
  const requesterId = cards.cards.find((c) => c.kind === "terminal")?.id;
  check("tem requester terminal", typeof requesterId, "string");

  const pushCountBeforeSpawn = JSON.parse(await page.evalJs(`window.__filaPushLog.length`));

  async function clickModalButton(label) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const coords = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (coords) {
        await page.click(coords.x, coords.y);
        return true;
      }
      await delay(80);
    }
    return false;
  }

  // Human-in-the-loop path on purpose: spawn parks on AgentAskModal.
  // Approving via CDP is the real consent gesture — we do NOT depend on
  // autonomous mode for this proof (that would hide a modal regression).
  const spawnPromise = toolJson(MCP_URL, "spawn_agent", {
    provider: "bash",
    callerCardId: requesterId,
    taskId,
    reason: "prova ao vivo: Fila em andamento via liveness, não via gravação",
    label: "liveness-proof",
  });
  check("modal de spawn apareceu / Allow clicado", await clickModalButton("Permitir"), true);
  const spawned = await spawnPromise;
  check("spawn_agent ok", spawned.ok, true);
  const childId = spawned.cardId;

  // Wait for a push where THIS task is running + cardAlive — the liveness edge.
  let runningPush = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const snap = JSON.parse(
      await page.evalJs(`
        (() => {
          const log = window.__filaPushLog ?? [];
          const hits = [];
          for (const p of log) {
            const t = p.tasks.find((x) => x.id === ${JSON.stringify(taskId)});
            if (t) hits.push({ at: p.at, status: t.status, cardAlive: t.cardAlive, updatedAt: t.updatedAt, cardId: t.cardId });
          }
          return JSON.stringify({ hits, pushes: log.length });
        })()
      `),
    );
    runningPush = snap.hits.find((h) => h.status === "running" && h.cardAlive === true);
    if (runningPush) break;
    await delay(80);
  }

  check("Fila chegou em running+cardAlive via push", !!runningPush, true);

  // The LINK write bumps updatedAt and pushes pending+cardAlive=false.
  // The liveness edge must re-push running+true with that SAME updatedAt
  // — no second task-row write between link and "em andamento".
  const linkPush = JSON.parse(
    await page.evalJs(`
      (() => {
        const log = window.__filaPushLog ?? [];
        let link = null;
        for (const p of log) {
          const t = p.tasks.find((x) => x.id === ${JSON.stringify(taskId)});
          if (t?.cardId && t.status === "pending" && t.cardAlive === false) link = t;
        }
        return JSON.stringify(link);
      })()
    `),
  );
  check("houve o push precoce do link (pending+cardAlive=false+cardId)", !!linkPush, true);
  check(
    "flip running NÃO gravou task de novo (updatedAt = do link)",
    runningPush?.updatedAt,
    linkPush?.updatedAt,
  );

  // DOM: item's column header must read "em andamento" (COLUMN_HEADER_KEY.doing).
  const domCol = JSON.parse(
    await page.evalJs(`
      (() => {
        const item = document.querySelector('[data-task-item-id="${taskId}"]');
        if (!item) return JSON.stringify({ ok: false, error: "item missing" });
        const header = item.closest('[class]')?.parentElement?.previousElementSibling
          ?? item.parentElement?.previousElementSibling;
        // columnBody's previous sibling is columnHeader
        const colRoot = item.parentElement?.parentElement;
        const text = colRoot?.querySelector('[data-part="column-header"]')?.textContent?.trim() ?? "";
        const hasWip = !!colRoot?.querySelector('[data-part="wip-badge"]');
        return JSON.stringify({ ok: true, header: text, hasWip, voidHeader: !!header });
      })()
    `),
  );
  check("DOM: coluna tem wip-badge (em andamento)", domCol.hasWip, true);
  check("DOM: header contém em andamento", (domCol.header || "").toLowerCase().includes("andamento"), true);

  const pushCountAtRunning = JSON.parse(await page.evalJs(`window.__filaPushLog.length`));
  check("houve push depois do spawn", pushCountAtRunning > pushCountBeforeSpawn, true);

  // Kill the PTY for real — store.delete alone removes the row but leaves
  // the process alive (kill is on TerminalCard unmount / pty:kill).
  const updatedAtAtRunning = runningPush.updatedAt;
  await page.evalJs(`window.pty.kill(${JSON.stringify(childId)})`);

  let deadPush = null;
  const deadDeadline = Date.now() + 10000;
  while (Date.now() < deadDeadline) {
    const snap = JSON.parse(
      await page.evalJs(`
        (() => {
          const log = window.__filaPushLog ?? [];
          const after = log.slice(${pushCountAtRunning});
          const hits = [];
          for (const p of after) {
            const t = p.tasks.find((x) => x.id === ${JSON.stringify(taskId)});
            if (t) hits.push({ at: p.at, status: t.status, cardAlive: t.cardAlive, updatedAt: t.updatedAt });
          }
          return JSON.stringify({ hits });
        })()
      `),
    );
    // First post-kill push with cardAlive=false is the liveness edge
    // (dropEntry runs before resolveCardExit's possible task write).
    deadPush = snap.hits.find((h) => h.cardAlive === false);
    if (deadPush) break;
    await delay(80);
  }

  check("após exit, Fila recebeu push com cardAlive=false", !!deadPush, true);
  check("status derivado voltou a pending", deadPush?.status, "pending");
  check("primeiro push morto: cardAlive=false", deadPush?.cardAlive, false);
  check(
    "primeiro push morto manteve updatedAt do running (liveness antes de qualquer stamp)",
    deadPush?.updatedAt,
    updatedAtAtRunning,
  );

  const domAfter = JSON.parse(
    await page.evalJs(`
      (() => {
        const item = document.querySelector('[data-task-item-id="${taskId}"]');
        if (!item) return JSON.stringify({ ok: false });
        const colRoot = item.parentElement?.parentElement;
        const hasWip = !!colRoot?.querySelector('[data-part="wip-badge"]');
        const text = colRoot?.querySelector('[data-part="column-header"]')?.textContent?.trim() ?? "";
        return JSON.stringify({ hasWip, header: text });
      })()
    `),
  );
  check("DOM: item saiu da coluna em andamento", domAfter.hasWip, false);

  page.close();
} finally {
  await stopApp(app);
}

finish();

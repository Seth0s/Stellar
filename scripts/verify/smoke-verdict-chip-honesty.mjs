// Live proof: Fila chips for implementer "aprovado" vs reviewer "aprovado"
// are visibly different (muted "propõe concluir" vs green "aprovado").
// Isolated Electron profile only — never the owner's DB.
import { writeFileSync } from "node:fs";
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
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-verdict-chip-honesty-${CDP_PORT}`, import.meta.url).pathname;
const PROOF_PNG = new URL(`../../.verify-tmp/verdict-chip-honesty-${CDP_PORT}.png`, import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  return JSON.parse((await callTool(name, args)).content[0].text);
}

async function clickModalButton(page, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
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
    if (coords) {
      await page.click(coords.x, coords.y);
      return;
    }
    await delay(200);
  }
  throw new Error(`no modal button labeled "${label}"`);
}

async function spawnBash(page, requesterId, args) {
  const spawnPromise = callTool("spawn_agent", { provider: "bash", callerCardId: requesterId, ...args });
  await delay(500);
  await clickModalButton(page, "Permitir");
  const payload = JSON.parse((await spawnPromise).content[0].text);
  if (!payload.ok || typeof payload.cardId !== "string") {
    throw new Error(`spawn_agent failed: ${JSON.stringify(payload)}`);
  }
  await delay(400);
  return payload.cardId;
}

async function reportVerdict(page, cardId, verdict) {
  const json = JSON.stringify({ ok: true, result: `chip-honesty-${verdict}`, verdict }).replace(/"/g, '\\"');
  await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify(`acbridge report "${json}"\r`)})`);
  await delay(600);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Chip Honesty", { spawnTerminal: true });
  await delay(400);
  await spawnCard(page, "task");
  check("Fila monta", await page.evalJs(`!!document.querySelector('[data-part="create-task-input"]')`), true);

  const boardId = await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "Chip Honesty") ?? boards[0];
      return board.id;
    })()
  `);

  const cards0 = await toolJson("list_cards", {});
  const seedId = cards0.cards.find((c) => c.kind === "terminal")?.id;
  check("tem terminal seed", typeof seedId, "string");

  // Task A — only implementer "aprovado" (self-proposal).
  const implA = await spawnBash(page, seedId, { reason: "chip-honesty implementer A" });
  const taskA = await toolJson("create_task", {
    prompt: "PROVA chip — veredito do IMPLEMENTER",
    provider: "bash",
    cardId: implA,
    boardId,
  });
  check("task A criada", taskA.ok, true);
  await reportVerdict(page, implA, "aprovado");

  // Task B — reviewer "aprovado" (real green chip). Separate cards so
  // fan-out cannot stamp the implementer role onto the reviewer round.
  const implB = await spawnBash(page, seedId, { reason: "chip-honesty implementer B" });
  const taskB = await toolJson("create_task", {
    prompt: "PROVA chip — veredito do REVIEWER",
    provider: "bash",
    cardId: implB,
    boardId,
  });
  check("task B criada", taskB.ok, true);
  const revB = await spawnBash(page, seedId, {
    reason: "chip-honesty reviewer B",
    taskId: taskB.taskId,
    role: "reviewer",
    brief: "revisar e reportar verdict aprovado",
  });
  await reportVerdict(page, revB, "aprovado");

  await delay(800);

  const board = JSON.parse(
    await page.evalJs(`
      (async () => {
        const tasks = await window.tasks.listByBoard(${JSON.stringify(boardId)});
        const pick = (promptPart) => {
          const t = tasks.find((x) => (x.prompt || "").includes(promptPart));
          if (!t) return null;
          return {
            id: t.id,
            status: t.status,
            verdicts: t.verdicts,
            cards: t.cards.map((c) => ({ role: c.role, cardId: c.cardId })),
          };
        };
        return JSON.stringify({
          a: pick("IMPLEMENTER"),
          b: pick("REVIEWER"),
        });
      })()
    `),
  );

  check("task A tem veredito implementer/aprovado", board.a?.verdicts?.some((v) => v.role === "implementer" && v.verdict === "aprovado"), true);
  check("task B tem veredito reviewer/aprovado", board.b?.verdicts?.some((v) => v.role === "reviewer" && v.verdict === "aprovado"), true);
  check("task A e B ainda running (proposta visível)", board.a?.status === "running" && board.b?.status === "running", true);

  const chips = JSON.parse(
    await page.evalJs(`
      (() => {
        const items = [...document.querySelectorAll("[data-task-item-id]")];
        const read = (needle) => {
          const item = items.find((el) => (el.textContent || "").includes(needle));
          if (!item) return null;
          const chip = item.querySelector('[data-part="verdict-chip"]');
          if (!chip) return { foundItem: true, label: null, tone: null, bg: null };
          const cs = getComputedStyle(chip);
          return {
            foundItem: true,
            label: (chip.textContent || "").trim().toLowerCase(),
            tone: chip.getAttribute("data-tone"),
            bg: cs.backgroundColor,
          };
        };
        return JSON.stringify({
          implementer: read("IMPLEMENTER"),
          reviewer: read("REVIEWER"),
        });
      })()
    `),
  );

  check("chip implementer presente", Boolean(chips.implementer?.label), true);
  check("chip implementer = propõe concluir", chips.implementer?.label, "propõe concluir");
  check("chip implementer tone=muted", chips.implementer?.tone, "muted");
  check("chip reviewer presente", Boolean(chips.reviewer?.label), true);
  check("chip reviewer = aprovado", chips.reviewer?.label, "aprovado");
  check("chip reviewer tone=good", chips.reviewer?.tone, "good");
  check(
    "chips lado a lado com fundos distintos",
    Boolean(chips.implementer?.bg && chips.reviewer?.bg && chips.implementer.bg !== chips.reviewer.bg),
    true,
  );

  await page.send("Page.enable");
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(PROOF_PNG, Buffer.from(shot.data, "base64"));
  check("png da prova gravado", Boolean(shot.data), true);
  console.log(`LIVE_PROOF_PNG=${PROOF_PNG}`);
  console.log(`LIVE_PROOF_CHIPS=${JSON.stringify(chips)}`);

  page.close();
} finally {
  await stopApp(app);
}
finish();

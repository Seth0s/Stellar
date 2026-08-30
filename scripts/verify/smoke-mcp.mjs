// DESIGN-BACKLOG.md item 21, ponto 9 — the MCP server (mcp-server.ts) is
// the primary agent-facing interface now (claude/codex get it registered
// automatically at spawn time, see providers.ts; acbridge stays as the
// CLI fallback, both share message-bus.ts's one dispatcher). Drives the
// REAL Streamable HTTP protocol via plain `fetch()` — the same thing a
// provider's own MCP client implementation does — not a shortcut through
// some internal function.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9430;
// Matches cdp-client.mjs's own AGENT_CANVAS_MCP_PORT derivation (cdpPort
// + 40000) for isolated test instances — never the real app's port 4489.
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp", import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  // Stateless streamable-http can reply as plain JSON or as an SSE frame
  // ("event: message\ndata: {...}\n\n") depending on the SDK's internal
  // negotiation — handle both, confirmed live both shapes occur.
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "MCP Teste");
  await new Promise((r) => setTimeout(r, 500));

  const toolsList = await mcpCall("tools/list", {});
  const toolNames = (toolsList.result?.tools ?? []).map((t) => t.name).sort();
  check(
    "MCP server exposes the full expected tool set",
    JSON.stringify(toolNames),
    JSON.stringify([
      "card_status",
      "get_page_text",
      "list_cards",
      "open_url",
      "read_card",
      "read_report",
      "report",
      "send_to_card",
      "snapshot",
      "spawn_agent",
      "spawn_card",
    ]),
  );

  const listPayload = await toolJson("list_cards", {});
  check("list_cards reflects real board state (the seeded bash card)", listPayload.cards?.[0]?.provider, "bash");
  const bashCardId = listPayload.cards[0].id;

  const sendResult = await toolJson("send_to_card", { target: bashCardId, text: "echo mcp-smoke-$((1+1))" });
  check("send_to_card writes into the real card via MCP", sendResult.ok, true);

  // open_url — full consent round-trip: the MCP call blocks until a human
  // decides, the modal shows title/command/reason, Permitir resolves it.
  const openPromise = callTool("open_url", { url: "https://example.com", callerCardId: bashCardId, reason: "smoke test verification" });
  await new Promise((r) => setTimeout(r, 500));
  const modalInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const modal = document.querySelector('.modal');
        if (!modal) return JSON.stringify(null);
        return JSON.stringify({
          title: modal.querySelector('h3')?.textContent,
          requester: modal.querySelector('p strong')?.textContent,
          command: modal.querySelector('.agent-ask-command')?.textContent,
          reason: modal.querySelector('.agent-ask-reason')?.textContent,
        });
      })()
    `),
  );
  check("open_url shows the generic AgentAskModal with title", modalInfo?.title, "Permissão do navegador");
  // Achado ao vivo (2026-08-27): o rótulo do requester mostrava o id
  // bruto do banco local ("bash #<id>") — virou um ordinal por provider
  // dentro da sessão ("Bash 1°"), sem nenhum número de banco visível.
  // Este é o primeiro (e único, até aqui) card bash da sessão, então o
  // ordinal esperado é exatamente 1.
  check("...and the requester label is human-friendly, not the raw local db id", modalInfo?.requester, "Bash 1°");
  check("...with the command (the URL)", modalInfo?.command, "https://example.com");
  check("...and the agent-provided reason", modalInfo?.reason?.includes("smoke test verification"), true);
  await clickModalButton(page, "Permitir");
  const openResult = JSON.parse((await openPromise).content[0].text);
  check("open_url MCP call resolves ok after Permitir", openResult.ok, true);
  await new Promise((r) => setTimeout(r, 1200));
  check("a real browser card exists after the allowed open_url", await page.evalJs(`document.querySelectorAll('.browser-card').length`), 1);

  // spawn_agent — same consent shape, resolves with a real new cardId.
  const spawnAgentPromise = callTool("spawn_agent", { provider: "bash", callerCardId: bashCardId, reason: "need a second shell" });
  await new Promise((r) => setTimeout(r, 500));
  check("spawn_agent shows its own AgentAskModal title", await page.evalJs(`document.querySelector('.modal h3')?.textContent`), "Permissão: spawnar agente");
  await clickModalButton(page, "Permitir");
  const spawnAgentPayload = JSON.parse((await spawnAgentPromise).content[0].text);
  check("spawn_agent MCP call resolves ok with a cardId", spawnAgentPayload.ok && typeof spawnAgentPayload.cardId === "string", true);
  await new Promise((r) => setTimeout(r, 500));
  check("a second real terminal card exists after the allowed spawn_agent", await page.evalJs(`document.querySelectorAll('.terminal-card').length`), 2);

  // spawn_card, denied — must NOT create anything and must report the denial.
  // Requester here is the SECOND bash card (spawnAgentPayload.cardId), not
  // the first — real proof the ordinal actually increments per provider
  // instead of always reading "1°" by coincidence.
  const secondBashCardId = spawnAgentPayload.cardId;
  const spawnCardDenyPromise = callTool("spawn_card", { kind: "sticky", callerCardId: secondBashCardId });
  await new Promise((r) => setTimeout(r, 500));
  check(
    "the SECOND bash card's requester label is 'Bash 2°' (ordinal really increments, not hardcoded)",
    await page.evalJs(`document.querySelector('.modal p strong')?.textContent`),
    "Bash 2°",
  );
  await clickModalButton(page, "Negar");
  const spawnCardDenyPayload = JSON.parse((await spawnCardDenyPromise).content[0].text);
  check("spawn_card (denied) reports ok:false", spawnCardDenyPayload.ok, false);
  check("nothing got created by the denied spawn_card", await page.evalJs(`document.querySelectorAll('.sticky-card').length`), 0);

  // spawn_card, allowed — the sticky card actually appears.
  const spawnCardPromise = callTool("spawn_card", { kind: "sticky", callerCardId: bashCardId, reason: "note for later" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnCardPayload = JSON.parse((await spawnCardPromise).content[0].text);
  check("spawn_card (allowed) resolves ok with a cardId", spawnCardPayload.ok && typeof spawnCardPayload.cardId === "string", true);
  await new Promise((r) => setTimeout(r, 500));
  check("a real sticky card exists after the allowed spawn_card", await page.evalJs(`document.querySelectorAll('.sticky-card').length`), 1);

  // get_page_text — real extracted page content, not pixels.
  const browserCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'browser')?.id ?? null);
      })()
    `),
  );
  const pageTextPayload = await toolJson("get_page_text", { target: browserCardId });
  check(
    "get_page_text returns the real navigated page's text (not pixels, not empty)",
    pageTextPayload.ok && pageTextPayload.text?.includes("Example Domain"),
    true,
  );

  // snapshot — a real embedded MCP image content block, not a bare path
  // (an MCP client has no shared filesystem with this app — item 21
  // ponto 9's own audit named this as the point of the tool existing).
  const snapshotResult = await callTool("snapshot", { target: browserCardId });
  const block = snapshotResult.content[0];
  check("snapshot returns an embedded image content block", block.type, "image");
  check("...with a real, non-trivial amount of image data", block.data?.length > 5000, true);

  // Spawn depth guard — DESIGN-BACKLOG.md item 21 ponto 9 achado 1's
  // fork-bomb guard. A caller explicitly reporting the cap depth must be
  // refused outright — no consent modal even shown, asking a human to
  // approve something structurally disallowed is just noise.
  const depthGuardPayload = await toolJson("spawn_agent", { provider: "bash", callerCardId: bashCardId, depth: 3 });
  check("spawn_agent at the depth cap is refused without asking", depthGuardPayload.ok, false);
  check("...and shows no consent modal at all", await page.evalJs(`!document.querySelector('.modal')`), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

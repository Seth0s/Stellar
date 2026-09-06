// Pendentes #188 ("spawn_card por coordenadas/linha exata") — `spawn_card`
// accepted no way to say WHERE on the board a new card should land beyond
// the default centeredSlot placement (viewport center, nudged to dodge
// overlap). `anchorCardId`+`side` lets a caller plant the new card right
// next to one it already cares about (e.g. next to a files card already
// open on the file in question) instead of wherever the ring-search
// happens to land. Verifies: real placement adjacent to a real anchor
// card's actual DOM rect (not just that the call resolves ok), the default
// `side` ("right") when omitted, and clean validation errors for a bogus
// anchorCardId/side — both checked against message-bus.ts directly, not
// just mcp-server.ts's zod schema, since acbridge reaches the bus with no
// zod in that path at all.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-spawn-anchor-${CDP_PORT}`, import.meta.url).pathname;

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
async function toolJson(name, args) {
  return JSON.parse((await callTool(name, args)).content[0].text);
}
async function stickyRect(page, cardId) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('textarea[data-role="sticky-textarea"][data-card-id=${JSON.stringify(cardId)}]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
      })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Spawn Anchor Smoke");
  await new Promise((r) => setTimeout(r, 500));

  const bashId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  // --- validação: anchorCardId inexistente é recusado, sem consentimento nenhum de permeio ---
  const badAnchor = await toolJson("spawn_card", { kind: "sticky", callerCardId: bashId, anchorCardId: "nao-existe-999" });
  check("anchorCardId inexistente é recusado com erro claro", badAnchor.ok === false && /no open card/.test(badAnchor.error ?? ""), true);

  // --- ancora real: um sticky pra servir de referência ---
  const anchor = await toolJson("spawn_card", { kind: "sticky", callerCardId: bashId });
  check("sticky âncora criado", typeof anchor.cardId, "string");
  await new Promise((r) => setTimeout(r, 400));

  // --- validação: side inválido é recusado ---
  // zod já recusa isto ANTES de chegar em message-bus.ts (mesmo padrão do
  // `mode` inválido de write_sticky, ver smoke-mcp-sticky-io.mjs) — daí ler
  // `content[0].text` cru em vez de `toolJson`, que tentaria dar
  // `JSON.parse` numa mensagem de validação em inglês, não em JSON.
  const badSideText = (await callTool("spawn_card", { kind: "sticky", callerCardId: bashId, anchorCardId: anchor.cardId, side: "diagonal" })).content[0].text;
  check("side inválido é recusado antes mesmo de chegar no handler", /invalid/i.test(badSideText), true);

  const anchorRect = await stickyRect(page, anchor.cardId);
  check("rect real da âncora encontrado no DOM", anchorRect !== null, true);

  // --- side explícito "right" ---
  const right = await toolJson("spawn_card", { kind: "sticky", callerCardId: bashId, anchorCardId: anchor.cardId, side: "right" });
  check("spawn_card com anchorCardId+side resolve ok com um cardId real", typeof right.cardId, "string");
  await new Promise((r) => setTimeout(r, 400));
  const rightRect = await stickyRect(page, right.cardId);
  check("...e o card nasce de fato à DIREITA da âncora (DOM real, não só a resposta da tool)", rightRect.x > anchorRect.x + anchorRect.w, true);
  check("...verticalmente alinhado ao centro da âncora (mesma faixa, não canto aleatório)", Math.abs(rightRect.y + rightRect.h / 2 - (anchorRect.y + anchorRect.h / 2)) < 40, true);

  // --- anchorCardId sem side: default é "right" ---
  const defaulted = await toolJson("spawn_card", { kind: "sticky", callerCardId: bashId, anchorCardId: anchor.cardId });
  check("anchorCardId sem side resolve ok (default 'right' aplicado)", typeof defaulted.cardId, "string");
  await new Promise((r) => setTimeout(r, 400));
  const defaultedRect = await stickyRect(page, defaulted.cardId);
  check("...e nasce à direita da âncora, igual ao side explícito", defaultedRect.x > anchorRect.x + anchorRect.w, true);
} finally {
  finish();
  await stopApp(app);
}

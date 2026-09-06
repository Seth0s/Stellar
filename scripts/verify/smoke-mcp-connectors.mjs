// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 4 — data model
// only (per explicit user decision): a `kind` column on `connectors`
// ('context'|'depends'|null), exposed via MCP (`list_connectors`/
// `set_connector_kind`). Nothing in this app dispatches off it — deciding
// WHEN a `depends` edge means "go" is left to an external orchestrating
// agent, driving spawn_agent itself (still consent-gated, same as ever).
//
// Draws a REAL connector via the actual UI drag gesture (same technique
// as smoke-connector.mjs) rather than writing a synthetic DB row —
// proves both that (1) a connector drawn by a human today still gets a
// real `kind: null` (decorative, never silently reinterpreted as a hard
// gate) and (2) the migration didn't break the existing UI path at all.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard, pickFreePort } from "./cdp-client.mjs";

const execFileAsync = promisify(execFile);
const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-connectors-${CDP_PORT}`, import.meta.url).pathname;
const ACBRIDGE_BIN = new URL("../../resources/bin/acbridge", import.meta.url).pathname;

async function runAcbridge(sockPath, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [ACBRIDGE_BIN, ...args], {
      env: { ...process.env, AGENT_CANVAS_SOCK: sockPath, AGENT_CANVAS_CARD_ID: "0" },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return { ok: false, stderr: (err.stderr ?? "").trim() };
  }
}

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
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page);
  await new Promise((r) => setTimeout(r, 500));

  // Rail reorg (2.2's "menu único de Ferramentas/Cards") moved card
  // creation behind an "Adicionar card" popover for every kind but
  // terminal — `spawnCard` (cdp-client.mjs) handles both shapes.
  async function spawnSticky() {
    await spawnCard(page, "sticky");
  }
  await spawnSticky();
  await spawnSticky();

  const zoomOutBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.title === "Diminuir zoom");
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  for (let i = 0; i < 6; i++) await page.click(zoomOutBtn.x, zoomOutBtn.y);
  await new Promise((r) => setTimeout(r, 200));

  const secondHead = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelectorAll('[data-kind="sticky"] .card-head')[1];
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  const dest = { x: 1000, y: 700 };
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: secondHead.x, y: secondHead.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dest.x, y: dest.y, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dest.x, y: dest.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));

  const [headA, headB] = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-kind="sticky"] .card-head')].map(el => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }))
    `),
  );

  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", text: "c" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC" });
  await new Promise((r) => setTimeout(r, 200));

  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: headA.x, y: headA.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (headA.x + headB.x) / 2, y: (headA.y + headB.y) / 2, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: headB.x, y: headB.y, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: headB.x, y: headB.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 500));

  check("um conector real foi desenhado (migração não quebrou o caminho existente da UI)", await page.evalJs(`document.querySelectorAll(".board-overlay path").length`), (n) => n > 0);

  const afterDraw = await toolJson("list_connectors", {});
  check("list_connectors reflete o conector real desenhado", afterDraw.connectors?.length > 0, true);
  const connectorId = afterDraw.connectors[0].id;
  check("...com kind null — decorativo, nunca reinterpretado como gate por padrão", afterDraw.connectors[0].kind, null);

  // Um kind inválido é barrado pelo próprio schema Zod no lado MCP — pra
  // testar a validação de verdade em `message-bus.ts` (que também serve o
  // acbridge, sem Zod na frente), passa pelo binário real do acbridge.
  const sockPath = `${USER_DATA_DIR}/agent-canvas.sock`;
  const invalidKindResult = await runAcbridge(sockPath, ["set-connector-kind", connectorId, "bogus"]);
  check("acbridge set-connector-kind com um kind inválido falha (validação real em message-bus.ts)", invalidKindResult.ok, false);

  const missingConnector = await toolJson("set_connector_kind", { connectorId: "nao-existe-123", kind: "depends" });
  check("set_connector_kind num connectorId inexistente reporta ok:false", missingConnector.ok, false);

  const setDepends = await toolJson("set_connector_kind", { connectorId, kind: "depends" });
  check("set_connector_kind marca 'depends' com sucesso", setDepends.ok, true);

  const afterSet = await toolJson("list_connectors", {});
  const updated = afterSet.connectors.find((c) => c.id === connectorId);
  check("list_connectors reflete o kind atualizado", updated?.kind, "depends");

  const cleared = await toolJson("set_connector_kind", { connectorId, kind: null });
  check("set_connector_kind com kind:null limpa de volta pra decorativo", cleared.ok, true);
  const afterClear = await toolJson("list_connectors", {});
  check("...e list_connectors reflete isso", afterClear.connectors.find((c) => c.id === connectorId)?.kind, null);

  page.close();
} finally {
  await stopApp(app);
}
finish();

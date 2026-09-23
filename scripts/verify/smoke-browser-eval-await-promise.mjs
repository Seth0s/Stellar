// (cabecalho minimo; a explicacao longa esta no comentario da fixture)
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_URL = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-eval-await-${CDP_PORT}`);

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  let result;
  try {
    result = await callTool(name, args);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  const body = result.content[0].text;
  try {
    return JSON.parse(body);
  } catch {
    return { ok: false, error: body };
  }
}
function parseEval(raw) {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

// instância continua sendo uma promise nativa por dentro, mas o objeto carrega
// os símbolos do Zone e o `window.Promise` NÃO é mais o nativo).
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="alvo">pronto</div>
<script>
  const NativePromise = window.Promise;
  function ZoneLikePromise(executor) {
    const self = new NativePromise(executor);
    self.__zone_symbol__state = null;
    self.__zone_symbol__value = undefined;
    return self;
  }
  ZoneLikePromise.resolve = (v) => {
    const p = NativePromise.resolve(v);
    p.__zone_symbol__state = true;
    p.__zone_symbol__value = v;
    return p;
  };
  ZoneLikePromise.all = NativePromise.all.bind(NativePromise);
  ZoneLikePromise.race = NativePromise.race.bind(NativePromise);
  ZoneLikePromise.reject = NativePromise.reject.bind(NativePromise);
  window.Promise = ZoneLikePromise;
  window.__promiseEhNativa = (window.Promise === NativePromise);
  // Espera de verdade (promise NATIVA por dentro): o caso "eval legitimamente
  // lento" precisa de tempo real, não de um busy loop.
  window.sleep = (ms) => new NativePromise((r) => setTimeout(r, ms));
</script>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Eval await", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  async function waitFor(selector, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`)) === true) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`selector ${selector} never appeared within ${timeoutMs}ms`);
  }
  await waitFor('[data-role="rail-add-card"]');
  const railBtn = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('[data-role="rail-add-card"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(railBtn.x, railBtn.y);
  await waitFor('.popover-row[data-kind="browser"]');
  const browserRow = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('.popover-row[data-kind="browser"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(browserRow.x, browserRow.y);
  await new Promise((r) => setTimeout(r, 1000));
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardIds = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))`,
    ),
  );
  const cardId = cardIds[cardIds.length - 1];
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(`http://127.0.0.1:${port}/`)} )`);
  await new Promise((r) => setTimeout(r, 1200));

  const evalOn = async (js, extra = {}) => toolJson("browser_eval", { target: cardId, js, ...extra });

  // --- 0. a fixture NÃO é nativa (senão o resto passaria por vacuidade) -----
  const nativa = await evalOn("JSON.stringify(window.__promiseEhNativa)");
  check("a fixture substitui a Promise global (como o Zone.js faz)", parseEval(nativa.result), false);

  // --- 1. MODO 2: a Promise devolvida tem de ser ESPERADA, com o valor ------
  const sanidade = await evalOn("1 + 1");
  check("sanidade: um eval simples devolve o valor", parseEval(sanidade.result), 2);
  const envelopado = await evalOn("(async () => { const v = Promise.resolve(42); return await v; })()");
  check("diagnostico: envelope async explicito no chamador devolve o valor", parseEval(envelopado.result), 42);
  // Direto, SEM `JSON.stringify` no chamador: stringificar a promise do Zone
  // devolve o objeto interno dela por construção (as chaves são próprias e
  // enumeráveis) e isso mediria o smoke, não a ferramenta — foi assim que uma
  // versão anterior deste arquivo passou a medir a si mesma.
  const direto = await evalOn("Promise.resolve(42)");
  check("Promise.resolve(42) devolve o VALOR, não o objeto interno do Zone", parseEval(direto.result), 42);
  check("...e o resultado não carrega os símbolos do Zone", /__zone_symbol__/.test(String(direto.result)), false);

  const assincrono = await evalOn("new Promise((r) => setTimeout(() => r('tarde'), 400))");
  check("uma Promise que resolve depois é ESPERADA", parseEval(assincrono.result), "tarde");

  const thenable = await evalOn("({ then: (r) => r('thenable') })");
  check("um THENABLE (objeto com .then, não uma Promise) também é esperado", parseEval(thenable.result), "thenable");

  // --- 2. MODO 1: timeout PRÓPRIO, com erro que diz o que houve -------------
  const inicio = Date.now();
  const travado = await evalOn("new Promise(() => {})", { timeoutMs: 3000 });
  const esperou = Date.now() - inicio;
  check("uma Promise que nunca resolve é recusada", travado.ok, false);
  check("...depois do timeout PRÓPRIO (3s), não do idle timeout alheio", esperou < 30000, true);
  check("...e o erro diz o que foi esperado", /3000|3s/.test(travado.error ?? ""), true);
  check("...que o script pode continuar rodando", /KEPT RUNNING|still running|segue rodando/i.test(travado.error ?? ""), true);
  check("...e como aumentar o limite", /timeoutMs/.test(travado.error ?? ""), true);

  // --- 3. o limite é parâmetro: um eval legitimamente lento passa ----------
  const lento = await evalOn("sleep(1500)", { timeoutMs: 6000 });
  check("um eval lento (1,5s) com limite maior passa", lento.ok, true);
  const rapido = await evalOn("sleep(1500)", { timeoutMs: 500 });
  check("...e o MESMO eval com limite curto é recusado (o limite é respeitado)", rapido.ok, false);

  finish();
} catch (err) {
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:\n${app.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  server.close();
}


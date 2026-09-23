// `browser_type` CONCATENAVA em vez de substituir — e duplicou dado que o
// humano já tinha digitado (task 770abd6e). Relato do dono, valores reais:
// `#company-name-input` ficou "Idy PlatformIdy Platform". A saída de
// emergência que existia (limpar por `browser_eval` com o setter nativo)
// passa no React e é frágil no Angular — o conserto que parece bom.
//
// Este smoke MEDE a substituição em TRÊS frameworks de verdade (React 18,
// Vue 3 e AngularJS pelo `ng-model`, que é o mesmo contrato do
// DefaultValueAccessor do Angular: escutar `input`), mais um `<input>` cru e
// um `contenteditable`. Em cada um se mede o VALOR do campo E o estado do
// PRÓPRIO framework (o span que ele renderiza): escrever o DOM sem avisar o
// framework passaria na primeira checagem e falharia na segunda.
//
// IME-SAFE não é detalhe: a auditoria exige UM `beforeinput` com
// `inputType: "insertText"` e ZERO `keydown` de tecla imprimível.
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_URL = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-type-replace-${CDP_PORT}`);

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
    // A porta MCP RECUSA campo desconhecido com uma frase (não com JSON) —
    // "Unrecognized key: ...", e é isso que este smoke mede antes do
    // conserto existir. Devolve como resposta em vez de explodir.
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

// A fixture: os três frameworks de verdade (servidos pela rede — o card
// offscreen alcança, medido) + um input cru + um contenteditable + dois alvos
// NÃO editáveis (um div e um input readonly).
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
<script src="https://unpkg.com/angular@1.8.3/angular.min.js"></script>
<script>
  window.__libs = { react: typeof React, reactDom: typeof ReactDOM, vue: typeof Vue, angular: typeof angular };
  window.__audit = [];
  document.addEventListener('beforeinput', (e) => window.__audit.push({ t: 'beforeinput', inputType: e.inputType, data: e.data }), true);
  document.addEventListener('keydown', (e) => window.__audit.push({ t: 'keydown', key: e.key }), true);
</script>
<p>react <span id="react-root"></span></p>
<p>vue <span id="vue-root"></span></p>
<p>ng <span id="ng-root" ng-app="a" ng-controller="C"><input id="ng-input" ng-model="valor"><span id="ng-state">{{valor}}</span></span></p>
<p>plain <input id="plain"><span id="plain-state"></span></p>
<p>rich <div id="rich" contenteditable="true"></div></p>
<p>nao-editavel <div id="nao-editavel">texto que nao pode sumir</div></p>
<p>readonly <input id="readonly-field" readonly value="nao mexer"></p>
<script>
  try {
    if (window.React && window.ReactDOM) {
      const e = React.createElement;
      function App() {
        const [v, setV] = React.useState("");
        return e('span', null, e('input', { id: 'react-input', value: v, onChange: (ev) => setV(ev.target.value) }), e('span', { id: 'react-state' }, v));
      }
      ReactDOM.createRoot(document.getElementById('react-root')).render(e(App));
    }
    if (window.Vue) {
      Vue.createApp({ data: () => ({ valor: '' }), template: '<span><input id="vue-input" v-model="valor"><span id="vue-state">{{ valor }}</span></span>' }).mount('#vue-root');
    }
    if (window.angular) {
      angular.module('a', []).controller('C', function ($scope) { $scope.valor = ''; });
    }
    document.getElementById('plain').addEventListener('input', (ev) => {
      document.getElementById('plain-state').textContent = 'state:' + ev.target.value;
    });
  } catch (err) {
    window.__libsError = String(err);
  }
</script>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, skip, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Type replace", { spawnTerminal: false });
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

  async function evalOn(js) {
    return parseEval((await toolJson("browser_eval", { target: cardId, js })).result);
  }
  // Os quatro scripts vêm da REDE: espera os apps montarem (a medição é do
  // framework de verdade, não de uma imitação do contrato dele).
  let ready = false;
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline) {
    const probe = await evalOn(
      "JSON.stringify(!!(window.React && window.Vue && window.angular && document.getElementById('react-input') && document.getElementById('vue-input') && document.getElementById('ng-input')))",
    );
    if (probe === true) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready) {
    const libs = await evalOn("JSON.stringify({libs: window.__libs || null, erro: window.__libsError || null})");
    skip("matriz React/Vue/AngularJS", `os frameworks não montaram (medido: ${JSON.stringify(libs)}) — provavelmente sem rede`);
  }

  const value = (selector) => evalOn(`JSON.stringify((document.querySelector(${JSON.stringify(selector)}) || {}).value || '')`);
  const textOf = (selector) => evalOn(`JSON.stringify((document.querySelector(${JSON.stringify(selector)}) || {}).textContent || '')`);
  /** Espera o campo CHEGAR ao valor esperado em vez de apostar num sleep fixo:
   * numa máquina compartilhada (vários smokes com Electron ao mesmo tempo) a
   * latência varia — medido: dois casos deste smoke falharam por timing e
   * passaram depois sem nenhuma mudança de código. */
  async function waitForValue(selector, expected, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await value(selector);
      if (last === expected) return last;
      await new Promise((r) => setTimeout(r, 120));
    }
    return last;
  }
  async function waitForText(selector, expected, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await textOf(selector);
      if (last === expected) return last;
      await new Promise((r) => setTimeout(r, 120));
    }
    return last;
  }
  const auditReset = () => toolJson("browser_eval", { target: cardId, js: "window.__audit = []; 'ok'" });
  const audit = () => evalOn("JSON.stringify(window.__audit)");

  // --- 1. o incidente, campo por campo, nos TRÊS frameworks -----------------
  // "Idy Platform" digitado num campo que JÁ tem "Idy Platform" (o que o dono
  // fez à mão) tem de terminar em "Idy Platform", não em
  // "Idy PlatformIdy Platform".
  const TEXTO = "Idy Platform";
  const cases = [
    { nome: "React 18", input: "#react-input", state: "#react-state" },
    { nome: "Vue 3", input: "#vue-input", state: "#vue-state" },
    { nome: "AngularJS (ng-model)", input: "#ng-input", state: "#ng-state" },
    { nome: "input cru", input: "#plain", state: "#plain-state", statePrefix: "state:" },
  ];
  if (ready) {
    for (const c of cases) {
      const pre = await toolJson("browser_type", { target: cardId, selector: c.input, text: TEXTO });
      const loaded = await waitForValue(c.input, TEXTO);
      if (!pre.ok || loaded !== TEXTO) {
        console.log(`  detalhe pre-carga ${c.nome}: ${JSON.stringify(pre)} valor=${JSON.stringify(loaded)}`);
      }
      check(`${c.nome}: pré-carga pelo próprio tool`, loaded, TEXTO);

      const replaced = await toolJson("browser_type", { target: cardId, selector: c.input, text: TEXTO, replace: true });
      // Sem esta checagem o caso passaria por VACUIDADE: uma chamada RECUSADA
      // também deixa o valor igual ao que já estava lá (nada foi digitado).
      check(`${c.nome}: a chamada com replace:true foi aceita`, replaced.ok, true);
      const finalValue = await waitForValue(c.input, TEXTO);
      if (finalValue !== TEXTO) {
        console.log(`  detalhe replace ${c.nome}: ${JSON.stringify(replaced)} valor=${JSON.stringify(finalValue)}`);
      }
      check(`${c.nome}: replace:true NÃO duplica o que já estava lá`, finalValue, TEXTO);
      check(`${c.nome}: e o estado do PRÓPRIO framework concorda`, await waitForText(c.state, (c.statePrefix ?? "") + TEXTO), (c.statePrefix ?? "") + TEXTO);
    }
  }

  // --- 2. contenteditable: o parâmetro vale, ou recusa nomeando? -----------
  await toolJson("browser_type", { target: cardId, selector: "#rich", text: "Todas" });
  await new Promise((r) => setTimeout(r, 150));
  const richReplace = await toolJson("browser_type", { target: cardId, selector: "#rich", text: "TodasInform", replace: true });
  await new Promise((r) => setTimeout(r, 250));
  check("contenteditable: replace:true responde ok", richReplace.ok, true);
  check("contenteditable: o texto final é o novo, não a soma", await evalOn("JSON.stringify(document.getElementById('rich').innerText)"), "TodasInform");

  // --- 3. IME-SAFE: a substituição não pode reintroduzir digitação por tecla -
  await auditReset();
  await toolJson("browser_type", { target: cardId, selector: "#plain", text: "composicao", replace: true });
  await new Promise((r) => setTimeout(r, 250));
  // O ÚLTIMO `beforeinput` é o desta chamada — usar o primeiro media um evento
  // que podia ser de uma chamada anterior (a lista é da página, não do tool).
  const events = await audit();
  const insercoes = events.filter((e) => e.t === "beforeinput" && e.inputType === "insertText");
  check(
    "replace:true entra como insertText (IME-safe), sem tecla por caractere",
    insercoes.length >= 1 && events.filter((e) => e.t === "keydown").length === 0,
    true,
  );
  check("...e o texto que chegou é o texto pedido, de uma vez", insercoes[insercoes.length - 1]?.data, "composicao");

  // --- 4. o default segue APPEND (quem depende dele não quebra) -------------
  await toolJson("browser_type", { target: cardId, selector: "#plain", text: "A", replace: true });
  await toolJson("browser_type", { target: cardId, selector: "#plain", text: "B" });
  await new Promise((r) => setTimeout(r, 200));
  check("sem replace, o comportamento de hoje continua (append)", await value("#plain"), "AB");

  // --- 5. alvo NÃO editável: recusa NOMEANDO, sem limpar pela metade -------
  const antesNaoEditavel = await textOf("#nao-editavel");
  const naoEditavel = await toolJson("browser_type", { target: cardId, selector: "#nao-editavel", text: "x", replace: true });
  await new Promise((r) => setTimeout(r, 200));
  check("replace:true num alvo não editável é recusado", naoEditavel.ok, false);
  check("...nomeando o motivo (não é campo editável)", /not an editable field/.test(naoEditavel.error ?? ""), true);
  check("...e o conteúdo do alvo NÃO foi mexido", await textOf("#nao-editavel"), antesNaoEditavel);

  const readonlyRes = await toolJson("browser_type", { target: cardId, selector: "#readonly-field", text: "outro", replace: true });
  await new Promise((r) => setTimeout(r, 200));
  check("replace:true num campo readonly é recusado", readonlyRes.ok, false);
  check("...e o valor dele continua o mesmo", await value("#readonly-field"), "nao mexer");

  finish();
} catch (err) {
  // O stderr do app é a única testemunha do processo main quando ele morre no
  // meio do run (medido: "fetch failed" em toda chamada seguinte).
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:
${app.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  server.close();
}

// Medição PONTUAL (task 18df327e) — `browser_navigate` contra os FRAMEWORKS
// REAIS, não contra um modelo de router escrito à mão:
//
//   - React Router v6 (BrowserRouter) — bundle real (react 18 + react-router-dom
//     6.30), gerado com o esbuild que já está no repo;
//   - Vue Router 4 (history mode) — builds globais oficiais do vue 3.5.
//
// Por que um `investigate-*` e não um `smoke-*`: o smoke da suíte é hermético
// (só servidor local do próprio Node) e roda em qualquer máquina; este depende
// de bibliotecas de TERCEIROS instaladas FORA do repo. Sem elas, este script
// diz \"NÃO MEDIDO\" e sai com 2 — nunca verde por vacuidade.
//
// O que ele mede, no Chromium real do app real:
//
//   A. o incidente relatado, reproduzido com o router de verdade: uma
//      navegação de DOCUMENTO para uma rota protegida cai no guard (a sessão
//      em memória nasceu agora) e a URL volta para a raiz;
//   B. o conserto com o MESMO router: `browser_navigate` para a mesma rota
//      chega, sem remontar a SPA (o carimbo de nascimento da página não muda);
//   C. e D.: o mesmo par (incidente / conserto) com o Vue Router 4.
//
// O que ele NÃO mede, e por isso não é afirmado: Angular Router. Não há build
// UMD/JIT simples para instalar aqui (Angular 12 era a última linha com
// `bundles/*.umd.js`), então o Angular aparece como NÃO MEDIDO — e é
// justamente para esse caso que a tool devolve erro NOMEADO em vez de
// `ok:true`: ela mede a chegada, não confia no framework.
//
// Uso:
//   STELLAR_NAV_FRAMEWORKS=/tmp/stellar-nav-frameworks \
//     node scripts/verify/investigate-browser-navigate-frameworks.mjs
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const FW = process.env.STELLAR_NAV_FRAMEWORKS ?? "/tmp/stellar-nav-frameworks";
const REACT_APP = join(FW, "react-app.js");
const VUE_GLOBAL = join(FW, "node_modules/vue/dist/vue.global.js");
const VUE_ROUTER_GLOBAL = join(FW, "node_modules/vue-router/dist/vue-router.global.js");

const missing = [REACT_APP, VUE_GLOBAL, VUE_ROUTER_GLOBAL].filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.log(`NÃO MEDIDO — frameworks reais não estão instalados. Faltando: ${missing.join(", ")}`);
  console.log("(instale com: npm i --no-save --no-package-lock --prefix /tmp/stellar-nav-frameworks vue@3 vue-router@4 react@18 react-dom@18 react-router-dom@6");
  console.log(" e gere o bundle: node_modules/.bin/esbuild react-entry.mjs --bundle --format=iife --platform=browser --outfile=react-app.js)");
  process.exit(2);
}

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-nav-frameworks-${CDP_PORT}`);

let nextRpcId = 1;
async function toolJson(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  const rpc = JSON.parse(jsonLine);
  if (rpc.error) throw new Error(`MCP error: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

// A SPA React: a \"sessão\" vive SÓ na memória da instância (um remount a perde,
// que é o defeito), o login acontece na rota home, e `/react/b` é protegida.
const reactHtml = `<!doctype html><html><head><meta charset="utf-8"><title>react-router v6</title></head>
<body style="margin:0"><div id="root">carregando</div>
<script src="/react-app.js"></script></body></html>`;

// A SPA Vue, mesma forma: `beforeEach` recusa quem não tem a sessão em memória.
const vueHtml = `<!doctype html><html><head><meta charset="utf-8"><title>vue-router 4</title></head>
<body style="margin:0"><div id="app">carregando</div>
<script src="/vue.global.js"></script>
<script src="/vue-router.global.js"></script>
<script>
  window.__spaBornAt = Date.now();
  var loggedIn = false;
  var routes = [
    {
      path: \"/vue\",
      component: {
        setup: function () {
          loggedIn = true;
          return function () {
            return Vue.h(\"div\", { id: \"view\" }, \"home vue-router 4\");
          };
        },
      },
    },
    {
      path: \"/vue/b\",
      component: {
        setup: function () {
          return function () {
            return Vue.h(\"div\", null, [
              Vue.h(\"div\", { id: \"view\" }, \"painel vue-router 4\"),
              Vue.h(\"div\", { id: \"painel\" }, \"marcador\"),
            ]);
          };
        },
      },
    },
  ];
  var router = VueRouter.createRouter({ history: VueRouter.createWebHistory(), routes: routes });
  router.beforeEach(function () {
    return loggedIn ? true : \"/vue\";
  });
  Vue.createApp({
    render: function () {
      return Vue.h(VueRouter.RouterView);
    },
  })
    .use(router)
    .mount(\"#app\");
</script></body></html>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const file = { "/react-app.js": REACT_APP, "/vue.global.js": VUE_GLOBAL, "/vue-router.global.js": VUE_ROUTER_GLOBAL }[path];
  if (file) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(readFileSync(file));
    return;
  }
  if (path === "/react" || path === "/react/b") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(reactHtml);
    return;
  }
  if (path === "/vue" || path === "/vue/b") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(vueHtml);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function waitForSelector(page, selector, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`)) === true) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`selector ${selector} never appeared`);
}

async function createBrowserCard(page, url) {
  await waitForSelector(page, '[data-role="rail-add-card"]');
  const rail = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('[data-role="rail-add-card"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); })()`),
  );
  await page.click(rail.x, rail.y);
  await new Promise((r) => setTimeout(r, 400));
  await waitForSelector(page, '.popover-row[data-kind="browser"]');
  const row = JSON.parse(
    await page.evalJs(`(() => { const b = document.querySelector('.popover-row[data-kind="browser"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); })()`),
  );
  await page.click(row.x, row.y);
  await waitForSelector(page, '[data-role="browser-address"] input');
  await new Promise((r) => setTimeout(r, 800));
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cards = JSON.parse(
    await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((c) => JSON.stringify(c.filter((x) => x.kind === 'browser').map((x) => x.id)))`),
  );
  const cardId = cards[cards.length - 1];
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(url)})`);
  return cardId;
}

/** Estado REAL da página: URL, view, marcador de painel e carimbo de
 * nascimento (o que prova remount). */
async function state(cardId) {
  const res = await toolJson("browser_eval", {
    target: cardId,
    js: `({ url: String(location.href), view: document.getElementById('view') ? document.getElementById('view').textContent : null, painel: !!document.getElementById('painel'), bornAt: window.__spaBornAt === undefined ? null : window.__spaBornAt })`,
  });
  return JSON.parse(String(res.result));
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Nav frameworks", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));
  const cardId = await createBrowserCard(page, `${BASE}/react`);
  const documentNavigate = (url) => page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(url)})`);
  const nav = (args) => toolJson("browser_navigate", { target: cardId, ...args });

  const loaded = (t) => {
    const deadline = Date.now() + 12000;
    return (async () => {
      while (Date.now() < deadline) {
        const probe = await toolJson("browser_eval", { target: cardId, js: "!!document.getElementById('view')" });
        if (String(probe.result) === "true") {
          await new Promise((r) => setTimeout(r, 300));
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`fixture ${t} never loaded`);
    })();
  };

  // ---- A. React Router v6 REAL: o incidente (navegação de documento) -------
  await loaded("react");
  await documentNavigate(`${BASE}/react/b`);
  await new Promise((r) => setTimeout(r, 1200));
  const incidenteReact = await state(cardId);
  check("React Router v6: navegação de DOCUMENTO para rota protegida cai no guard", new URL(incidenteReact.url).pathname, "/react");
  check("...e a view é a home (a sessão em memória nasceu agora)", /home react-router/.test(incidenteReact.view ?? ""), true);

  // ---- B. React Router v6 REAL: o conserto (in-app) ------------------------
  await documentNavigate(`${BASE}/react`);
  await loaded("react");
  const antesReact = await state(cardId);
  const resReact = await nav({ url: "/react/b", expectSelector: "#painel", timeoutMs: 3000 });
  const depoisReact = await state(cardId);
  console.log("DIAGNOSTICO react: " + JSON.stringify({ res: resReact, antes: antesReact, depois: depoisReact }));
  check("React Router v6: browser_navigate chega na rota protegida", resReact.ok, true);
  check("...com a URL real na rota pedida", new URL(depoisReact.url).pathname, "/react/b");
  check("...sem remontar a SPA (carimbo intacto)", depoisReact.bornAt, antesReact.bornAt);
  check("...e sem precisar de expectSelector (o sinal forte confirma)", resReact.arrival, "expect-selector");

  // ---- C/D. Vue Router 4 REAL: incidente e conserto ------------------------
  await documentNavigate(`${BASE}/vue`);
  await loaded("vue");
  await documentNavigate(`${BASE}/vue/b`);
  await new Promise((r) => setTimeout(r, 1200));
  const incidenteVue = await state(cardId);
  check("Vue Router 4: navegação de DOCUMENTO para rota protegida cai no guard", new URL(incidenteVue.url).pathname, "/vue");

  await documentNavigate(`${BASE}/vue`);
  await loaded("vue");
  const antesVue = await state(cardId);
  const resVue = await nav({ url: "/vue/b", expectSelector: "#painel", timeoutMs: 3000 });
  const depoisVue = await state(cardId);
  console.log("DIAGNOSTICO vue: " + JSON.stringify({ res: resVue, antes: antesVue, depois: depoisVue }));
  check("Vue Router 4: browser_navigate chega na rota protegida", resVue.ok, true);
  check("...com a URL real na rota pedida", new URL(depoisVue.url).pathname, "/vue/b");
  check("...sem remontar a SPA (carimbo intacto)", depoisVue.bornAt, antesVue.bornAt);

  console.log("\nNÃO MEDIDO — Angular Router: sem build UMD/JIT instalável aqui (motivo no cabeçalho).");
  console.log("VEREDITO — React Router v6: " + (resReact.ok ? "CHEGA in-app" : "NÃO CHEGA") + "; Vue Router 4: " + (resVue.ok ? "CHEGA in-app" : "NÃO CHEGA") + "; Angular: não medido.");
} finally {
  await stopApp(app);
  server.close();
}
finish();

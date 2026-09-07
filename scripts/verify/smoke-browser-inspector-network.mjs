// DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 4) — a aba Network do
// Inspector deixa de fazer polling de `session.webRequest` (via
// `getNetwork`, que continua servindo a tool MCP e o resumo da aba
// Performance, intocado) e passa a receber push ao vivo do domínio
// `Network` do CDP: `Network.requestWillBeSent`/`responseReceived`/
// `loadingFinished`/`loadingFailed`. Ganha o que era ausente antes:
// headers de request/response reais, corpo da resposta
// (`Network.getResponseBody`, sob demanda ao expandir uma linha),
// timing (duração calculada do relógio monotônico do CDP, não wall-clock)
// e initiator. `Network.enable` só liga quando a aba abre pela 1ª vez
// (não no attach do inspector inteiro — é o único domínio com custo real
// de buffering de bodies), então este teste dispara cada requisição
// DEPOIS de abrir a aba, igual o DevTools real exige.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-network-${CDP_PORT}`, import.meta.url).pathname;

const FIXTURE_HTML = `<!doctype html><html><body style="margin:0">
  <h1>Fixture de rede</h1>
  <script>
    window.__fireOk = () => fetch("/api/ok", { headers: { "x-stellar-marker": "abc123" } }).catch(() => {});
    window.__fireFail = () => fetch("/api/missing").catch(() => {});
  </script>
</body></html>`;
const httpPort = await pickFreePort();
const server = createServer((req, res) => {
  if (req.url === "/api/ok") {
    res.writeHead(200, { "content-type": "application/json", "x-stellar-response": "resp456" });
    res.end('{"hello":"world"}');
    return;
  }
  if (req.url === "/api/missing") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res) throw new Error(`element not found: ${selector}`);
  return res;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Network Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const addBtn = await centerOf(page, '[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf(page, '.popover-row[data-kind="browser"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 700));

  const browserId = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((b) => window.store.list(b[0].id)).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'browser').id))`),
  );
  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 700));

  const kebab = await centerOf(page, '[data-role="browser-address"] button[title="Mais opções"]');
  await page.click(kebab.x, kebab.y);
  await new Promise((r) => setTimeout(r, 300));
  const inspectorBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-menu"] button')].find((x) => x.textContent.includes('Abrir inspector'));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(inspectorBtn.x, inspectorBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  const networkTab = await centerOf(page, '[data-role="inspector-tab"][data-tab="network"]');
  await page.click(networkTab.x, networkTab.y);
  await new Promise((r) => setTimeout(r, 300));

  check(
    "sem nenhuma requisição disparada ainda (depois da aba abrir), a lista começa vazia",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-network"] [data-role="inspector-network-row"]')`),
    false,
  );

  // --- Requisição bem-sucedida, disparada DEPOIS da aba abrir (push ao vivo) ---
  await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.__fireOk()")`);
  await new Promise((r) => setTimeout(r, 500));

  const okRowText = await page.evalJs(`
    [...document.querySelectorAll('[data-role="inspector-network-row"]')].find((r) => r.textContent.includes('api/ok'))?.textContent ?? null
  `);
  check("push ao vivo: a requisição bem-sucedida aparece SEM precisar de refresh nenhum", okRowText !== null, true);
  check("...com o status real (200)", (okRowText ?? "").includes("200"), true);
  check("...e a duração real (não '…' parado pra sempre)", /\d+ ms/.test(okRowText ?? ""), true);

  const okRow = await centerOf(page, '[data-role="inspector-network-row"]');
  await page.click(okRow.x, okRow.y);
  await new Promise((r) => setTimeout(r, 400));

  const detailText = await page.evalJs(`document.querySelector('[data-role="inspector-network-detail"]')?.textContent ?? ""`);
  check("expandir a linha mostra o REQUEST header real que a página mandou (x-stellar-marker)", detailText.includes("x-stellar-marker") && detailText.includes("abc123"), true);
  check("...e o RESPONSE header real que o servidor mandou (x-stellar-response)", detailText.includes("x-stellar-response") && detailText.includes("resp456"), true);

  const bodyText = await page.evalJs(`document.querySelector('[data-role="inspector-network-body-content"]')?.textContent ?? ""`);
  check("...e o CORPO real da resposta (Network.getResponseBody, não um placeholder)", bodyText.includes("hello") && bodyText.includes("world"), true);

  // --- Requisição que falha (404) ---
  await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.__fireFail()")`);
  await new Promise((r) => setTimeout(r, 500));

  const allRowsText = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-network-row"]')].map((r) => r.textContent))`),
  );
  check("a requisição 404 também aparece ao vivo, com o status real", allRowsText.some((t) => t.includes("api/missing") && t.includes("404")), true);

  // "Tudo" é o default — clica no botão "Falhas" (achado por texto, não
  // por posição, pra não depender da ordem dos botões na barra).
  const filterButtons = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-role="inspector-network-filter"]')].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }))
    `),
  );
  const failuresBtn = filterButtons.find((b) => b.text === "Falhas");
  await page.click(failuresBtn.x, failuresBtn.y);
  await new Promise((r) => setTimeout(r, 200));
  const filteredRowsText = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-network-row"]')].map((r) => r.textContent))`),
  );
  check("filtro 'Falhas' esconde a requisição 200, só mostra a 404", filteredRowsText.every((t) => !t.includes("api/ok")) && filteredRowsText.some((t) => t.includes("api/missing")), true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();

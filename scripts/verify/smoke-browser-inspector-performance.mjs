// DESIGN-BACKLOG.md §2.1 item 8 (2026-09-07) — aba Performance, do zero.
// FPS ao vivo (o MESMO evento `browser:frame` que BrowserCard.tsx já
// escuta pra desenhar; o inspector escuta em paralelo) e CPU/memória
// reais do processo offscreen (`app.getAppMetrics()`, browser-registry.
// ts's `getProcessStats`) nunca dependeram de CDP. Este teste força uma
// animação real na página (CSS contínuo, dispara `paint` de verdade) e
// confirma que o número que aparece muda de verdade, não é um
// placeholder estático.
//
// DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 5, 2026-09-07) — adiciona
// profiling de CPU real via `Profiler.start`/`stop`: a fixture ganha uma
// função JS pesada (`__burnCpu`, busy-loop real, não decorativo) chamada
// repetidas vezes DURANTE a coleta, provando que o V8 sampler real
// identifica ela como hotspot depois de "Parar profiling".
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-performance-${CDP_PORT}`, import.meta.url).pathname;

// Uma animação CSS contínua garante frames reais chegando o tempo todo
// (sem isso, uma página parada só pinta uma vez e o FPS ficaria 0/1,
// dificultando confirmar que a MEDIÇÃO em si funciona, não só que ela
// existe).
const FIXTURE_HTML = `<!doctype html><html><head><style>
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  #spinner { width: 40px; height: 40px; background: red; animation: spin 0.3s linear infinite; }
</style></head><body style="margin:0"><div id="spinner"></div>
  <script>
    window.__burnCpu = function burnCpu() {
      const until = Date.now() + 300;
      let x = 0;
      while (Date.now() < until) { x += Math.sqrt(x + 1); }
      return x;
    };
  </script>
</body></html>`;
const httpPort = await pickFreePort();
const server = createServer((_req, res) => {
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

async function textOf(page, selector) {
  return page.evalJs(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Performance Teste", { spawnTerminal: false });
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
  await new Promise((r) => setTimeout(r, 800));

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

  const perfTab = await centerOf(page, '[data-role="inspector-tab"][data-tab="performance"]');
  await page.click(perfTab.x, perfTab.y);
  await new Promise((r) => setTimeout(r, 300));

  check("a nota de escopo do profiling de CPU aparece na aba Performance", await page.evalJs(`!!document.querySelector('[data-role="inspector-performance-notice"]')`), true);

  // Espera 2 ticks do medidor (1s cada) pra ter pelo menos 1 amostra real.
  await new Promise((r) => setTimeout(r, 2200));

  const fpsText = await textOf(page, '[data-role="inspector-perf-fps"] div:last-child');
  check("FPS ao vivo mostra um número real (não '—'), com a animação da fixture rodando", fpsText !== "—" && !Number.isNaN(Number(fpsText)), true);
  check("...e o FPS medido é maior que zero (frames de verdade chegando)", Number(fpsText) > 0, true);

  const cpuText = await textOf(page, '[data-role="inspector-perf-cpu"] div:last-child');
  check("CPU do processo mostra um valor real (getProcessStats/app.getAppMetrics, não mock)", /%$/.test(cpuText ?? ""), true);

  const memText = await textOf(page, '[data-role="inspector-perf-memory"] div:last-child');
  check("Memória do processo mostra um valor real em MB", /MB$/.test(memText ?? ""), true);

  const barCount = await page.evalJs(`document.querySelectorAll('[data-role="inspector-perf-bar"]').length`);
  check("a timeline de barras acumula pelo menos 1 amostra real", barCount >= 1, true);

  // Espera mais um tick e confirma que o número de barras CRESCE (é uma
  // janela deslizante ao vivo, não um gráfico estático desenhado uma vez).
  await new Promise((r) => setTimeout(r, 1100));
  const barCountAfter = await page.evalJs(`document.querySelectorAll('[data-role="inspector-perf-bar"]').length`);
  check("...e a timeline continua crescendo com o tempo (medição contínua, não um snapshot único)", barCountAfter > barCount, true);

  // --- Profiling de CPU real (Fase 5, adoção de CDP) ---
  const profileToggle = await centerOf(page, '[data-role="inspector-perf-profile-toggle"]');
  await page.click(profileToggle.x, profileToggle.y);
  await new Promise((r) => setTimeout(r, 300));
  check(
    "clicar 'Iniciar profiling' liga a coleta de verdade (botão reflete o estado ativo)",
    await page.evalJs(`document.querySelector('[data-role="inspector-perf-profile-toggle"]')?.getAttribute('data-active') === 'true'`),
    true,
  );

  // Queima CPU de verdade DURANTE a coleta — sem isso o profile viria
  // vazio (função nunca amostrada) e o teste provaria só que o botão
  // muda de estado, não que o V8 sampler capturou trabalho real.
  for (let i = 0; i < 4; i++) {
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.__burnCpu()")`);
  }

  // Recalcula as coordenadas — o texto do botão muda ("Parar profiling"
  // é mais longo) e a linha "Coletando amostras…" aparece, o suficiente
  // pra reposicionar o botão; reusar as coordenadas de antes do 1º clique
  // erraria o alvo.
  const profileToggleAfterStart = await centerOf(page, '[data-role="inspector-perf-profile-toggle"]');
  await page.click(profileToggleAfterStart.x, profileToggleAfterStart.y);
  await new Promise((r) => setTimeout(r, 500));
  check(
    "clicar 'Parar profiling' desliga a coleta (botão volta ao estado inativo)",
    await page.evalJs(`document.querySelector('[data-role="inspector-perf-profile-toggle"]')?.getAttribute('data-active')`),
    null,
  );

  const profileRows = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-perf-profile-table"] tbody tr')].map((r) => r.textContent))`),
  );
  check(
    "o resultado do profiling mostra a função REAL que consumiu CPU (burnCpu, amostrada pelo V8 sampler de verdade)",
    profileRows.some((r) => r.includes("burnCpu")),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();

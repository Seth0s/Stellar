// Update dialog prototype (Atualizacao.dc.html): renders every anchored state
// in an isolated Electron page, checks the runtime filled the template and the
// dialog shows the right pieces, and writes prints under /tmp/update-ui/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAppDocument, connectPageRaw, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO = join(PROJECT_ROOT, "docs/design/app-v3/prototipo/Atualizacao.dc.html");
const OUT_DIR = "/tmp/update-ui";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// anchor -> what the dialog must show
const STATES = {
  available: { title: /Atualização disponível/, has: ["update-notes"], primary: /Baixar/ },
  downloading: { title: /Baixando/, has: ["update-progress"], primary: null },
  ready: { title: /Pronta para instalar/, has: ["update-running-warning"], primary: /Reiniciar agora/ },
  "ready-empty": { title: /Pronta para instalar/, has: ["update-running-warning"], primary: /Reiniciar agora/ },
  installing: { title: /Instalando/, has: ["update-installing"], primary: null },
  error: { title: /Não foi possível atualizar/, has: ["update-error-message", "update-error-detail", "update-releases-link"], primary: /Tentar de novo/ },
  "error-signature": { title: /Não foi possível atualizar/, has: ["update-error-message"], primary: /Tentar de novo/ },
  "error-disk": { title: /Não foi possível atualizar/, has: ["update-error-message"], primary: /Tentar de novo/ },
  "linux-manual": { title: /não se atualiza sozinha/, has: ["update-manual-steps"], primary: /Abrir página de releases/ },
};

const userData = mkdtempSync(join(tmpdir(), "stellar-update-proto-"));
const cdpPort = await pickFreePort();
const app = await startApp({ cdpPort, userDataDir: userData });
try {
  const page = await connectPageRaw(cdpPort);
  await assertAppDocument(page.evalJs);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const [anchor, want] of Object.entries(STATES)) {
    await page.send("Page.navigate", { url: `file://${PROTO}?cena=${anchor}#${anchor}` });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await page.evalJs(`document.documentElement.getAttribute('data-dc-ready') === '1'`).catch(() => false);
      if (!ready) await delay(150);
    }
    check(`#${anchor}: runtime ready`, ready, true);
    await delay(300);
    const st = await page.evalJs(`(() => {
      const d = document.querySelector('[data-part="update-dialog"]');
      const r = d?.getBoundingClientRect();
      const primary = d?.querySelector('[data-part="update-primary"]');
      return {
        state: d?.getAttribute('data-state') ?? null,
        title: d?.querySelector('h1')?.textContent ?? '',
        parts: [...(d?.querySelectorAll('[data-part]') ?? [])].map((e) => e.getAttribute('data-part')),
        primary: primary?.textContent ?? null,
        unfilled: /\\{\\{|\\}\\}/.test(document.body.innerText),
        inside: !!r && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
        scrolls: d ? [...d.querySelectorAll('*')].some((e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY === 'auto') : null,
      };
    })()`);
    check(`#${anchor}: dialog is in the right state`, st.state, anchor);
    check(`#${anchor}: title`, want.title.test(st.title), true);
    for (const part of want.has) check(`#${anchor}: shows ${part}`, st.parts.includes(part), true);
    if (want.primary) check(`#${anchor}: primary action`, want.primary.test(st.primary ?? ""), true);
    else check(`#${anchor}: no primary action`, st.primary, null);
    check(`#${anchor}: no unfilled placeholders`, st.unfilled, false);
    check(`#${anchor}: dialog fits the window`, st.inside, true);
    check(`#${anchor}: body does not scroll`, st.scrolls, false);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `proto-${anchor}.png`), Buffer.from(shot.data, "base64"));
  }
  page.close();
} finally {
  await stopApp(app);
  rmSync(userData, { recursive: true, force: true });
}
finish();

/**
 * Prototype × app parity for the update dialog, by getComputedStyle and text.
 *
 * Same viewport (1440×900, device scale 1) and the same mock facts on both
 * sides: Stellar 0.9.0 offered to someone on 0.8.7, a 38,2 MB package, 48% at
 * 3,1 MB/s, three terminals and two agents in two sessions, and so on. The app
 * side is a real build driven through `window.updater.testSetState` (a hook
 * that is inert in packaged builds); the prototype is the approved
 * Atualizacao.dc.html opened in the same Electron page.
 *
 * Writes /tmp/update-ui/parity-table.md, parity.json, app-<state>.png,
 * proto-<state>.png and side-by-side-<state>.png. Exit 1 on any divergence.
 */
import { startApp, stopApp, connectPageRaw, assertAppDocument, makeChecker, pickFreePort, bootIntoFreshSession } from "./cdp-client.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO = join(ROOT, "docs/design/app-v3/prototipo/Atualizacao.dc.html");
const OUT = "/tmp/update-ui";
mkdirSync(OUT, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const { check, finish } = makeChecker();

// ---- selector helpers: the prototype uses plain classes, the app CSS-module names ----
const D = '[data-part="update-dialog"]';
const c = (name) => ({ p: `.${name}`, a: `[class*="_${name}_"]` });
const pair = (name, p, a, props) => ({ name, p: p.replace(/\$D/g, D), a: a.replace(/\$D/g, D), props });
const both = (name, sel, props) => pair(name, sel, sel, props);
const cls = (name, pre, post, props, label) => pair(label ?? name, `${pre}${c(name).p}${post}`, `${pre}${c(name).a}${post}`, props);

const BOX = ["@width", "@height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "backgroundColor", "borderTopWidth", "borderTopColor", "borderTopLeftRadius"];
const TEXT = ["fontSize", "fontWeight", "color", "@text"];
const BTN = ["@height", "paddingLeft", "paddingRight", "borderTopLeftRadius", "backgroundColor", "color", "fontSize", "fontWeight", "borderTopWidth", "@text"];

const COMMON = [
  both("dialog", D, ["@width", "borderTopLeftRadius", "backgroundColor", "borderTopWidth", "borderTopColor", "boxShadow"]),
  both("header", `${D} > header`, ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap", "@height"]),
  cls("tile", `${D} `, "", ["@width", "@height", "borderTopLeftRadius", "backgroundColor", "color"]),
  both("title", `${D} h1`, [...TEXT, "lineHeight"]),
  both("subtitle", `${D} h1 + div > span:first-child`, ["fontSize", "color", "@text"]),
  both("body", `${D} > div`, ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap", "flexDirection"]),
  both("footer", `${D} > footer`, ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap", "justifyContent", "@height"]),
];
const CLOSE = both("close button", `${D} > header > button`, ["@width", "@height", "borderTopLeftRadius", "backgroundColor", "color", "borderTopColor"]);
const PRIMARY = both("primary button", '[data-part="update-primary"]', BTN);
const QUIET = cls("btnQuiet", `${D} footer `, "", BTN, "quiet button");
const HINT = both("closing hint", `${D} > div > div:last-child`, ["fontSize", "color", "lineHeight", "@text"]);

const FRAMES = {
  available: [
    ...COMMON, CLOSE, PRIMARY, QUIET, HINT,
    both("jump badge", '[data-part="update-jump"]', ["fontSize", "color", "backgroundColor", "borderTopLeftRadius", "paddingTop", "paddingLeft", "@text"]),
    both("notes heading", '[data-part="update-notes"] h2', [...TEXT, "letterSpacing"]),
    cls("note", '[data-part="update-notes"] ', "", ["fontSize", "color", "gap", "lineHeight", "@text"], "note"),
    cls("noteDot", '[data-part="update-notes"] ', "", ["@width", "@height", "backgroundColor", "borderTopLeftRadius", "marginTop"], "note dot"),
    both("all-changes link", '[data-part="update-notes"] a', ["fontSize", "color", "textDecorationLine", "@text"]),
  ],
  downloading: [
    ...COMMON, CLOSE, QUIET, HINT,
    cls("mono", '[data-part="update-progress"] ', "", ["fontSize", "fontWeight", "@text"], "percent"),
    both("transferred", '[data-part="update-progress"] > div:first-child > span:last-child', ["fontSize", "color", "@text"]),
    both("progress bar", '[data-part="update-progress"] [role="progressbar"]', ["@height", "backgroundColor", "borderTopLeftRadius"]),
    cls("fill", '[data-part="update-progress"] ', "", ["@width", "@height", "backgroundColor", "borderTopLeftRadius"], "progress fill"),
    both("speed row", '[data-part="update-progress"] > div:last-child', ["fontSize", "color", "gap", "@text"]),
    pair("secondary button", `${D} footer .btn:not(.btnQuiet)`, `${D} footer button:not([class*="_btnQuiet_"])`, BTN),
  ],
  ready: [
    ...COMMON, CLOSE, PRIMARY, QUIET, HINT,
    both("ready text", `${D} > div > div:first-child`, ["fontSize", "color", "lineHeight", "@text"]),
    both("restart warning", '[data-part="update-running-warning"]', [...BOX, "gap", "@text"]),
    both("warning title", '[data-part="update-running-warning"] > span > span:first-child', ["fontWeight", "color", "@text"]),
    both("warning body", '[data-part="update-running-warning"] > span > span:last-child', ["color", "@text"]),
  ],
  "ready-empty": [
    ...COMMON, PRIMARY, QUIET, HINT,
    both("nothing-running box", '[data-part="update-running-warning"]', [...BOX, "gap", "color", "@text"]),
  ],
  installing: [
    ...COMMON,
    both("installing bar", '[data-part="update-installing"] [role="progressbar"]', ["@height", "backgroundColor", "borderTopLeftRadius"]),
    cls("slide", '[data-part="update-installing"] ', "", ["@height", "backgroundColor", "borderTopLeftRadius"], "indeterminate fill"),
    both("installing text", '[data-part="update-installing"] > div:nth-child(2)', ["fontSize", "color", "lineHeight", "@text"]),
    both("installing note", '[data-part="update-installing"] > div:nth-child(3)', ["fontSize", "color", "@text"]),
    both("restarting status", `${D} footer > span`, ["fontSize", "color", "@text"]),
  ],
  error: [
    ...COMMON, CLOSE, PRIMARY,
    both("error box", '[data-part="update-error-message"]', [...BOX, "gap", "@text"]),
    both("error title", '[data-part="update-error-message"] > span > span:first-child', ["fontWeight", "color", "@text"]),
    both("error body", '[data-part="update-error-message"] > span > span:last-child', ["color", "@text"]),
    both("detail label", `${D} > div > div:nth-child(2) > span:first-child`, ["fontSize", "color", "@text"]),
    both("detail code", '[data-part="update-error-detail"]', [...BOX, "fontSize", "fontFamily", "color", "@text"]),
    both("hint", `${D} > div > div:last-child`, ["fontSize", "color", "lineHeight", "@text"]),
    both("releases link", '[data-part="update-releases-link"]', BTN),
  ],
  "error-signature": [
    ...COMMON,
    both("error title", '[data-part="update-error-message"] > span > span:first-child', ["@text"]),
    both("error body", '[data-part="update-error-message"] > span > span:last-child', ["@text"]),
    both("detail code", '[data-part="update-error-detail"]', ["@text"]),
    both("hint", `${D} > div > div:last-child`, ["@text"]),
  ],
  "error-disk": [
    ...COMMON,
    both("error title", '[data-part="update-error-message"] > span > span:first-child', ["@text"]),
    both("error body", '[data-part="update-error-message"] > span > span:last-child', ["@text"]),
    both("detail code", '[data-part="update-error-detail"]', ["@text"]),
    both("hint", `${D} > div > div:last-child`, ["@text"]),
  ],
  "linux-manual": [
    ...COMMON, CLOSE, PRIMARY, QUIET,
    both("manual text", `${D} > div > div:first-child`, ["fontSize", "color", "lineHeight", "@text"]),
    both("steps", '[data-part="update-manual-steps"]', ["gap", "flexDirection", "@height"]),
    cls("step", '[data-part="update-manual-steps"] ', "", ["fontSize", "color", "gap", "@text"], "step"),
    cls("stepNo", '[data-part="update-manual-steps"] ', "", ["@width", "@height", "backgroundColor", "color", "fontSize", "fontWeight", "borderTopLeftRadius"], "step number"),
    both("command box", '[data-part="update-manual-steps"] > div:nth-child(2) > span:last-child > span:last-child', [...BOX, "gap", "@text"]),
    pair("copy button", '[data-part="update-manual-steps"] .btn', '[data-part="update-manual-steps"] button', [...BTN, "fontSize"]),
    both("note", `${D} > div > div:last-child`, ["fontSize", "color", "@text"]),
  ],
};

// ---- the mock facts, identical to the prototype's ----
const NOTES = [
  "Novo: a atualização agora tem janela própria, com progresso e reinício pelo botão.",
  "Melhor: erros de conexão dizem o que houve e oferecem tentar de novo.",
  "Corrigido: arquivar duas tasks seguidas travava a Fila por alguns segundos.",
  "Corrigido: o menu de perfil não alternava entre conta e local.",
];
const MOCK = { version: "0.9.0", changelog: NOTES.map((n) => `- ${n}`).join("\n"), downloadBytes: 38_200_000 };
const ERR = { kind: "network", stage: "download", code: "net::ERR_INTERNET_DISCONNECTED", detail: "net::ERR_INTERNET_DISCONNECTED", percent: 62, transferred: 23_700_000, total: 38_200_000, neededBytes: null, freeBytes: null, swapLogPath: null };
const STATES = {
  available: [{ ...MOCK, phase: "available" }, null],
  downloading: [{ ...MOCK, phase: "downloading", progress: { percent: 48, transferred: 18_400_000, total: 38_200_000, bytesPerSecond: 3_100_000 } }, null],
  ready: [{ ...MOCK, phase: "ready" }, { terminals: 3, agents: 2, sessions: 2 }],
  "ready-empty": [{ ...MOCK, phase: "ready" }, { terminals: 0, agents: 0, sessions: 0 }],
  installing: [{ ...MOCK, phase: "installing" }, null],
  error: [{ ...MOCK, phase: "error", error: ERR }, null],
  "error-signature": [
    { ...MOCK, phase: "error", error: { ...ERR, kind: "signature", code: null, detail: "sha512 checksum mismatch (esperado 7f3a…c91e, recebido 02bd…44a7)", percent: null, transferred: null, total: null } },
    null,
  ],
  "error-disk": [
    { ...MOCK, phase: "error", error: { ...ERR, kind: "disk", code: "ENOSPC", detail: "no space left on device, write", percent: null, transferred: null, total: null, neededBytes: 120_000_000, freeBytes: 41_000_000 } },
    null,
  ],
  "linux-manual": [
    { ...MOCK, phase: "manual", manual: { manager: "dnf", fileName: "stellar-0.9.0-1.x86_64.rpm", command: "sudo dnf install ./stellar-0.9.0-1.x86_64.rpm" } },
    null,
  ],
};

const MEASURE = (pairs, side) => `(() => {
  const out = {};
  for (const pair of ${JSON.stringify(pairs)}) {
    const el = document.querySelector(pair[${JSON.stringify(side)}]);
    if (!el) { out[pair.name] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const row = {};
    for (const p of pair.props) {
      if (p === "@width") row[p] = r.width;
      else if (p === "@height") row[p] = r.height;
      else if (p === "@text") row[p] = el.innerText.replace(/\\s+/g, " ").trim();
      else row[p] = cs[p];
    }
    out[pair.name] = row;
  }
  return out;
})()`;

const userData = mkdtempSync(join(tmpdir(), "stellar-update-parity-"));
const cdpPort = await pickFreePort();
const app = await startApp({
  cdpPort,
  userDataDir: userData,
  extraArgs: ["--force-device-scale-factor=1", "--ozone-platform=x11"],
  extraEnv: { GDK_SCALE: "1", GDK_DPI_SCALE: "1" },
});
const appOut = {};
const protoOut = {};
try {
  const page = await connectPageRaw(cdpPort);
  await assertAppDocument(page.evalJs);
  await page.send("Page.enable");
  const viewport = async () => {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evalJs(`document.body.style.zoom = "1.001"`);
    await delay(50);
    await page.evalJs(`document.body.style.zoom = "1"`);
    await delay(150);
  };
  await viewport();
  await bootIntoFreshSession(page, "Sessão de Teste", { spawnTerminal: false });
  await delay(500);
  await page.evalJs(`window.__stellarUpdateTest.setFacts({ currentVersion: "0.8.7", releaseUrl: "https://example.test/releases", install: { canInstall: true } })`);

  // ---------- the app ----------
  for (const [anchor, [snapshot, counts]] of Object.entries(STATES)) {
    await page.evalJs(`window.updater.testSetState(${JSON.stringify(snapshot)}, ${JSON.stringify(counts)})`);
    await delay(250);
    const open = await page.evalJs(`!!document.querySelector('[data-part="update-dialog"]')`);
    if (!open) {
      await page.evalJs(`document.querySelector('[data-role="update-icon"]')?.click()`);
      await delay(250);
    }
    if (anchor.startsWith("ready")) await delay(350); // the running counts arrive over IPC
    const pairs = FRAMES[anchor];
    appOut[anchor] = await page.evalJs(MEASURE(pairs, "a"));
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `app-${anchor}.png`), Buffer.from(shot.data, "base64"));
    // Close it again so the next state is opened the way a user opens it.
    await page.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await delay(150);
  }

  // ---------- the prototype, in the same page and viewport ----------
  for (const anchor of Object.keys(STATES)) {
    await page.send("Page.navigate", { url: `file://${PROTO}?cena=${anchor}#${anchor}` });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await page.evalJs(`document.documentElement.getAttribute('data-dc-ready') === '1'`).catch(() => false);
      if (!ready) await delay(150);
    }
    await viewport();
    // Offline, the prototype falls back to a system face; point its family names at the bundled files.
    const fontCss = [400, 500, 600, 700]
      .map((w) => `@font-face{font-family:'Space Grotesk';font-weight:${w};src:url('file://${ROOT}node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-${w}-normal.woff2') format('woff2');}`)
      .concat(
        [400, 500].map((w) => `@font-face{font-family:'JetBrains Mono';font-weight:${w};src:url('file://${ROOT}node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2') format('woff2');}`),
      )
      .join("");
    await page.evalJs(`(async () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(fontCss)}; document.head.appendChild(s); await document.fonts.ready; return 1; })()`);
    await delay(400);
    protoOut[anchor] = await page.evalJs(MEASURE(FRAMES[anchor], "p"));
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `proto-${anchor}.png`), Buffer.from(shot.data, "base64"));
  }
  page.close();
} finally {
  await stopApp(app);
  rmSync(userData, { recursive: true, force: true });
}

// ---------- compare ----------
const norm = (v, prop) => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (prop === "fontFamily") return String(v).split(",")[0].replace(/"/g, "").trim();
  return String(v).replace(/(\d+\.\d{3,})px/g, (_, n) => `${Math.round(parseFloat(n) * 100) / 100}px`);
};
const rows = [];
let diffs = 0;
let compared = 0;
for (const [anchor, pairs] of Object.entries(FRAMES)) {
  for (const p of pairs) {
    const pv = protoOut[anchor]?.[p.name];
    const av = appOut[anchor]?.[p.name];
    if (!pv || !av) {
      rows.push(`| ${anchor} | ${p.name} | — | ${pv ? "proto ok" : "proto MISSING"} | ${av ? "app ok" : "app MISSING"} | ✗ |`);
      diffs++;
      check(`#${anchor} · ${p.name} exists on both sides`, false, true);
      continue;
    }
    const bad = [];
    for (const prop of p.props) {
      const a = norm(pv[prop], prop);
      const b = norm(av[prop], prop);
      compared++;
      const same = a === b;
      rows.push(`| ${anchor} | ${p.name} | ${prop} | ${a} | ${b} | ${same ? "✓" : "✗"} |`);
      if (!same) bad.push(`${prop}: proto ${a} ≠ app ${b}`);
    }
    diffs += bad.length;
    check(`#${anchor} · ${p.name} (${p.props.length} props)`, bad.join("; ") || "equal", (v) => v === "equal");
  }
}
writeFileSync(join(OUT, "parity-table.md"), `# Update dialog parity — Atualizacao.dc.html × app\n\n| state | element | property | prototype | app | |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n\nCompared values: ${compared} · divergent: ${diffs}\n`);
writeFileSync(join(OUT, "parity.json"), JSON.stringify({ proto: protoOut, app: appOut, compared, diffs }, null, 2));

for (const anchor of Object.keys(STATES)) {
  const py = `
from PIL import Image, ImageDraw
a = Image.open(${JSON.stringify(join(OUT, `proto-${anchor}.png`))}).convert("RGB")
b = Image.open(${JSON.stringify(join(OUT, `app-${anchor}.png`))}).convert("RGB")
box = (360, 60, 1080, 840)
a, b = a.crop(box), b.crop(box)
gap, lh = 16, 24
c = Image.new("RGB", (a.width + b.width + gap, a.height + lh), (12, 14, 18))
d = ImageDraw.Draw(c)
d.text((8, 6), "prototype · ${anchor}", fill=(180, 190, 210))
d.text((a.width + gap + 8, 6), "app · ${anchor}", fill=(180, 190, 210))
c.paste(a, (0, lh)); c.paste(b, (a.width + gap, lh))
c.save(${JSON.stringify(join(OUT, `side-by-side-${anchor}.png`))})
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) console.error(r.stderr);
}
console.log(`\nparity table: ${join(OUT, "parity-table.md")} — compared ${compared}, divergent ${diffs}`);
finish();

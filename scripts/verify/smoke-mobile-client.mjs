#!/usr/bin/env node
/**
 * Isolated smoke: createRemoteServer with prototype mock data + Electron
 * screenshots at 390×844 (proto 1:1, no canvas chrome) and side-by-side
 * at equal scale (804×844). Never touches the owner's app instance.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { WebSocket as NodeWebSocket } from "ws";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");
const PROTO_SRC = join(PROJECT_ROOT, "..", "StellarMobile", "docs", "design", "prototipo");
const CLIENT_DIR = join(PROJECT_ROOT, "resources", "mobile-client");
const OUT_DIR = "/tmp/mobile-client";
const ELECTRON_BIN = join(PROJECT_ROOT, "node_modules/.bin/electron");
mkdirSync(OUT_DIR, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const pickPort = () => 13000 + Math.floor(Math.random() * 5000);

async function loadCreateRemoteServer() {
  const tmpDir = join(PROJECT_ROOT, ".verify-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const stub = join(tmpDir, "electron-stub.mjs");
  writeFileSync(
    stub,
    `export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s), "utf8"),
  decryptString: (b) => Buffer.from(b).toString("utf8"),
};
`,
  );
  // Emit next to project node_modules so `ws`/`qrcode` resolve if left external.
  const bundled = join(tmpDir, "remote-server-bundle.mjs");
  await esbuild.build({
    entryPoints: [join(PROJECT_ROOT, "src/main/remote-server.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundled,
    alias: { electron: stub },
    // Resolve from Stellar/node_modules (parent of .verify-tmp).
    external: ["ws", "qrcode"],
    logLevel: "silent",
  });
  return (await import(pathToFileURL(bundled).href)).createRemoteServer;
}

function extractPhoneHtml(srcPath) {
  const raw = readFileSync(srcPath, "utf8");
  const styleMatch = raw.match(/<style>([\s\S]*?)<\/style>/);
  const start = raw.indexOf('<div style="width: 390px; height: 844px');
  if (start < 0) throw new Error("phone root not found in " + srcPath);
  const end = raw.indexOf("</x-dc>", start);
  if (end < 0) throw new Error("x-dc end not found in " + srcPath);
  let phone = raw.slice(start, end).trim();
  phone = phone.replace('style="width: 390px; height: 844px;', 'id="phone" style="width: 390px; height: 844px;');
  // Public-repo smoke: neutralize hostnames from the design mock.
  phone = phone.replaceAll("lucas-fedora", "desktop").replaceAll("lucas-notebook", "notebook");
  const styles = styleMatch ? styleMatch[1] : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=390, height=844, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
html,body{margin:0;padding:0;width:390px;height:844px;overflow:hidden;background:#0b0d12;zoom:1;-webkit-text-size-adjust:100%}
#phone{width:390px!important;height:844px!important;max-width:390px!important;max-height:844px!important;transform:none!important;zoom:1!important}
${styles}
</style></head><body>${phone}</body></html>`;
}

function serveMap(map) {
  const port = pickPort();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!map[rel]) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const body = map[rel];
    const type = rel.endsWith(".png") ? "image/png" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ port, close: () => server.close() })));
}

function runElectron(scriptPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ELECTRON_BIN, [scriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err || "electron " + code))));
  });
}

function writeShotScript(url, outPath, { width = 390, height = 844, afterLoad = "true", partition } = {}) {
  const runner = join(OUT_DIR, `_shot_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`);
  const part = partition ? JSON.stringify(partition) : "undefined";
  // Force DPR=1 so HiDPI (e.g. ~2.4× Wayland) does not zoom the page into
  // the top-left corner of a 390×844 content box.
  writeFileSync(
    runner,
    `import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("high-dpi-support", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: ${width}, height: ${height}, useContentSize: true, show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      partition: ${part},
      zoomFactor: 1,
    },
  });
  win.webContents.setZoomFactor(1);
  await win.loadURL(${JSON.stringify(url)});
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.setZoomFactor(1);
  await win.webContents.executeJavaScript(${JSON.stringify(afterLoad)});
  const metrics = await win.webContents.executeJavaScript(
    "({ dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight })",
  );
  if (Math.abs(metrics.dpr - 1) > 0.01 || metrics.iw < ${width} - 2 || metrics.ih < ${height} - 2) {
    console.error("bad viewport", metrics);
  }
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  writeFileSync(${JSON.stringify(outPath)}, img.toPNG());
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
`,
  );
  return runner;
}

/** Wait for mock cards/tasks then switch view (smoke harness). */
function goReady(view, { minCards = 5, empty = false } = {}) {
  return `(() => new Promise(async (resolve) => {
    const wantEmpty = ${empty ? "true" : "false"};
    const minCards = ${minCards};
    const deadline = Date.now() + 8000;
    try {
      while (Date.now() < deadline) {
        const s = window.__stellarMobile?.state?.();
        if (s?.connected) {
          if (wantEmpty || ((s.cards?.length || 0) >= minCards && (s.tasks?.length || 0) >= 3)) break;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      window.__stellarMobile?.go(${JSON.stringify(view)});
    } catch (e) { /* still capture */ }
    resolve(document.querySelector('[data-screen]')?.getAttribute('data-screen') || "none");
  }))()`;
}

function goPair() {
  return `(() => {
    localStorage.removeItem("ac-remote-token");
    window.__stellarMobile.go("pair");
    return document.querySelector('[data-screen]')?.getAttribute('data-screen');
  })()`;
}

function mockTerminals() {
  return [
    {
      id: "c-planos",
      label: "Planos (B11)",
      provider: "commandcode",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      awaitingHuman: true,
      status: "waiting",
      needKind: "question",
      needMeta: "pergunta · há 2 min",
      questionText: "Rodar make test-integration agora? Sobe um contêiner Postgres.",
      preview: "Pergunta: rodar make test-integration agora?",
      ageLabel: "2 min",
    },
    {
      id: "c-a5e",
      label: "Time no app (A5e)",
      provider: "commandcode",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      awaitingHuman: true,
      status: "waiting",
      preview: "Fechei a rodada 3. Print lado a lado anexado.",
      ageLabel: "6 min",
      badgeCount: 3,
    },
    {
      id: "c-gate",
      label: "Gate com ferramentas",
      provider: "commandcode",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      status: "running",
      preview: "rodando os gates · check:types",
      ageLabel: "9 min",
    },
    {
      id: "c-saude",
      label: "Saúde do card",
      provider: "commandcode",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      status: "running",
      preview: "lendo a cota do Command Code na tela",
      ageLabel: "18 min",
    },
    {
      id: "c-master",
      label: "Master",
      provider: "claude",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      status: "running",
      preview: "revisando o protótipo do celular",
      ageLabel: "agora",
    },
    {
      id: "c-leves",
      label: "Terminais leves e ambiente",
      provider: "commandcode",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      status: "idle",
      preview: "check:types · gate falhou",
      ageLabel: "24 min",
    },
    {
      id: "c-cota2",
      label: "Fila de spawn",
      provider: "commandcode",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      status: "running",
      preview: "aguardando slot · 1 na fila",
      ageLabel: "11 min",
    },
    {
      id: "c-revisor",
      label: "Revisor",
      provider: "antigravity",
      cwd: "/tmp/maestro",
      boardName: "Maestro",
      machineName: "desktop",
      status: "idle",
      preview: "Aprovado: 7 regressões corrigidas, nenhuma nova.",
      ageLabel: "1 h",
    },
    {
      id: "c-portal",
      label: "Portal · turmas",
      provider: "commandcode",
      cwd: "/tmp/idy",
      boardName: "Idyplatform",
      machineName: "desktop",
      status: "idle",
      preview: "Concluído. Report aprovado.",
      ageLabel: "ontem",
    },
    {
      id: "c-curriculo",
      label: "Currículo",
      provider: "claude",
      cwd: "/tmp/nb",
      boardName: "Sessão",
      machineName: "notebook",
      machineOffline: true,
      machineOfflineSince: "14:02",
      status: "idle",
      preview: 'Último visto: "pronto, PDF gerado."',
    },
  ];
}

function mockTasks() {
  return [
    {
      id: "t-a5e",
      title: "A5e — Time no app (telas 10 a 13)",
      phase: "awaiting_review",
      provider: "commandcode",
      cardId: "c-a5e",
      needKind: "review",
      needMeta: "report entregue · há 6 min",
      badge: "gates 2/2",
      chips: ["gates 2/2 · isolado", "report entregue", "commandcode"],
      canVerdict: true,
    },
    {
      id: "t-leves",
      title: "Terminais leves e ambiente",
      phase: "gate_fail",
      provider: "commandcode",
      cardId: "c-leves",
      needKind: "gate_fail",
      needMeta: "o report diz ok, o gate falhou",
      gateDetail: "check:types · useTerminal.ts(326) TS2322 · isolado",
      section: "running",
      chips: ["24 min"],
    },
    {
      id: "t-b11",
      title: "B11 — Planos e direitos",
      phase: "running",
      section: "running",
      cardId: "c-planos",
      chips: ["esperando você", "31 min"],
    },
    {
      id: "t-gate",
      title: "Gate com ferramenta de fora do repo",
      phase: "running",
      section: "running",
      cardId: "c-gate",
      chips: ["rodando gates 1/2 · check:types"],
    },
    { id: "t-ready-1", title: "Território compartilhado", phase: "ready", section: "ready" },
    { id: "t-ready-2", title: "Spawn na fila responde na hora", phase: "ready", section: "ready" },
    { id: "t-blocked", title: "A5b — Tasks completas", phase: "blocked", section: "blocked", needMeta: "depois de A5e" },
  ];
}

async function main() {
  const createRemoteServer = await loadCreateRemoteServer();
  const userDataDir = mkdtempSync(join(tmpdir(), "remote-ud-"));
  const port = pickPort();
  const server = createRemoteServer({
    port,
    mobileClientDir: CLIENT_DIR,
    userDataDir,
    listTerminals: mockTerminals,
    listTasks: mockTasks,
    getTask: (id) => mockTasks().find((t) => t.id === id) || null,
    onTaskVerdict: () => {},
    getScrollback: () => "mock scrollback\n",
    onWrite: () => {},
    onResize: () => {},
  });
  const pairing = await server.pairNewDevice("desktop");
  const clientBase = `http://127.0.0.1:${pairing.port}`;
  const tokenUrl = `${clientBase}/?token=${pairing.token}`;

  const protoMap = {};
  const protoFiles = {
    agora: "Main.dc.html",
    chats: "Chats.dc.html",
    tasks: "Tasks.dc.html",
    settings: "Settings.dc.html",
    pair: "Pair.dc.html",
  };
  for (const [name, file] of Object.entries(protoFiles)) {
    protoMap[`/proto-${name}.html`] = extractPhoneHtml(join(PROTO_SRC, file));
  }
  const protoSrv = await serveMap(protoMap);

  const checks = [];
  const check = (label, ok) => {
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
    checks.push(!!ok);
  };

  for (const name of Object.keys(protoFiles)) {
    const out = join(OUT_DIR, `proto-${name}.png`);
    await runElectron(writeShotScript(`http://127.0.0.1:${protoSrv.port}/proto-${name}.html`, out));
    const dim = execFileSync("identify", ["-format", "%wx%h", out], { encoding: "utf8" }).trim();
    check(`proto-${name} ${dim}`, dim === "390x844");
  }

  const part = "persist:stellar-mobile-smoke";
  await runElectron(
    writeShotScript(tokenUrl, join(OUT_DIR, "impl-agora.png"), {
      afterLoad: goReady("agora"),
      partition: part,
    }),
  );
  await runElectron(
    writeShotScript(tokenUrl, join(OUT_DIR, "impl-chats.png"), {
      afterLoad: goReady("chats"),
      partition: part,
    }),
  );
  await runElectron(
    writeShotScript(tokenUrl, join(OUT_DIR, "impl-tasks.png"), {
      afterLoad: goReady("tasks"),
      partition: part,
    }),
  );
  await runElectron(
    writeShotScript(tokenUrl, join(OUT_DIR, "impl-settings.png"), {
      afterLoad: goReady("settings"),
      partition: part,
    }),
  );
  await runElectron(
    writeShotScript(tokenUrl, join(OUT_DIR, "impl-chat-terminal.png"), {
      afterLoad: goReady("chat-terminal"),
      partition: part,
    }),
  );
  await runElectron(
    writeShotScript(tokenUrl, join(OUT_DIR, "impl-chat-drawer.png"), {
      afterLoad: goReady("chat-drawer"),
      partition: part,
    }),
  );
  await runElectron(
    writeShotScript(`${clientBase}/?pair=1`, join(OUT_DIR, "impl-pair.png"), {
      afterLoad: goPair(),
      partition: "persist:stellar-mobile-smoke-pair",
    }),
  );
  await runElectron(
    writeShotScript(`${clientBase}/?token=${pairing.token}&empty=1`, join(OUT_DIR, "impl-agora-empty.png"), {
      afterLoad: goReady("agora", { empty: true }),
      partition: "persist:stellar-mobile-smoke-empty",
    }),
  );
  await runElectron(
    writeShotScript(`${clientBase}/?token=${pairing.token}&empty=1`, join(OUT_DIR, "impl-tasks-empty.png"), {
      afterLoad: goReady("tasks", { empty: true }),
      partition: "persist:stellar-mobile-smoke-empty",
    }),
  );

  for (const name of ["agora", "chats", "tasks", "settings", "pair"]) {
    const dim = execFileSync("identify", ["-format", "%wx%h", join(OUT_DIR, `impl-${name}.png`)], {
      encoding: "utf8",
    }).trim();
    check(`impl-${name} ${dim}`, dim === "390x844");
  }

  // getComputedStyle table: key elements per screen (not only phone/h1)
  const styleScript = join(OUT_DIR, `_styles_${Date.now()}.mjs`);
  writeFileSync(
    styleScript,
    `import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("high-dpi-support", "1");
const PROPS = ["fontFamily","fontSize","fontWeight","lineHeight","color","backgroundColor","borderTopLeftRadius","borderRadius","paddingTop","paddingRight","paddingBottom","paddingLeft","letterSpacing","textTransform","minHeight"];
const SCREENS = [
  { key: "agora", proto: ${JSON.stringify(`http://127.0.0.1:${protoSrv.port}/proto-agora.html`)}, impl: ${JSON.stringify(tokenUrl)}, go: ${JSON.stringify(goReady("agora"))},
    selectors: {
      title: 'h1, [data-el="title"]',
      subtitle: 'header span[style*="13.5px"], [data-el="subtitle"], .sub',
      listItem: '.need, [data-el="list-item"].need, .need',
      chip: '.sec, [data-el="chip"]',
      tab: 'a.tab[aria-current="page"], .tab[aria-current="page"], .tab.active',
      btnPrimary: '.btn.primary, [data-el="btn-primary"], a.btn.primary',
    }},
  { key: "chats", proto: ${JSON.stringify(`http://127.0.0.1:${protoSrv.port}/proto-chats.html`)}, impl: ${JSON.stringify(tokenUrl)}, go: ${JSON.stringify(goReady("chats"))},
    selectors: {
      title: 'h1, [data-el="title"]',
      subtitle: 'header span[style*="13.5px"], [data-el="subtitle"], .sub',
      listItem: 'a.c, button.c, [data-el="list-item"].c',
      chip: '.fchip[aria-pressed="true"], [data-el="chip"]',
      tab: 'a.tab[aria-current="page"], .tab[aria-current="page"], .tab.active',
      btnPrimary: '.fchip[aria-pressed="true"]',
      search: 'input#q, input.search, [data-el="search"]',
    }},
  { key: "tasks", proto: ${JSON.stringify(`http://127.0.0.1:${protoSrv.port}/proto-tasks.html`)}, impl: ${JSON.stringify(tokenUrl)}, go: ${JSON.stringify(goReady("tasks"))},
    selectors: {
      title: 'h1, [data-el="title"]',
      subtitle: 'header span[style*="13.5px"], [data-el="subtitle"], .sub',
      listItem: '.t, button.t, [data-el="list-item"]',
      chip: '.seg[aria-selected="true"], [data-el="chip"]',
      tab: 'a.tab[aria-current="page"], .tab[aria-current="page"], .tab.active',
      btnPrimary: '.seg[aria-selected="true"]',
    }},
  { key: "pair", proto: ${JSON.stringify(`http://127.0.0.1:${protoSrv.port}/proto-pair.html`)}, impl: ${JSON.stringify(clientBase + "/?pair=1")}, go: ${JSON.stringify(goPair())},
    selectors: {
      title: 'h1, [data-el="title"]',
      subtitle: 'header p, [data-el="subtitle"], .sub',
      listItem: '.step, li.step',
      chip: '.num',
      tab: '.btn.primary, [data-el="btn-primary"], a.btn.primary',
      btnPrimary: '.btn.primary, [data-el="btn-primary"], a.btn.primary',
    }},
];
async function measure(win, selectors) {
  const fn = \`(sels) => {
    const PROPS = \${JSON.stringify(PROPS)};
    const out = {};
    for (const k of Object.keys(sels)) {
      const el = document.querySelector(sels[k]);
      if (!el) { out[k] = null; continue; }
      const s = getComputedStyle(el);
      out[k] = { tag: el.tagName.toLowerCase(), className: String(el.className || "") };
      for (const p of PROPS) out[k][p] = s[p];
    }
    return out;
  }\`;
  return win.webContents.executeJavaScript(\`(\${fn})(\${JSON.stringify(selectors)})\`);
}
app.whenReady().then(async () => {
  const result = { screens: {} };
  const rows = [];
  for (const scr of SCREENS) {
    async function load(url, js, partition) {
      const win = new BrowserWindow({
        width: 390, height: 844, useContentSize: true, show: false,
        webPreferences: { sandbox: true, contextIsolation: true, partition, zoomFactor: 1 },
      });
      win.webContents.setZoomFactor(1);
      await win.loadURL(url);
      await new Promise((r) => setTimeout(r, 1000));
      await win.webContents.setZoomFactor(1);
      if (js) { await win.webContents.executeJavaScript(js); await new Promise((r) => setTimeout(r, 500)); }
      const m = await measure(win, scr.selectors);
      win.close();
      return m;
    }
    const proto = await load(scr.proto, null, "persist:style-proto-" + scr.key);
    const impl = await load(scr.impl, scr.go, "persist:style-impl-" + scr.key);
    result.screens[scr.key] = { proto, impl };
    for (const el of Object.keys(scr.selectors)) {
      const p = proto[el];
      const i = impl[el];
      for (const prop of PROPS) {
        rows.push({
          screen: scr.key,
          el,
          prop,
          proto: p ? p[prop] : "(missing)",
          impl: i ? i[prop] : "(missing)",
          match: p && i ? String(p[prop]) === String(i[prop]) : false,
        });
      }
    }
  }
  writeFileSync(${JSON.stringify(join(OUT_DIR, "parity-styles.json"))}, JSON.stringify({ rows, screens: result.screens }, null, 2));
  const md = ["# getComputedStyle parity", "", "| screen | el | prop | proto | impl | match |", "|---|---|---|---|---|---|"];
  for (const r of rows) {
    if (!["fontSize","fontWeight","color","backgroundColor","borderRadius","paddingTop","letterSpacing","textTransform","minHeight"].includes(r.prop)) continue;
    md.push(\`| \${r.screen} | \${r.el} | \${r.prop} | \${String(r.proto).replace(/\\|/g,"\\\\|")} | \${String(r.impl).replace(/\\|/g,"\\\\|")} | \${r.match ? "✓" : "✗"} |\`);
  }
  writeFileSync(${JSON.stringify(join(OUT_DIR, "parity-styles.md"))}, md.join("\\n"));
  app.exit(0);
});
`,
  );
  await runElectron(styleScript);

  for (const name of ["agora", "chats", "tasks", "settings", "pair"]) {
    const left = join(OUT_DIR, `proto-${name}.png`);
    const right = join(OUT_DIR, `impl-${name}.png`);
    if (!existsSync(left) || !existsSync(right)) continue;
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;width:804px;height:844px;overflow:hidden;background:#05060a}
      main{display:grid;grid-template-columns:390px 390px;gap:24px;width:804px;height:844px}
      img{display:block;width:390px;height:844px}
    </style><main>
      <img width="390" height="844" src="data:image/png;base64,${readFileSync(left).toString("base64")}">
      <img width="390" height="844" src="data:image/png;base64,${readFileSync(right).toString("base64")}">
    </main>`;
    const sideSrv = await serveMap({ "/side.html": html });
    await runElectron(
      writeShotScript(`http://127.0.0.1:${sideSrv.port}/side.html`, join(OUT_DIR, `side-${name}.png`), {
        width: 804,
        height: 844,
      }),
    );
    sideSrv.close();
    const dim = execFileSync("identify", ["-format", "%wx%h", join(OUT_DIR, `side-${name}.png`)], {
      encoding: "utf8",
    }).trim();
    check(`side-${name} ${dim}`, dim === "804x844");
  }

  const ws = new NodeWebSocket(`ws://127.0.0.1:${pairing.port}/ws`, {
    headers: { origin: `http://127.0.0.1:${pairing.port}` },
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "auth", token: pairing.token }));
  const cards = await new Promise((resolve) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "cards") resolve(m);
    });
  });
  check("mock Planos", cards.cards.some((c) => /Planos/.test(c.label)));
  check("4 running", cards.cards.filter((c) => c.status === "running").length >= 4);
  ws.close();

  server.close();
  protoSrv.close();
  rmSync(userDataDir, { recursive: true, force: true });

  const failed = checks.filter((c) => !c).length;
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed.");
  console.log("screenshots →", OUT_DIR);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

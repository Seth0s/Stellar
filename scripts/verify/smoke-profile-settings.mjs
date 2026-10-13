// Settings › Perfis against the approved prototype (Configuracoes.dc.html #perfis,
// #perfis-editando, #perfis-erro), with SYNTHETIC profiles and a fake backend only.
//   1. behaviour: the profile menu's "Gerenciar perfis e contas" opens Settings on Perfis,
//      renaming works (and shows in the selector), a repeated name is refused, the account's
//      profiles have their own Renomear (see smoke-profile-account-rename.mjs), Esc leaves the edit without closing the modal;
//   2. parity: getComputedStyle of every element of the spec table, app × prototype;
//   3. prints side by side in /tmp/perfil-nome/.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, ensureLocalScope, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const FONT_ROOT = fileURLToPath(new URL("../../node_modules/@fontsource", import.meta.url));
const PROTO = fileURLToPath(new URL("../../docs/design/app-v3/prototipo/Configuracoes.dc.html", import.meta.url));
const OUT = "/tmp/perfil-nome";
mkdirSync(OUT, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Synthetic ids and names only.
const P_PERSONAL = "11111111-1111-4111-8111-111111111111";
const P_TEAM = "22222222-2222-4222-8222-222222222222";
const ACC = "33333333-3333-4333-8333-333333333333";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SRV_PERSONAL = "44444444-4444-4444-8444-444444444444";
const SRV_TEAM = "55555555-5555-4555-8555-555555555555";

function startFakeBackend(port) {
  const team = { id: TEAM, name: "Idy Platform", slug: "idy", created_by: ACC, created_at: "2026-10-05T00:00:00Z" };
  const plan = {
    account_plan: "pro",
    account_expires_at: null,
    rights: {
      sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
      team: { granted: true, state: "active", plan: "team", source: "account", team_id: TEAM, expires_at: null },
    },
  };
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (path === "/v1/auth/token" && req.method === "POST") {
        return send(200, { access_token: "a:owner", refresh_token: "owner-refresh", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();
      if (path === "/v1/me" && req.method === "GET") {
        return send(200, {
          account: { id: ACC, display_name: "Ana Exemplo", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ kind: "email", subject: "ana@example.com", login: "ana@example.com" }],
          profiles: [
            { id: SRV_PERSONAL, account_id: ACC, kind: "personal", team_id: null, name: "Pessoal" },
            { id: SRV_TEAM, account_id: ACC, kind: "team", team_id: TEAM, name: "Idy Platform" },
          ],
          teams: [team],
          plan,
        });
      }
      if (path.startsWith("/v1/profiles") && req.method === "GET") return send(200, { profiles: [] });
      if (path === "/v1/devices" && req.method === "GET") return send(200, { devices: [] });
      return send(404, { error: { code: "not_found", message: path } });
    });
  });
  return {
    listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function seed(dir) {
  mkdirSync(join(dir, "profiles", P_PERSONAL), { recursive: true });
  mkdirSync(join(dir, "profiles", P_TEAM), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultProfileId: P_PERSONAL,
      profiles: [
        { id: P_PERSONAL, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "system" },
        { id: P_TEAM, name: "Idy Platform", kind: "team", createdAt: 2, homeMode: "isolated", team: { id: TEAM, slug: "idy", name: "Idy Platform" } },
      ],
    }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(
    join(dir, "profiles", P_PERSONAL, "cloud-auth.json"),
    JSON.stringify({ refreshToken: { value: "owner-refresh", encrypted: false }, linked: true }),
  );
}

async function waitFor(page, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* mounting */
    }
    await delay(150);
  }
  return false;
}

async function shot(page, name) {
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  const abs = join(OUT, `${name}.png`);
  writeFileSync(abs, Buffer.from(res.data, "base64"));
  return abs;
}

function sideBySide(left, right, out) {
  const r = spawnSync("convert", [left, right, "+append", out]);
  return r.status === 0 && existsSync(out);
}

const TEXT = ["fontSize", "fontWeight", "color"];
const BTN = ["@width", "@height", "paddingLeft", "gap", "fontSize", "backgroundColor", "color", "borderTopColor", "borderTopLeftRadius"];
// [name, selector in the prototype, selector in the app (same when null), props]
const SPEC = {
  view: [
    ["nav item (current)", "button.navOn", '[data-settings-page="profiles"]', ["@width", "@height", "backgroundColor", "color", "fontSize", "paddingLeft", "borderTopLeftRadius"]],
    ["nav badge 'novo'", "button.navOn .new", '[data-settings-page="profiles"] > span', ["fontSize", "backgroundColor", "color", "paddingLeft", "borderTopLeftRadius"]],
    ["page title", "main h2", '[data-settings-modal] h2', TEXT],
    ["machine section", '[data-part="profiles-machine"]', null, ["@width", "paddingTop", "paddingLeft", "gap", "borderTopColor", "borderTopLeftRadius", "backgroundColor"]],
    ["section heading", '[data-part="profiles-machine"] .sh', '[data-part="profiles-machine"] > h3', [...TEXT, "letterSpacing", "textTransform"]],
    ["profile row", '[data-part="profile-row"]', null, ["@width", "@height", "gap", "paddingTop"]],
    ["profile avatar (personal)", '[data-part="profile-row"][data-profile="personal"] > span:first-child', null, ["@width", "@height", "borderTopLeftRadius", "backgroundColor", "color", "fontWeight"]],
    ["profile avatar (team)", '[data-part="profile-row"][data-profile="team"] > span:first-child', null, ["@width", "@height", "borderTopLeftRadius", "backgroundColor", "color"]],
    ["profile name", '[data-part="profile-name"]', null, ["fontSize", "color"]],
    ["profile hint", '[data-part="profile-row"] > div > span:last-child', null, ["fontSize", "color"]],
    ["'ativo' pill", '[data-part="profile-row"] > div > span:first-child > span:last-child', null, ["fontSize", "paddingLeft", "borderTopLeftRadius", "backgroundColor", "color"]],
    ["rename button", '[data-part="rename-btn"]', null, BTN],
    ["machine note", '[data-part="profiles-machine"] > span:last-child', null, ["fontSize", "color"]],
    ["account section", '[data-part="profiles-account"]', null, ["@width", "@height", "paddingTop", "gap", "borderTopColor", "borderTopLeftRadius"]],
    ["account row", '[data-part="account-profile-row"]', null, ["@height", "gap"]],
    ["account note", '[data-part="account-name-note"]', null, ["fontSize", "color"]],
  ],
  edit: [
    ["edit row", '[data-part="profile-row"][data-editing]', null, ["@width", "@height", "gap"]],
    ["name field", '[data-part="rename-input"]', null, ["@height", "paddingLeft", "fontSize", "color", "backgroundColor", "borderTopColor", "borderTopLeftRadius"]],
    ["Salvar", '[data-part="rename-save"]', null, ["@height", "paddingLeft", "fontSize", "fontWeight", "backgroundColor", "color", "borderTopColor", "borderTopLeftRadius"]],
    ["Cancelar", '[data-part="rename-cancel"]', null, ["@height", "paddingLeft", "fontSize", "backgroundColor", "color", "borderTopColor", "borderTopLeftRadius"]],
    ["'só o nome muda'", '[data-part="profile-row"][data-editing] > div > span:last-child', null, ["fontSize", "color"]],
  ],
  erro: [
    ["name field (error)", '[data-part="rename-input"]', null, ["@height", "borderTopColor", "borderTopLeftRadius"]],
    ["error text", '[data-part="rename-error"]', null, ["fontSize", "color"]],
  ],
};

const MEASURE = (pairs, side) => `(() => {
  const props = ${JSON.stringify(pairs)};
  const out = [];
  for (const [name, protoSel, appSel, list] of props) {
    const sel = ${JSON.stringify(side)} === "proto" ? protoSel : (appSel ?? protoSel);
    const el = document.querySelector(sel);
    if (!el) { out.push({ name, missing: sel }); continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vals = {};
    for (const p of list) {
      if (p === "@width") vals[p] = Math.round(r.width * 10) / 10;
      else if (p === "@height") vals[p] = Math.round(r.height * 10) / 10;
      else vals[p] = cs[p];
    }
    out.push({ name, vals });
  }
  return JSON.stringify(out);
})()`;

function pairsOf(stage) {
  return SPEC[stage].map(([name, p, a, props]) => [name, p, a, props]);
}

const apiPort = await pickFreePort();
const api = startFakeBackend(apiPort);
await api.listen();
const userData = mkdtempSync(join(tmpdir(), "stellar-profile-settings-"));
seed(userData);
const cdpPort = await pickFreePort();
const app = await startApp({
  cdpPort,
  userDataDir: userData,
  preserveUserData: true,
  isolatedHome: true,
  extraEnv: { STELLARCLOUD_AUTH_BROWSER: "log", STELLARCLOUD_API_URL: `http://127.0.0.1:${apiPort}` },
});
const shots = [];
const measured = { app: {}, proto: {} };
try {
  const page = await connectPage(cdpPort);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(page, `!!document.querySelector('[data-role="profile-trigger"]')`);
  await delay(1500);

  // ---- the entry: the profile menu's "Gerenciar perfis e contas" -------------
  await page.evalJs(`document.querySelector('[data-role="profile-trigger"]')?.click()`);
  await delay(300);
  await page.evalJs(`document.querySelector('[data-role="manage-accounts"]')?.click()`);
  check("'Gerenciar perfis e contas' opens Settings", await waitFor(page, `!!document.querySelector('[data-settings-modal]')`, 6000), true);
  check("…already on the Perfis page", await page.evalJs(`document.querySelector('[data-settings-pane]')?.getAttribute('data-settings-pane')`), "profiles");
  check("the nav marks Perfis as the current page", await page.evalJs(`document.querySelector('[data-settings-page="profiles"]')?.getAttribute('aria-current')`), "page");
  await waitFor(page, `document.querySelectorAll('[data-part="account-profile-row"]').length >= 2`, 8000);

  // ---- behaviour -----------------------------------------------------------
  const names = await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-part="profiles-machine"] [data-part="profile-name"]')].map((n) => n.textContent))`);
  check("the machine's profiles are listed (Pessoal, Idy Platform)", JSON.parse(names), (v) => v.join("|") === "Pessoal|Idy Platform");
  check("the account's profiles are listed", await page.evalJs(`document.querySelectorAll('[data-part="account-profile-row"]').length`), 2);
  check("the account's profiles can be renamed too (button on each; the backend decides who)", await page.evalJs(`document.querySelectorAll('[data-part="profiles-account"] [data-part="rename-btn"]').length`), 2);
  shots.push(["perfis", await shot(page, "app-perfis")]);
  measured.app.view = JSON.parse(await page.evalJs(MEASURE(pairsOf("view"), "app")));

  // Esc leaves the edit, not the modal.
  await page.evalJs(`document.querySelector('[data-part="profiles-machine"] [data-part="rename-btn"]')?.click()`);
  await delay(250);
  check("'Renomear' opens the field with the current name, focused", await page.evalJs(`(() => { const i = document.querySelector('[data-part="rename-input"]'); return !!i && i.value === "Pessoal" && document.activeElement === i; })()`), true);
  shots.push(["perfis-editando", await shot(page, "app-perfis-editando")]);
  measured.app.edit = JSON.parse(await page.evalJs(MEASURE(pairsOf("edit"), "app")));
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(250);
  check("Esc cancels the edit and the modal stays open", await page.evalJs(`!document.querySelector('[data-part="rename-input"]') && !!document.querySelector('[data-settings-modal]')`), true);

  // A repeated name is refused, with the reason under the field.
  await page.evalJs(`document.querySelector('[data-part="profiles-machine"] [data-part="rename-btn"]')?.click()`);
  await delay(250);
  const typeInto = (value) => `(() => { const i = document.querySelector('[data-part="rename-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; if (!i) return; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`;
  await page.evalJs(typeInto("Idy Platform"));
  await page.evalJs(`document.querySelector('[data-part="rename-save"]')?.click()`);
  await delay(500);
  check("a repeated name is refused with the reason", await page.evalJs(`document.querySelector('[data-part="rename-error"]')?.textContent`), "Já existe um perfil com esse nome nesta máquina.");
  check("…and the row stays in edit", await page.evalJs(`!!document.querySelector('[data-part="rename-input"]')`), true);
  shots.push(["perfis-erro", await shot(page, "app-perfis-erro")]);
  measured.app.erro = JSON.parse(await page.evalJs(MEASURE(pairsOf("erro"), "app")));

  // A valid rename: saved in profiles.json, shown in the page and in the selector.
  await page.evalJs(typeInto("Ana"));
  await page.evalJs(`document.querySelector('[data-part="rename-save"]')?.click()`);
  await delay(600);
  check("a valid name is saved and the page shows it", await page.evalJs(`document.querySelector('[data-part="profiles-machine"] [data-part="profile-name"]')?.textContent`), "Ana");
  const saved = JSON.parse(await page.evalJs(`window.profiles.list().then((s) => JSON.stringify(s.profiles.map((p) => p.name)))`));
  check("the registry has the new name", saved.join("|"), "Ana|Idy Platform");
  await page.evalJs(`document.querySelector('[data-settings-close]')?.click()`);
  await delay(300);
  // The selector lists the machine's profiles in its menu and names the open one in its trigger
  // (when the person is in the machine's scope).
  await page.evalJs(`document.querySelector('[data-role="profile-trigger"]')?.click()`);
  await delay(300);
  const menuNames = JSON.parse(await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="profile-row"]')].map((r) => r.querySelector("span:nth-child(2) > span")?.textContent))`));
  check("the profile menu lists the new name right away", menuNames.join("|"), "Ana|Idy Platform");
  await page.evalJs(`document.querySelector('[data-role="profile-trigger"]')?.click()`);
  await delay(200);
  await ensureLocalScope(page);
  await delay(400);
  check("the selector's trigger shows the new name (machine scope)", await page.evalJs(`document.querySelector('[data-role="profile-name"]')?.textContent`), "Ana");

  // ---- the prototype, same window, same size --------------------------------
  // Rename back first so both sides carry the mock's names.
  await page.evalJs(`window.profiles.rename(${JSON.stringify(P_PERSONAL)}, "Pessoal")`);
  for (const [stage, hash] of [["view", "perfis"], ["edit", "perfis-editando"], ["erro", "perfis-erro"]]) {
    await page.send("Page.navigate", { url: `file://${PROTO}?s=${stage}#${hash}` });
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      ready = await page.evalJs(`document.documentElement.getAttribute('data-dc-ready') === '1'`).catch(() => false);
      if (!ready) await delay(150);
    }
    // The prototype pulls its fonts from Google Fonts; offline it falls back to a face with other
    // metrics. Point the same family names at the files the app ships, so widths are comparable.
    await page.evalJs(`(async () => {
      const dir = (pkg) => ${JSON.stringify(FONT_ROOT)} + "/" + pkg + "/files";
      const face = (family, pkg, weight) => "@font-face{font-family:'" + family + "';font-weight:" + weight + ";src:url('file://" + dir(pkg) + "/" + pkg + "-latin-" + weight + "-normal.woff2') format('woff2');}";
      const css = [400, 500, 600, 700].map((w) => face("Space Grotesk", "space-grotesk", w)).join("") + [400, 500].map((w) => face("JetBrains Mono", "jetbrains-mono", w)).join("");
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
      await Promise.all([400, 500, 600, 700].map((w) => document.fonts.load(w + " 13px 'Space Grotesk'")));
      await document.fonts.ready;
      return true;
    })()`);
    await delay(500);
    shots.push([`proto-${hash}`, await shot(page, `proto-${hash}`)]);
    measured.proto[stage] = JSON.parse(await page.evalJs(MEASURE(pairsOf(stage), "proto")));
  }
  page.close();
} finally {
  await stopApp(app);
  await api.close();
  rmSync(userData, { recursive: true, force: true });
}

// ---- parity table -------------------------------------------------------------
const lines = ["| estado | elemento | propriedade | protótipo | app |", "|---|---|---|---|---|"];
let divergent = 0;
for (const stage of Object.keys(SPEC)) {
  const a = measured.app[stage] ?? [];
  const p = measured.proto[stage] ?? [];
  for (let i = 0; i < SPEC[stage].length; i++) {
    const name = SPEC[stage][i][0];
    if (!a[i] || !p[i] || a[i].missing || p[i].missing) {
      divergent++;
      lines.push(`| ${stage} | ${name} | (elemento) | ${p[i]?.missing ?? "ok"} | ${a[i]?.missing ?? "ok"} |`);
      console.log(`FAIL — ${stage} · ${name}: missing (proto ${p[i]?.missing ?? "ok"}, app ${a[i]?.missing ?? "ok"})`);
      continue;
    }
    const diffs = [];
    for (const prop of Object.keys(p[i].vals)) {
      const same = p[i].vals[prop] === a[i].vals[prop];
      lines.push(`| ${stage} | ${name} | ${prop} | ${p[i].vals[prop]} | ${a[i].vals[prop]}${same ? "" : " ✗"} |`);
      if (!same) diffs.push(`${prop}: proto ${p[i].vals[prop]} ≠ app ${a[i].vals[prop]}`);
    }
    if (diffs.length) divergent += diffs.length;
    check(`parity · ${stage} · ${name} (${Object.keys(p[i].vals).length} props)`, diffs.join("; "), "");
  }
}
writeFileSync(join(OUT, "parity-table.md"), lines.join("\n") + "\n");
for (const stage of ["perfis", "perfis-editando", "perfis-erro"]) {
  const left = shots.find(([n]) => n === `proto-${stage}`)?.[1];
  const right = shots.find(([n]) => n === stage)?.[1];
  if (left && right) console.log(`side-by-side: ${sideBySide(left, right, join(OUT, `side-by-side-${stage}.png`)) ? join(OUT, `side-by-side-${stage}.png`) : "convert failed"}`);
}
console.log(`parity table: ${join(OUT, "parity-table.md")} — divergent values: ${divergent}`);
finish();

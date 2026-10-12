// Time — LOAD, async with skeleton. ONE isolated instance against a LOCAL fake
// backend that answers SLOWLY (per-route delays), to measure with numbers:
//
//  1. what blocks: the longest long task / frame gap on the renderer while the
//     page loads, the round trip of an IPC ping to the main process while the
//     slow `team:overview` is still pending (main must stay free), and WHEN the
//     page paints (head + skeleton) and WHEN each section fills;
//  2. that the UI answers while loading: Ctrl+K palette, sub-navigation click
//     and a real wheel scroll while the backend has not answered yet;
//  3. per-section failure: a stale cache is marked with its last-update stamp
//     (offline), and a section with no cache shows its own error + retry.
//
// It NEVER touches the owner's instance or the real CLI houses. Optional
// `--out=/path/file.json` writes the measurements as JSON and `--shots=/dir` writes
// screenshots (both also read from TEAM_LOAD_OUT / TEAM_LOAD_SHOTS; a gate lock may
// drop the environment, an argument always arrives).
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPage, ensureTeamProfile, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT_FILE = arg("out") ?? process.env.TEAM_LOAD_OUT;
const SHOTS_DIR = arg("shots") ?? process.env.TEAM_LOAD_SHOTS;

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER_P = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";
const MEMBER_ACC = "44444444-4444-4444-8444-444444444444";

/** Per-route answer delay (ms) of the slow phase. The sum of the three pre-task
 *  calls is deliberately larger than the task call so a waterfall is visible. */
const SLOW = { me: 1200, detail: 2200, sprints: 1800, invites: 2600, tasks: 3600 };

function task(n, state, assignee, extra = {}) {
  return {
    id: randomUUID(),
    team_id: TEAM_ID,
    short_id: n,
    ref: `#${n}`,
    title: `Task ${n}`,
    kind: "implementar",
    priority: "media",
    state,
    sprint_id: null,
    assignee_id: assignee,
    session_label: "",
    reviewer_id: OWNER_ACC,
    provider: "claude",
    territory: [],
    gates: [],
    allow_commit: false,
    report_schema: [],
    max_retries: 2,
    auto_dispatch: false,
    origin_kind: "manual",
    origin_external_id: null,
    created_by: OWNER_ACC,
    accepted_at: null,
    started_at: null,
    report_delivered_at: null,
    gates_passed: null,
    gates_total: null,
    review_verdict: null,
    version: 1,
    archived_at: null,
    created_at: "2026-10-05T00:00:00Z",
    updated_at: new Date(Date.now() - n * 600000).toISOString(),
    ...extra,
  };
}

function startFakeBackend(port) {
  const members = [
    { team_id: TEAM_ID, account_id: OWNER_ACC, role: "owner", joined_at: null, display_name: "Ana Ribeiro", avatar_initials: "AR", email: "ana@example.com" },
    { team_id: TEAM_ID, account_id: MEMBER_ACC, role: "member", joined_at: null, display_name: "Bruno Melo", avatar_initials: "BM", email: null },
  ];
  const team = { id: TEAM_ID, name: "Idy Platform", slug: "idy", created_by: OWNER_ACC, created_at: "2026-10-05T00:00:00Z", share_file_paths: true };
  const tasks = [
    task(1, "sem_dono", null),
    task(2, "sem_dono", null),
    task(3, "atribuida", MEMBER_ACC),
    task(4, "rodando", OWNER_ACC),
    task(5, "aguardando_revisao", MEMBER_ACC, { gates_passed: 2, gates_total: 2 }),
    task(6, "concluida", OWNER_ACC),
  ];
  const delays = { me: 0, detail: 0, sprints: 0, invites: 0, tasks: 0 };
  /** Routes that answer 500 right now. */
  const failing = new Set();
  const hits = [];
  const sockets = new Set();

  const server = createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (path === "/v1/auth/token" && req.method === "POST") return send(200, { access_token: "a:owner", refresh_token: "owner-refresh", expires_in: 900, refresh_expires_in: 2592000 });
      if (path === "/v1/auth/logout") return res.writeHead(204).end();
      if (!String(req.headers.authorization ?? "").startsWith("Bearer a:")) return send(401, { error: { code: "unauthorized", message: "missing bearer" } });

      const route =
        path === "/v1/me" ? "me"
        : path === `/v1/teams/${TEAM_ID}` ? "detail"
        : path === `/v1/teams/${TEAM_ID}/sprints` ? "sprints"
        : path === `/v1/teams/${TEAM_ID}/invites` ? "invites"
        : path === `/v1/teams/${TEAM_ID}/tasks` ? "tasks"
        : null;
      if (route === null && path === "/v1/teams" && req.method === "POST") return send(201, team);
      if (route === null) return send(404, { error: { code: "not_found", message: path } });
      hits.push({ route, at: Date.now() });
      if (delays[route] > 0) await delay(delays[route]);
      if (failing.has(route)) return send(500, { error: { code: "internal", message: `falha em ${route}` } });
      if (route === "me") {
        return send(200, {
          account: { id: OWNER_ACC, display_name: "Ana Ribeiro", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ id: OWNER_ACC, account_id: OWNER_ACC, kind: "email", subject: "owner@example.com", verified_at: null, created_at: null, login: null }],
          profiles: [{ id: OWNER_P, account_id: OWNER_ACC, kind: "personal", team_id: null, name: "Pessoal", created_at: null }],
          teams: [team],
          plan: {
            account_plan: "team",
            account_expires_at: null,
            rights: {
              sync: { granted: true, state: "active", plan: "pro", source: "account", team_id: null, expires_at: null },
              team: { granted: true, state: "active", plan: "team", source: "account", team_id: TEAM_ID, expires_at: null },
            },
          },
        });
      }
      if (route === "detail") return send(200, { team, members });
      if (route === "sprints") return send(200, { sprints: [{ id: randomUUID(), team_id: TEAM_ID, name: "Sprint 14", goal: "", state: "ativa", starts_at: null, ends_at: null, created_by: OWNER_ACC, created_at: null, updated_at: null }] });
      if (route === "invites") return send(200, { invites: [{ id: randomUUID(), team_id: TEAM_ID, target: "invitee@example.com", role: "member" }] });
      return send(200, { tasks, total: tasks.length, limit: 50, offset: 0 });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return {
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve())),
    /** Real "offline": the port stops answering and open connections die. */
    stop: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
    setDelays: (next) => Object.assign(delays, { me: 0, detail: 0, sprints: 0, invites: 0, tasks: 0 }, next),
    fail: (...routes) => { failing.clear(); for (const r of routes) failing.add(r); },
    hits: () => hits.length,
    /** When each route was REQUESTED, ms after `since` (a Date.now() mark): serial vs parallel. */
    hitLog: (since) => hits.filter((h) => h.at >= since).map((h) => `${h.route}@${h.at - since}`),
  };
}

function seedUserData(dir) {
  mkdirSync(join(dir, "profiles", OWNER_P), { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({ schemaVersion: 1, defaultProfileId: OWNER_P, profiles: [{ id: OWNER_P, name: "Pessoal", kind: "personal", createdAt: 1, homeMode: "isolated" }] }));
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", OWNER_P, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: "owner-refresh", encrypted: false }, linked: true }));
}

async function waitFor(page, expr, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* not ready */
    }
    await delay(60);
  }
  return false;
}
const evalJson = async (page, expr) => JSON.parse(await page.evalJs(`(async () => JSON.stringify(await (${expr})))()`));

/** In-page recorder: long tasks, frame gaps, and the first time each selector shows. */
const RECORDER = `
(() => {
  const SEL = {
    head: '[data-part="team-head"]',
    skeleton: '[data-part="team-skeleton"]',
    seats: '[data-part="seats-pill"]',
    member: '[data-part="member-row"]',
    pending: '[data-part="pending-row"]',
    board: '[data-part="team-board"]',
    taskCard: '[data-task-id]',
    avatar: '[data-part="team-board"] button[aria-pressed][title]',
    palette: '[data-part="team-cmd-palette"]',
    stale: '[data-part="team-section-notice"][data-state="stale"]',
    error: '[data-part="team-section-notice"][data-state="error"]',
  };
  const rec = { t0: performance.now(), seen: {}, long: [], maxGap: 0, maxTimerGap: 0, hidden: 0 };
  window.__tl = rec;
  const scan = () => {
    for (const [k, s] of Object.entries(SEL)) {
      if (rec.seen[k] === undefined && document.querySelector(s)) rec.seen[k] = Math.round(performance.now() - rec.t0);
    }
  };
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
  } catch {}
  let last = performance.now();
  const tick = (now) => { rec.maxGap = Math.max(rec.maxGap, Math.round(now - last)); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let lastTimer = performance.now();
  setInterval(() => { const n = performance.now(); rec.maxTimerGap = Math.max(rec.maxTimerGap, Math.round(n - lastTimer - 50)); lastTimer = n; if (document.visibilityState !== 'visible') rec.hidden++; }, 50);
  scan();
  return true;
})()`;

/** Rects of the pieces whose position the skeleton must keep (read in-page, in px). */
const GEOMETRY = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), height: Math.round(b.height), left: Math.round(b.left), width: Math.round(b.width) }; };
  const q = (s, root = document) => root.querySelector(s);
  return {
    head: r(q('[data-part="team-head"]')),
    stats: r(q('[data-part="team-stats"]')),
    stat: r(q('[data-part="stat-open"]')),
    membersCard: r(q('[data-part="members-card"]')),
    memberRow: r(q('[data-part="members-table"] tbody tr')),
    columns: r(q('[data-column="sem_dono"]')),
    columnHead: r(q('[data-column="sem_dono"] > div')),
    taskCard: r(q('[data-column="sem_dono"] [data-part="team-skeleton"], [data-column="sem_dono"] [data-task-id]')),
    boardBar: r(q('[data-part="team-board"] > div')),
  };
})()`;

/** In-page: resolves with the ms until `sel` is in the DOM (0 if already there), or null after `limit` ms. Timer-based: rAF is throttled under xvfb. */
const WAIT_SEL = (sel, limit) => `new Promise((resolve) => {
  const a = performance.now();
  const hit = () => document.querySelector(${JSON.stringify(sel)});
  if (hit()) return resolve(0);
  const iv = setInterval(() => { if (hit()) { clearInterval(iv); resolve(Math.round(performance.now() - a)); } else if (performance.now() - a > ${limit}) { clearInterval(iv); resolve(null); } }, 5);
})`;

/** Screenshots go to --shots (outside the repo, which is public) when set. */
async function shot(page, name) {
  const dir = SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const res = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(res.data, "base64"));
}

const ownerUserData = mkdtempSync(join(tmpdir(), "stellar-team-load-"));
let backend;
let app;
const measurements = {};
try {
  const apiPort = await pickFreePort();
  backend = startFakeBackend(apiPort);
  await backend.listen();
  seedUserData(ownerUserData);
  const cdp = await pickFreePort();
  app = await startApp({
    cdpPort: cdp,
    userDataDir: ownerUserData,
    preserveUserData: true,
    isolatedHome: true,
    // The window shares the desktop with other windows: a covered window would be throttled
    // (rAF paused for tens of seconds) and the timings would measure the compositor, not the page.
    extraArgs: ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion"],
    extraEnv: { STELLARCLOUD_API_URL: `http://127.0.0.1:${apiPort}`, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const page = await connectPage(cdp);
  await page.send("Page.enable");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Small viewport: the overview overflows, so a wheel scroll is observable.
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 520, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 60; i++) {
    if ((await evalJson(page, `await window.cloud.status()`)).state === "logged-in") break;
    await delay(250);
  }
  const created = await evalJson(page, `await window.team.create({ name: "Idy Platform" })`);
  check("o time existe no backend falso", created.ok, true);
  await ensureTeamProfile(page);

  const toOtherSection = async () => {
    await page.evalJs(`[...document.querySelectorAll('[data-section]')].find((el) => el.getAttribute('data-section') !== 'team')?.click()`);
    await delay(250);
  };
  const clearTeamCache = () => page.evalJs(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('stellar.team.')) localStorage.removeItem(k); return true; })()`);

  // ---- 1. SLOW COLD LOAD ----------------------------------------------------
  await toOtherSection();
  await clearTeamCache();
  backend.setDelays(SLOW);
  await page.evalJs(RECORDER);
  const coldSince = Date.now();
  await page.evalJs(`window.__tl.t0 = performance.now(); document.querySelector('[data-section="team"]').click(); true`);

  // main-process ping while the slow overview is pending: main must be free.
  await delay(300);
  const ping = await evalJson(page, `(async () => { const a = performance.now(); await window.cloud.status(); return Math.round(performance.now() - a); })()`);
  measurements.mainPingMs = ping;
  check("main responde ao IPC enquanto o overview lento está pendente (<150 ms)", ping, (v) => v < 150);

  // Ctrl+K while NOTHING from the backend has arrived yet.
  const palette = await evalJson(
    page,
    `(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      const ms = await ${WAIT_SEL('[data-part="team-cmd-palette"]', 1000)};
      return { shown: ms !== null, ms, pendingOverview: window.__tl.seen.member === undefined };
    })()`,
  );
  measurements.paletteWhileLoading = palette;
  check("Ctrl+K abre a paleta enquanto o backend não respondeu", palette.shown && palette.pendingOverview, true);
  await page.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

  // The page must have painted (head + skeleton) long before the first answer.
  await delay(200);
  const geomOverviewLoading = await evalJson(page, GEOMETRY);
  await shot(page, "1-visao-geral-carregando");
  const early = await evalJson(page, `window.__tl.seen`);
  measurements.paintedAtMs = { head: early.head ?? null, skeleton: early.skeleton ?? null };
  check("a página pinta o cabeçalho antes da 1ª resposta (<400 ms)", early.head !== undefined && early.head < 400, true);
  check("a página pinta o skeleton antes da 1ª resposta (<400 ms)", early.skeleton !== undefined && early.skeleton < 400, true);

  // Real wheel scroll while loading.
  const scroller = await evalJson(
    page,
    `(() => {
      let el = document.querySelector('[data-part="team-page"]') || document.querySelector('[data-part="team-skeleton"]');
      while (el && el !== document.body) {
        const o = getComputedStyle(el).overflowY;
        if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, over: el.scrollHeight - el.clientHeight }; }
        el = el.parentElement;
      }
      return null;
    })()`,
  );
  if (scroller) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scroller.x, y: scroller.y, deltaX: 0, deltaY: 120 });
    await delay(300);
    const moved = await page.evalJs(
      `(() => { let el = document.querySelector('[data-part="team-page"]') || document.querySelector('[data-part="team-skeleton"]'); while (el && el !== document.body) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el.scrollTop; el = el.parentElement; } return 0; })()`,
    );
    measurements.scrollMovedPx = moved;
    check("a roda do mouse rola a página durante o carregamento", moved > 0, true);
    await page.evalJs(`(() => { let el = document.querySelector('[data-part="team-page"]') || document.querySelector('[data-part="team-skeleton"]'); while (el && el !== document.body) { const o = getComputedStyle(el).overflowY; if (o === 'auto' || o === 'scroll') el.scrollTop = 0; el = el.parentElement; } return true; })()`);
  } else {
    measurements.scrollMovedPx = "sem overflow";
    check("a página (ou o skeleton) tem conteúdo para rolar no viewport pequeno", false, true);
  }

  // Sub-navigation click as soon as it exists, while detail/tasks are pending.
  const gotSubnav = await waitFor(page, `!!document.querySelector('[data-team-sub="board"]')`, 6000);
  check("a navegação do time aparece quando o overview chega", gotSubnav, true);
  const board = await evalJson(
    page,
    `(async () => {
      document.querySelector('[data-team-sub="board"]')?.click();
      const ms = await ${WAIT_SEL('[data-part="team-board"]', 1000)};
      return { boardShown: ms !== null, ms, tasksPending: !document.querySelector('[data-task-id]') };
    })()`,
  );
  measurements.boardClick = board;
  check("o clique em Board responde na hora, com as tasks ainda pendentes", board.boardShown && board.tasksPending && board.ms < 250, true);
  const geomBoardLoading = await evalJson(page, GEOMETRY);
  await shot(page, "2-board-carregando");
  const skeletonOnBoard = await page.evalJs(`!!document.querySelector('[data-part="team-skeleton"][data-section="tasks"]')`);
  check("o board mostra skeleton nas colunas enquanto as tasks não chegam", skeletonOnBoard, true);

  // Wait for everything, then read the recorder.
  const filled = await waitFor(page, `!!document.querySelector('[data-task-id]')`, 12000);
  check("as tasks preenchem o board quando chegam", filled, true);
  await delay(150);
  const geomBoardReady = await evalJson(page, GEOMETRY);
  await shot(page, "3-board-pronto");
  await page.evalJs(`document.querySelector('[data-team-sub="overview"]')?.click(); true`);
  await waitFor(page, `!!document.querySelector('[data-part="pending-row"]')`, 8000);
  await delay(300);
  const geomOverviewReady = await evalJson(page, GEOMETRY);
  await shot(page, "4-visao-geral-pronta");
  const rec = await evalJson(page, `window.__tl`);
  measurements.cold = { requestedAtMs: backend.hitLog(coldSince), seen: rec.seen, longTasksMs: rec.long, maxFrameGapMs: rec.maxGap, maxTimerGapMs: rec.maxTimerGap, hiddenTicks: rec.hidden, delays: SLOW };
  const longMax = rec.long.length ? Math.max(...rec.long) : 0;
  measurements.cold.longTaskMaxMs = longMax;
  check("nenhuma long task >100 ms durante o carregamento lento", longMax, (v) => v <= 100);
  // A frozen JS thread stalls timers; rAF gaps alone also move with the compositor (xvfb), so they are only reported.
  check("nenhum atraso de timer >100 ms durante o carregamento lento (thread de JS livre)", rec.maxTimerGap, (v) => v <= 100);
  // No waterfall: the tasks must land close to (me + tasks), not (me + slowest pre-call + tasks).
  const tasksAt = rec.seen.taskCard ?? null;
  const noWaterfallLimit = SLOW.me + SLOW.tasks + 900;
  check(`as tasks não esperam as outras chamadas (chegam em <${noWaterfallLimit} ms)`, tasksAt, (v) => v !== null && v < noWaterfallLimit);
  // Members (detail, 2200) must not wait for the slower invites call (2600): each section at its own pace.
  const membersAt = rec.seen.avatar ?? null;
  check(`os membros preenchem no ritmo da própria resposta (<${SLOW.detail + 300} ms, sem esperar os convites)`, membersAt, (v) => v !== null && v < SLOW.detail + 300);
  check("os membros preenchem antes das tasks (cada seção no seu ritmo)", membersAt !== null && tasksAt !== null && membersAt < tasksAt, true);

  // The skeleton keeps the final layout: same positions, same block sizes.
  const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
  measurements.geometry = { overviewLoading: geomOverviewLoading, overviewReady: geomOverviewReady, boardLoading: geomBoardLoading, boardReady: geomBoardReady };
  check("skeleton da visão geral: o cabeçalho tem a mesma altura que o final", near(geomOverviewLoading.head?.height ?? null, geomOverviewReady.head?.height ?? null, 4), true);
  check("skeleton da visão geral: a faixa de números começa no mesmo lugar", near(geomOverviewLoading.stats?.top ?? null, geomOverviewReady.stats?.top ?? null, 4), true);
  check("skeleton da visão geral: cada número tem a mesma altura (±2 px)", near(geomOverviewLoading.stat?.height ?? null, geomOverviewReady.stat?.height ?? null, 2), true);
  check("skeleton da visão geral: o cartão de membros começa no mesmo lugar", near(geomOverviewLoading.membersCard?.top ?? null, geomOverviewReady.membersCard?.top ?? null, 4), true);
  check("skeleton da visão geral: a linha de membro tem a altura da real (±6 px)", near(geomOverviewLoading.memberRow?.height ?? null, geomOverviewReady.memberRow?.height ?? null, 6), true);
  check("skeleton do board: as colunas começam no mesmo lugar", near(geomBoardLoading.columns?.top ?? null, geomBoardReady.columns?.top ?? null, 4), true);
  check("skeleton do board: o cabeçalho da coluna tem a mesma altura (±2 px)", near(geomBoardLoading.columnHead?.height ?? null, geomBoardReady.columnHead?.height ?? null, 2), true);
  check("skeleton do board: a barra do board tem a mesma altura (±2 px)", near(geomBoardLoading.boardBar?.height ?? null, geomBoardReady.boardBar?.height ?? null, 2), true);
  check("skeleton do board: o cartão de task tem a altura do real (±24 px, o título real pode ter 1 ou 2 linhas)", near(geomBoardLoading.taskCard?.height ?? null, geomBoardReady.taskCard?.height ?? null, 24), true);

  // ---- 2. OFFLINE with a warm cache: stale + last-update stamp --------------
  await toOtherSection();
  await backend.stop();
  await page.evalJs(RECORDER);
  await page.evalJs(`window.__tl.t0 = performance.now(); document.querySelector('[data-section="team"]').click(); true`);
  const offlineShown = await waitFor(page, `!!document.querySelector('[data-part="team-section-notice"][data-state="stale"]')`, 10000);
  check("offline: a seção aparece marcada como desatualizada", offlineShown, true);
  const stamp = await page.evalJs(`document.querySelector('[data-part="team-section-notice"][data-state="stale"]')?.textContent ?? ''`);
  measurements.staleStamp = stamp;
  check("offline: o aviso traz a hora da última atualização (dd/mm hh:mm)", /\d{2}\/\d{2}/.test(stamp) && /\d{2}:\d{2}/.test(stamp), true);
  const offlineRows = await waitFor(page, `!!document.querySelector('[data-part="member-row"]')`, 3000);
  measurements.offlineDom = await page.evalJs(`(document.querySelector('[data-part="team-page"]')?.innerText ?? 'sem team-page').slice(0, 400)`);
  check("offline: o conteúdo em cache continua visível (membros)", offlineRows, true);
  await shot(page, "5-offline-desatualizado");

  // ---- 3. ONLINE again, one failing section with NO cache: error + retry ----
  const apiPortAgain = apiPort;
  backend = startFakeBackend(apiPortAgain);
  await backend.listen();
  await toOtherSection();
  await clearTeamCache();
  backend.fail("sprints");
  await page.evalJs(`document.querySelector('[data-section="team"]').click(); true`);
  const sprintsErr = await waitFor(page, `!!document.querySelector('[data-part="team-section-notice"][data-section="sprints"][data-state="error"]')`, 10000);
  check("uma seção sem cache que falha mostra o próprio erro", sprintsErr, true);
  check("as outras seções carregaram apesar do erro (membros visíveis)", await waitFor(page, `!!document.querySelector('[data-part="member-row"]')`, 4000), true);
  await shot(page, "6-secao-com-erro");
  backend.fail();
  await page.evalJs(`document.querySelector('[data-part="team-section-retry"][data-section="sprints"]')?.click(); true`);
  check("tentar de novo recupera a seção", await waitFor(page, `!document.querySelector('[data-part="team-section-notice"][data-section="sprints"]')`, 6000), true);
} catch (err) {
  console.log(`FAIL — erro inesperado: ${err instanceof Error ? err.stack : String(err)}`);
  measurements.crash = String(err);
  process.exitCode = 1;
} finally {
  console.log(`\nMEDIDAS ${JSON.stringify(measurements)}`);
  if (OUT_FILE) writeFileSync(OUT_FILE, JSON.stringify(measurements, null, 2));
  try {
    if (app) await stopApp(app);
  } catch {
    /* already gone */
  }
  try {
    await backend?.stop();
  } catch {
    /* already closed */
  }
}
finish();

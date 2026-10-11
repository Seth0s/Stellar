// A5a — team TASKS in the app (telas 10 a 13). TWO isolated instances (owner and
// member), each with its own userData/HOME, against a LOCAL backend that speaks
// the B7 contract (task list/detail/create/assign/accept/return/report). It
// measures the LOGIC end to end through the REAL IPC: the permission matrix, the
// accept → local Fila bridge, and the state bridge back to the server — and
// writes 1440x900 screenshots of telas 10, 11 and 12.
//
// It NEVER touches the owner's instance or the real CLI houses.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootIntoFreshSession, connectPage, makeChecker, pickFreePort, spawnCard, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO_DIR = join(PROJECT_ROOT, "docs/design/app-v2/prototipo");
const OUT_DIR = join(PROJECT_ROOT, "docs/design/app-v2/comparacao");
/** A5e visual evidence stays out of the public tree (repo is public). */
const A5E_OUT = "/tmp/a5e";
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(A5E_OUT, { recursive: true });

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

const OWNER_P = "11111111-1111-4111-8111-111111111111";
const MEMBER_P = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ACC = "33333333-3333-4333-8333-333333333333";
const MEMBER_ACC = "44444444-4444-4444-8444-444444444444";
const TASK_ASSIGNED = "55555555-5555-4555-8555-555555555555";
const TASK_FREE = "77777777-7777-4777-8777-777777777777";

function taskView(overrides = {}) {
  return {
    id: TASK_ASSIGNED,
    team_id: TEAM_ID,
    short_id: 1,
    ref: "#1",
    title: "Fila de retries com backoff em 429",
    kind: "implementar",
    priority: "alta",
    state: "atribuida",
    sprint_id: null,
    assignee_id: MEMBER_ACC,
    session_label: "",
    reviewer_id: OWNER_ACC,
    provider: "commandcode",
    territory: ["src/queue/**"],
    gates: ["npm test"],
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
    updated_at: "2026-10-05T00:01:00Z",
    ...overrides,
  };
}

function startFakeBackend(port) {
  const members = [
    { team_id: TEAM_ID, account_id: OWNER_ACC, role: "owner", joined_at: null, display_name: "Ana Ribeiro", avatar_initials: "AR", email: "ana@example.com" },
    { team_id: TEAM_ID, account_id: MEMBER_ACC, role: "member", joined_at: null, display_name: "Bruno Melo", avatar_initials: "BM", email: null },
  ];
  const team = {
    id: TEAM_ID,
    name: "Idy Platform",
    slug: "idy",
    created_by: OWNER_ACC,
    created_at: "2026-10-05T00:00:00Z",
    share_file_paths: true,
  };
  let tasks = [];
  let nextShort = 1;
  const reports = [];
  const roundReports = new Map();

  function accountOf(req) {
    const m = String(req.headers.authorization ?? "").match(/^Bearer a:(.+)$/);
    return m ? m[1] : null;
  }
  const accIdOf = (who) => (who === "owner" ? OWNER_ACC : MEMBER_ACC);
  const roleOf = (who) => (who === "owner" ? "owner" : "member");

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = (() => {
        try {
          return JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          return {};
        }
      })();
      const url = req.url ?? "";
      const path = url.split("?")[0];
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      const notFound = () => send(404, { error: { code: "not_found", message: path } });
      const forbidden = () => send(403, { error: { code: "forbidden", message: "not allowed" } });

      if (path === "/v1/auth/token" && req.method === "POST") {
        const who = body.refresh_token === "member-refresh" ? "member" : "owner";
        return send(200, { access_token: `a:${who}`, refresh_token: body.refresh_token ?? "r", expires_in: 900, refresh_expires_in: 2592000 });
      }
      if (path === "/v1/auth/logout" && req.method === "POST") return res.writeHead(204).end();

      const who = accountOf(req);
      if (!who) return send(401, { error: { code: "unauthorized", message: "missing bearer" } });
      const role = roleOf(who);

      if (path === "/v1/me" && req.method === "GET") {
        const accId = accIdOf(who);
        return send(200, {
          account: { id: accId, display_name: who === "owner" ? "Ana Ribeiro" : "Bruno Melo", created_at: "2026-10-05T00:00:00Z" },
          identities: [{ id: accId, account_id: accId, kind: "email", subject: `${who}@example.com`, verified_at: null, created_at: null, login: null }],
          profiles: [{ id: who === "owner" ? OWNER_P : MEMBER_P, account_id: accId, kind: "personal", team_id: null, name: "Pessoal", created_at: null }],
          teams: [team],
          // The account holds the Team plan (the plan gate reads this block).
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
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "GET") return send(200, { team, members });
      if (path === `/v1/teams/${TEAM_ID}` && req.method === "PATCH") {
        if (role !== "owner" && role !== "admin") return forbidden();
        if (typeof body.share_file_paths === "boolean") team.share_file_paths = body.share_file_paths;
        return send(200, team);
      }
      if (path === `/v1/teams/${TEAM_ID}/invites` && req.method === "GET") {
        return send(200, { invites: [{ id: "99999999-9999-4999-8999-999999999999", team_id: TEAM_ID, target: "invitee@example.com", role: "member" }] });
      }
      if (path === "/v1/teams" && req.method === "POST") return send(201, team);
      if (path === `/v1/teams/${TEAM_ID}/sprints` && req.method === "GET") {
        return send(200, {
          sprints: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              team_id: TEAM_ID,
              name: "Sprint 14",
              goal: "",
              state: "ativa",
              starts_at: null,
              ends_at: null,
              created_by: OWNER_ACC,
              created_at: null,
              updated_at: null,
            },
          ],
        });
      }

      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "GET") {
        return send(200, { tasks, total: tasks.length, limit: 50, offset: 0 });
      }
      if (path === `/v1/teams/${TEAM_ID}/tasks` && req.method === "POST") {
        if (role !== "owner" && role !== "admin") return forbidden();
        const id = nextShort === 1 ? TASK_ASSIGNED : TASK_FREE;
        const created = taskView({
          id,
          short_id: nextShort,
          ref: `#${nextShort}`,
          title: body.title ?? "Task",
          kind: body.kind ?? "implementar",
          priority: body.priority ?? "media",
          assignee_id: body.assignee_id ?? null,
          state: body.assignee_id ? (nextShort === 1 ? "rodando" : "atribuida") : "sem_dono",
          ...(nextShort === 1
            ? { provider: "commandcode", started_at: minutesAgo(22), updated_at: minutesAgo(22) }
            : {}),
        });
        nextShort += 1;
        tasks.push(created);
        return send(201, created);
      }

      const taskPath = path.match(new RegExp(`^/v1/teams/${TEAM_ID}/tasks/([0-9a-f-]+)(/.*)?$`));
      if (taskPath) {
        const task = tasks.find((t) => t.id === taskPath[1]);
        if (!task) return notFound();
        const sub = taskPath[2] ?? "";
        if (sub === "" && req.method === "GET") {
          const depId = "66666666-6666-4666-8666-666666666666";
          return send(200, {
            task: { ...task, parent_id: task.parent_id ?? null, changes_updated_at: minutesAgo(5) },
            contract: {
              version: 2,
              markdown:
                "Objetivo. Requisições com 429 voltam para a fila com backoff exponencial (base 2 s, teto 60 s, jitter).\n\nAceite. Teste do cálculo do atraso; integração com servidor falso devolvendo 429; nada muda para 5xx.",
              author_id: OWNER_ACC,
              created_at: "2026-10-05T00:00:00Z",
            },
            versions: [],
            deps: [{ depends_on: depId, short_id: 41, title: "Backoff base", state: "concluida" }],
            dependents: [{ task_id: "99999999-9999-4999-8999-999999999991", short_id: 60, title: "Métricas", state: "atribuida" }],
            events: [
              {
                id: 1,
                task_id: task.id,
                team_id: TEAM_ID,
                kind: "reported",
                actor_id: MEMBER_ACC,
                actor_name: "Command Code",
                payload: {},
                at: minutesAgo(22),
              },
              {
                id: 2,
                task_id: task.id,
                team_id: TEAM_ID,
                kind: "accepted",
                actor_id: MEMBER_ACC,
                actor_name: "Bruno",
                payload: {},
                at: minutesAgo(25),
              },
              {
                id: 3,
                task_id: task.id,
                team_id: TEAM_ID,
                kind: "assigned",
                actor_id: OWNER_ACC,
                actor_name: "Ana",
                payload: {},
                at: minutesAgo(31),
              },
            ],
            comments: [],
            claims: [],
            changes: {
              files: [
                { path: "src/queue/retry.ts", status: "M", additions: 48, deletions: 6, in_territory: true },
                { path: "src/queue/backoff.ts", status: "A", additions: 31, deletions: 0, in_territory: true },
                { path: "tests/queue/backoff.test.ts", status: "A", additions: 64, deletions: 0, in_territory: true },
              ],
              truncated: false,
              total_files: 3,
              additions: 143,
              deletions: 6,
            },
            reports: roundReports.get(task.id) ?? [],
          });
        }
        if (sub === "" && req.method === "PATCH") {
          if (role !== "owner" && role !== "admin") return forbidden();
          Object.assign(task, body);
          return send(200, task);
        }
        if (sub === "/assign" && req.method === "POST") {
          if (role !== "owner" && role !== "admin") return forbidden();
          if (body.unassign) {
            task.assignee_id = null;
            task.state = "sem_dono";
          } else if (body.assignee_id) {
            task.assignee_id = body.assignee_id;
            task.state = "atribuida";
          }
          return send(200, task);
        }
        if (sub === "/accept" && req.method === "POST") {
          if (task.assignee_id !== accIdOf(who)) return forbidden();
          task.accepted_at = "2026-10-05T00:02:00Z";
          return send(200, task);
        }
        if (sub === "/return" && req.method === "POST") {
          if (task.assignee_id !== accIdOf(who)) return forbidden();
          task.state = "sem_dono";
          task.assignee_id = null;
          return send(200, task);
        }
        if (sub === "/claims" && req.method === "POST") return send(201, { id: "claim-1", status: "pendente" });
        if (sub === "/state" && req.method === "POST") {
          task.state = body.state ?? task.state;
          return send(200, task);
        }
        if (sub === "/report" && req.method === "POST") {
          reports.push({ who, task_id: task.id, ...body });
          if (body.state) task.state = body.state;
          if (body.report_delivered) task.report_delivered_at = "2026-10-05T00:05:00Z";
          if (body.round_summary && typeof body.round_summary === "object") {
            const list = roundReports.get(task.id) ?? [];
            list.push({
              id: randomUUID(),
              task_id: task.id,
              round: list.length + 1,
              actor_id: accIdOf(who),
              role: body.round_summary.role ?? "implementer",
              summary: {
                decisao: body.round_summary.decisao ?? "",
                evidencia: body.round_summary.evidencia ?? "",
                o_que_nao_fez: body.round_summary.o_que_nao_fez ?? "",
              },
              gates_passed: body.gates_passed ?? null,
              gates_total: body.gates_total ?? null,
              verdict: body.verdict ?? null,
              created_at: new Date().toISOString(),
            });
            roundReports.set(task.id, list);
          }
          return send(200, task);
        }
        if (sub === "/subtasks" && req.method === "POST") {
          if (role !== "owner" && role !== "admin") return forbidden();
          const items = Array.isArray(body.subtasks) ? body.subtasks : [];
          const created = items.map((item) => {
            const child = taskView({
              id: randomUUID(),
              short_id: nextShort,
              ref: `#${nextShort}`,
              title: item.title ?? "Subtask",
              kind: item.kind ?? task.kind,
              priority: item.priority ?? task.priority,
              parent_id: task.id,
              state: "sem_dono",
              assignee_id: null,
            });
            nextShort += 1;
            tasks.push(child);
            return child;
          });
          return send(201, { tasks: created });
        }
        return notFound();
      }

      return notFound();
    });
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve())),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    reports: () => reports,
    seed: (views) => tasks.push(...views),
  };
}

function seedUserData(dir, profileId, name, refresh) {
  mkdirSync(join(dir, "profiles", profileId), { recursive: true });
  writeFileSync(
    join(dir, "profiles.json"),
    JSON.stringify({ schemaVersion: 1, defaultProfileId: profileId, profiles: [{ id: profileId, name, kind: "personal", createdAt: 1, homeMode: "isolated" }] }),
  );
  writeFileSync(join(dir, "local-identity.json"), JSON.stringify({ schema_version: 1, user_id: randomUUID(), install_id: randomUUID(), created_at: 1 }));
  writeFileSync(join(dir, "profiles", profileId, "cloud-auth.json"), JSON.stringify({ refreshToken: { value: refresh, encrypted: false }, linked: true }));
}

async function waitForCloud(page) {
  for (let i = 0; i < 60; i++) {
    try {
      const status = JSON.parse(await page.evalJs(`(async () => JSON.stringify(await window.cloud.status()))()`));
      if (status.state === "logged-in") return status;
    } catch {
      /* still mounting */
    }
    await delay(250);
  }
  throw new Error("login (cloud) não completou a tempo");
}

async function waitFor(page, expr, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evalJs(expr)) return true;
    } catch {
      /* not ready */
    }
    await delay(150);
  }
  return false;
}

const evalJson = async (page, expr) => JSON.parse(await page.evalJs(`(async () => JSON.stringify(${expr}))()`));

const ownerUserData = mkdtempSync(join(tmpdir(), "stellar-team-task-owner-"));
const memberUserData = mkdtempSync(join(tmpdir(), "stellar-team-task-member-"));

let backend;
let ownerApp;
let memberApp;
try {
  const apiPort = await pickFreePort();
  backend = startFakeBackend(apiPort);
  await backend.listen();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  // ---- OWNER: create the team and its tasks, then open the panel ------------
  seedUserData(ownerUserData, OWNER_P, "Pessoal", "owner-refresh");
  const ownerCdp = await pickFreePort();
  ownerApp = await startApp({
    cdpPort: ownerCdp,
    userDataDir: ownerUserData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const ownerPage = await connectPage(ownerCdp);
  await ownerPage.send("Page.enable");
  await ownerPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const ownerStatus = await waitForCloud(ownerPage);
  check("owner entra na conta", ownerStatus.account.displayName, "Ana Ribeiro");

  const created = await evalJson(ownerPage, `await window.team.create({ name: "Idy Platform" })`);
  check("owner cria o time", created.ok && created.value.team.slug, "idy");

  const t1 = await evalJson(ownerPage, `await window.team.createTask("${TEAM_ID}", { title: "Fila de retries com backoff em 429", kind: "implementar", priority: "alta", assignee_id: "${MEMBER_ACC}", reviewer_id: "${OWNER_ACC}", territory: ["src/queue/**"], gates: ["npm test"] })`);
  check("owner cria a task atribuída", t1.ok && (t1.task.state === "atribuida" || t1.task.state === "rodando"), true);
  const t2 = await evalJson(ownerPage, `await window.team.createTask("${TEAM_ID}", { title: "Exportar relatório de presença", kind: "implementar" })`);
  check("owner cria a task sem dono", t2.ok && t2.task.state, "sem_dono");

  const list = await evalJson(ownerPage, `await window.team.tasks("${TEAM_ID}")`);
  check("board do time lista as tasks", list.ok && list.list.tasks.length, 2);

  // Fill the board so the comparison prints show every column and card state
  // (the prototype's density, not an almost-empty board).
  backend.seed([
    taskView({ id: randomUUID(), short_id: 3, ref: "#3", title: "Exportar relatório de presença", kind: "implementar", state: "sem_dono", assignee_id: null, origin_kind: "manual", updated_at: minutesAgo(35) }),
    taskView({ id: randomUUID(), short_id: 4, ref: "#4", title: "Investigar lentidão no login", kind: "investigar", state: "sem_dono", assignee_id: null, origin_kind: "github", updated_at: minutesAgo(50) }),
    taskView({ id: randomUUID(), short_id: 5, ref: "#5", title: "Testes do convite por login", kind: "implementar", state: "atribuida", assignee_id: MEMBER_ACC, origin_kind: "slack", updated_at: minutesAgo(12) }),
    taskView({ id: randomUUID(), short_id: 6, ref: "#6", title: "Sync da casa de trabalho", kind: "implementar", state: "rodando", assignee_id: OWNER_ACC, provider: "commandcode", origin_kind: "github", territory: ["src/queue/**"], started_at: minutesAgo(22), updated_at: minutesAgo(22) }),
    taskView({ id: randomUUID(), short_id: 7, ref: "#7", title: "Tela de turmas no portal", kind: "integrar", state: "rodando", assignee_id: MEMBER_ACC, provider: "claude", origin_kind: "linear", territory: ["src/queue/**"], started_at: minutesAgo(8), updated_at: minutesAgo(8) }),
    taskView({ id: randomUUID(), short_id: 8, ref: "#8", title: "Lista de membros com papéis", kind: "implementar", state: "aguardando_revisao", assignee_id: MEMBER_ACC, origin_kind: "jira", gates_passed: 4, gates_total: 4, updated_at: minutesAgo(60) }),
    taskView({ id: randomUUID(), short_id: 9, ref: "#9", title: "Fechar oráculo de blob", kind: "corrigir", state: "aguardando_revisao", assignee_id: OWNER_ACC, origin_kind: "manual", gates_passed: 2, gates_total: 2, updated_at: minutesAgo(120) }),
    taskView({ id: randomUUID(), short_id: 10, ref: "#10", title: "Paginação na lista de membros", kind: "implementar", state: "concluida", assignee_id: MEMBER_ACC, origin_kind: "manual", updated_at: minutesAgo(300) }),
    taskView({ id: randomUUID(), short_id: 11, ref: "#11", title: "Ajustar tradução do e-mail", kind: "corrigir", state: "concluida", assignee_id: OWNER_ACC, origin_kind: "csv", updated_at: minutesAgo(600) }),
  ]);

  await ownerPage.evalJs(`document.querySelector('[data-section="team"]').click()`);
  check("a tela do time abre na visão geral", await waitFor(ownerPage, `!!document.querySelector('[data-team-sub="overview"]')`), true);
  await delay(400);
  const shotTo = async (page, dir, name) => {
    const res = await page.send("Page.captureScreenshot", { format: "png" });
    const abs = join(dir, `${name}.png`);
    writeFileSync(abs, Buffer.from(res.data, "base64"));
    return abs;
  };
  const shot = async (page, name) => shotTo(page, OUT_DIR, name);
  const shotA5e = async (page, name) => shotTo(page, A5E_OUT, name);
  const ownerAdmin = await shot(ownerPage, "app-tela10-team-admin");

  await ownerPage.evalJs(`document.querySelector('[data-team-sub="board"]').click()`);
  check("board do time renderiza as colunas", await waitFor(ownerPage, `!!document.querySelector('[data-column="atribuida"]')`), true);
  await ownerPage.evalJs(`document.querySelector('[data-task-id="${TASK_ASSIGNED}"]')?.click()`);
  await delay(300);
  const ownerBoard = await shot(ownerPage, "app-tela11-team-board");

  // Tela 14 — the full create-task form opened from the board's "Nova task".
  await ownerPage.evalJs(`document.querySelector('[data-part="board-new-task"]')?.click()`);
  check("o formulário completo de Nova task abre", await waitFor(ownerPage, `!!document.querySelector('[role="dialog"]')`), true);
  await delay(400);
  const ownerCreate = await shot(ownerPage, "app-tela14-create-task");
  await ownerPage.evalJs(`(() => { const b = document.querySelectorAll('[role="dialog"] header button'); b[b.length - 1]?.click(); return true; })()`);
  await delay(200);

  // Tela 16 — the detail panel with tabs and the Actions menu.
  await ownerPage.evalJs(`document.querySelector('[data-part="task-detail-open"]')?.click()`);
  check("o detalhe da task abre com as abas", await waitFor(ownerPage, `!!document.querySelector('[role="tablist"]')`), true);
  await delay(300);
  await ownerPage.evalJs(`document.querySelector('[data-part="task-actions"]')?.click()`);
  await delay(200);
  check(
    "menu Ações traz Reatribuir e Dividir em subtasks",
    await waitFor(
      ownerPage,
      `!![...document.querySelectorAll('[role="menuitem"]')].find((el) => /Reatribuir|Dividir em subtasks/.test(el.textContent || ""))`,
    ),
    true,
  );
  const ownerDetail = await shot(ownerPage, "app-tela16-task-detail");
  // Close the Actions menu before switching tabs — it covers the Reports tab.
  await ownerPage.evalJs(`document.querySelector('[data-part="task-actions"]')?.click()`);
  await delay(100);
  await ownerPage.evalJs(`([...document.querySelectorAll('[role="tab"]')].find((el) => /Mudanças/.test(el.textContent || "")) || { click() {} }).click()`);
  await delay(200);
  check(
    "Mudanças mostra a letra M na linha modificada",
    await waitFor(ownerPage, `!!document.querySelector('[data-part="diff-file"][data-status="M"]')`),
    true,
  );
  const shareStyles = await evalJson(
    ownerPage,
    `(() => {
      const input = document.querySelector('[data-part="share-file-paths"] input');
      const hint = document.querySelector('[data-part="share-file-paths-hint"]');
      const cs = (el) => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return {
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          color: s.color,
          width: s.width,
          height: s.height,
          appearance: s.appearance,
          backgroundColor: s.backgroundColor,
          borderRadius: s.borderRadius,
        };
      };
      return { switch: cs(input), hint: cs(hint), checked: input ? input.checked : null };
    })()`,
  );
  writeFileSync(join(A5E_OUT, "share-paths-computed-style.json"), JSON.stringify(shareStyles, null, 2));
  check("toggle share paths usa pill (appearance none)", shareStyles?.switch?.appearance === "none" && shareStyles?.switch?.width === "38px", true);
  check("hint de share paths não é mono", shareStyles?.hint?.fontFamily && !/mono/i.test(shareStyles.hint.fontFamily), true);
  const appMudancas = await shotA5e(ownerPage, "app-tela16-task-detail-mudancas");
  await ownerPage.evalJs(`([...document.querySelectorAll('[role="tab"]')].find((el) => /Relatórios/.test(el.textContent || "")) || { click() {} }).click()`);
  await delay(200);
  const appRelatorios = await shotA5e(ownerPage, "app-tela16-task-detail-relatorios");

  // Tela 17 — the archive/delete dialog from the Actions menu.
  await ownerPage.evalJs(`document.querySelector('[data-part="task-actions"]')?.click()`);
  await delay(150);
  await ownerPage.evalJs(`document.querySelector('[data-part="task-delete"]')?.click()`);
  check("o diálogo de excluir abre", await waitFor(ownerPage, `!!document.querySelector('[role="alertdialog"], [role="dialog"]')`), true);
  await delay(300);
  const ownerDelete = await shot(ownerPage, "app-tela17-delete-task");
  await ownerPage.evalJs(`(() => { const b = document.querySelector('[role="alertdialog"] button'); b?.click(); return true; })()`);
  await delay(200);

  // ---- MEMBER: see the board, accept, and bridge into the local Fila --------
  seedUserData(memberUserData, MEMBER_P, "Pessoal", "member-refresh");
  const memberCdp = await pickFreePort();
  memberApp = await startApp({
    cdpPort: memberCdp,
    userDataDir: memberUserData,
    preserveUserData: true,
    isolatedHome: true,
    extraEnv: { STELLARCLOUD_API_URL: apiBase, STELLARCLOUD_AUTH_BROWSER: "log" },
  });
  const memberPage = await connectPage(memberCdp);
  await memberPage.send("Page.enable");
  await memberPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const memberStatus = await waitForCloud(memberPage);
  check("membro entra na conta", memberStatus.account.displayName, "Bruno Melo");

  const memberList = await evalJson(memberPage, `await window.team.tasks("${TEAM_ID}")`);
  check("membro vê o board inteiro", memberList.ok && memberList.list.tasks.length, 11);

  const denied = await evalJson(memberPage, `await window.team.createTask("${TEAM_ID}", { title: "não pode" })`);
  check("membro NÃO cria task (matriz de papéis)", denied.ok, false);

  // A canvas board for the Fila section: create it THROUGH THE UI (so the app
  // knows the board), then come back Home to reach the Team screens.
  await bootIntoFreshSession(memberPage, "Time tasks");
  const memberBoards = JSON.parse(await memberPage.evalJs(`(async () => JSON.stringify(await window.store.boards.list()))()`));
  const boardId = memberBoards.find((b) => b.name === "Time tasks")?.id ?? memberBoards[0]?.id;
  check("membro tem um board local para a Fila", typeof boardId === "string" && boardId.length > 0, true);
  await memberPage.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await waitFor(memberPage, `!!document.querySelector('[data-section="team"]')`);

  await memberPage.evalJs(`document.querySelector('[data-section="team"]').click()`);
  await waitFor(memberPage, `!!document.querySelector('[data-team-sub="board"]')`);
  await memberPage.evalJs(`document.querySelector('[data-team-sub="board"]').click()`);
  check("membro vê o painel Chegou para você com a oferta", await waitFor(memberPage, `!!document.querySelector('[data-column="atribuida"]')`), true);
  await delay(400);
  const memberBoard = await shot(memberPage, "app-tela12-team-member");

  const accepted = await evalJson(memberPage, `await window.team.acceptTask("${TEAM_ID}", "${TASK_ASSIGNED}", { boardId: "${boardId}" })`);
  check("aceitar cria a task local na Fila", accepted.ok === true && typeof accepted.localTaskId === "string", true);

  const promptRes = await evalJson(memberPage, `await window.tasks.getPrompt("${accepted.localTaskId}")`);
  const bridgedPrompt = promptRes.ok ? promptRes.prompt ?? "" : "";
  check("a task local carrega o contrato do time", bridgedPrompt.startsWith("[do time #1]"), true);
  check("a task local traz o território declarado", bridgedPrompt.includes("território: src/queue/**"), true);
  check("a task local traz o gate declarado", bridgedPrompt.includes("gates: npm test"), true);

  const queue = await evalJson(memberPage, `await window.team.queue()`);
  check("a Fila guarda a entrada 'do time'", queue.ok && queue.entries.some((e) => e.teamTaskId === accepted.task.id), true);

  // State bridge: this app never STORES `running` (a live card means that), so
  // the reachable local signal is `done` → report delivered + aguardando_revisao.
  const moved = await evalJson(memberPage, `await window.tasks.moveTask("${accepted.localTaskId}", "done", 0, [])`);
  check("mover a task local para concluída", moved.ok, true);
  const synced = await evalJson(memberPage, `await window.team.queueSync()`);
  check("o app reporta o estado ao servidor", synced.ok && backend.reports().some((r) => r.state === "aguardando_revisao" && r.report_delivered === true), true);

  // Tela 13 — the Fila card's "Do time" section on the canvas board.
  await memberPage.evalJs(`document.querySelector('[data-section="sessions"]')?.click()`);
  await waitFor(memberPage, `!!document.querySelector('.home-session-card') || !!document.querySelector('.home .primary')`);
  await memberPage.evalJs(`
    (() => {
      const card = document.querySelector('.home-session-card');
      if (card) { card.click(); return true; }
      const hero = document.querySelector('.home .primary');
      if (hero) { hero.click(); return true; }
      return false;
    })()
  `);
  await waitFor(memberPage, `!!document.querySelector('.topbar-title')`);
  if (!(await memberPage.evalJs(`!!document.querySelector('[data-kind="task"]')`))) {
    try {
      await spawnCard(memberPage, "task");
    } catch {
      /* no task kind in the rail */
    }
  }
  check("a seção 'Do time' aparece na Fila", await waitFor(memberPage, `!!document.querySelector('[data-part="team-queue"]')`), true);
  await delay(500);
  const memberFila = await shot(memberPage, "app-tela13-fila-team");

  const returned = await evalJson(memberPage, `await window.team.returnTask("${TEAM_ID}", "${TASK_ASSIGNED}")`);
  check("devolver volta a task para sem dono", returned.ok && returned.task.state, "sem_dono");

  // Prototype TaskDetail for the Changes / Reports tabs only. support.js is
  // absent, so keep the matching sc-if body and a static tab strip.
  const taskDetailHtml = readFileSync(join(PROTO_DIR, "TaskDetail.dc.html"), "utf8");
  const protoTabHtml = (tab) => {
    const keep = tab === "diff" ? "isDiff" : "isReports";
    const labels = [
      ["activity", "Atividade"],
      ["contract", "Contrato"],
      ["gates", "Gates"],
      ["diff", "Mudanças"],
      ["reports", "Relatórios"],
    ];
    const tabButtons = labels
      .map(([id, label]) => {
        const on = (tab === "diff" && id === "diff") || (tab === "reports" && id === "reports");
        const style = on
          ? "height: 38px; padding: 0 12px; border: 0; background: transparent; font: inherit; font-size: 13px; cursor: pointer; margin-bottom: -1px; color: #ffffff; border-bottom: 2px solid #7c8cff"
          : "height: 38px; padding: 0 12px; border: 0; background: transparent; font: inherit; font-size: 13px; cursor: pointer; margin-bottom: -1px; color: #a3aabb; border-bottom: 2px solid transparent";
        return `<button role="tab" aria-selected="${on ? "true" : "false"}" style="${style}">${label}</button>`;
      })
      .join("");
    let html = taskDetailHtml;
    for (const name of ["isActivity", "isContract", "isGates", "isDiff", "isReports"]) {
      if (name === keep) continue;
      html = html.replace(new RegExp(`<sc-if value="\\{\\{${name}\\}\\}"[\\s\\S]*?<\\/sc-if>`, "g"), "");
    }
    html = html.replace(
      /<div style="display: flex; gap: 4px; border-bottom: 1px solid #1d2130" role="tablist"[\s\S]*?<\/div>/,
      `<div style="display: flex; gap: 4px; border-bottom: 1px solid #1d2130" role="tablist" aria-label="Seções da task">${tabButtons}</div>`,
    );
    // Close the Actions menu in the static markup.
    html = html.replace('aria-expanded="true"', 'aria-expanded="false"');
    html = html.replace(
      /<div role="menu"[\s\S]*?<\/div>\s*<\/div>\s*<button class="wc"/,
      '</div>\n          <button class="wc"',
    );
    return html;
  };
  await ownerPage.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(protoTabHtml("diff"))}` });
  await delay(500);
  const protoMudancas = await shotA5e(ownerPage, "proto-TaskDetail-mudancas");
  await ownerPage.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(protoTabHtml("reports"))}` });
  await delay(500);
  const protoRelatorios = await shotA5e(ownerPage, "proto-TaskDetail-relatorios");

  // Side-by-side composites (same tab on both sides) stay in /tmp/a5e.
  const { execFileSync } = await import("node:child_process");
  const compose = (left, right, out) => {
    try {
      execFileSync("magick", [left, right, "+append", out], { stdio: "ignore" });
    } catch {
      execFileSync(
        "python3",
        [
          "-c",
          `from PIL import Image; a=Image.open(${JSON.stringify(left)}).convert("RGB"); b=Image.open(${JSON.stringify(right)}).convert("RGB"); h=max(a.height,b.height); c=Image.new("RGB",(a.width+b.width,h),(11,13,18)); c.paste(a,(0,0)); c.paste(b,(a.width,0)); c.save(${JSON.stringify(out)})`,
        ],
        { stdio: "ignore" },
      );
    }
  };
  compose(protoMudancas, appMudancas, join(A5E_OUT, "a5e-side-by-side-mudancas.png"));
  compose(protoRelatorios, appRelatorios, join(A5E_OUT, "a5e-side-by-side-relatorios.png"));
  writeFileSync(
    join(A5E_OUT, "a5e-spec-table.md"),
    [
      "# A5e — tela 16 (Mudanças / Relatórios)",
      "",
      "Evidence in `/tmp/a5e/` (public repo — do not commit).",
      "",
      "| Element | Notes |",
      "|---|---|",
      "| Status letter | Every file row shows A/M/D/R |",
      "| share_file_paths | Pill toggle (WorkHome `.switch`); hint uses secondary text size/color |",
      "| Side-by-side | Mudanças↔Mudanças, Relatórios↔Relatórios |",
      "",
      "Computed styles: `share-paths-computed-style.json`.",
      "",
    ].join("\n"),
  );

  ownerPage.close();
  memberPage.close();
  console.log("[smoke] prints:");
  console.log("  ", ownerAdmin);
  console.log("  ", ownerBoard);
  console.log("  ", ownerCreate);
  console.log("  ", ownerDetail);
  console.log("  ", ownerDelete);
  console.log("  ", memberBoard);
  console.log("  ", memberFila);
  console.log("[smoke] a5e (private):");
  console.log("  ", appMudancas);
  console.log("  ", appRelatorios);
  console.log("  ", protoMudancas);
  console.log("  ", protoRelatorios);
  console.log("  ", join(A5E_OUT, "a5e-side-by-side-mudancas.png"));
  console.log("  ", join(A5E_OUT, "a5e-side-by-side-relatorios.png"));
} finally {
  if (ownerApp) await stopApp(ownerApp);
  if (memberApp) await stopApp(memberApp);
  if (backend) await backend.close();
  rmSync(ownerUserData, { recursive: true, force: true });
  rmSync(memberUserData, { recursive: true, force: true });
  rmSync(`${ownerUserData}-home`, { recursive: true, force: true });
  rmSync(`${memberUserData}-home`, { recursive: true, force: true });
  console.log("[smoke] removidos:", ownerUserData, memberUserData);
}
finish();
process.exit(0);

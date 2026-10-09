/**
 * Shared Fila V3 fixture — prototype mock ids/titles/states for capture + parity.
 */
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function findDb(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === "agent-canvas.db") return p;
    }
  }
  return null;
}

/** Fixed clock for Fila V3 / V3.1 parity — elapsed tiles read Date.now(). */
export const FILA_V3_CLOCK = Date.parse("2026-10-09T18:00:00.000Z");

/** Seed the isolated DB with the prototype mock set (fixed ids → short #id). */
function seedMockTasks(dbPath, boardId, sprintId, clock = FILA_V3_CLOCK) {
  const db = new Database(dbPath);
  const now = clock;
  const today = now - 3_600_000;
  const insert = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, prompt, provider, status, card_id, board_id, cwd, result_json, deps_json,
      purpose, review, territory_json, gates_json, allow_commit, report_schema_json,
      spawn_profile, retry_count, attempted_providers_json, max_retries, fallback_providers_json,
      "order", suggested_order, implicit_order, diverged_status, diverged_actor,
      requested_status, requested_reason, requested_by, requested_at, superseded_by,
      sprint_id, created_at, updated_at
    ) VALUES (
      @id, @prompt, @provider, @status, @card_id, @board_id, NULL, @result_json, @deps_json,
      @purpose, @review, NULL, NULL, NULL, NULL,
      NULL, 0, NULL, NULL, NULL,
      @ord, NULL, NULL, NULL, NULL,
      @requested_status, @requested_reason, @requested_by, @requested_at, @superseded_by,
      @sprint_id, @created_at, @updated_at
    )
  `);

  const rows = [
    {
      id: "0c8694c7-aaaa-4000-8000-000000000001",
      prompt: "R1 — Relay do celular (WSS), presença e Web Push",
      status: "pending",
      purpose: "implement",
      result_json: JSON.stringify({
        blockedQuestion: {
          text: "#0c8694 R1 foi disparada sozinha, mas o celular está em pausa. O que fazer?",
          options: [
            { id: "keep", label: "Manter pausada" },
            { id: "go", label: "Liberar" },
          ],
          askedAt: now - 2 * 3_600_000,
          by: "agent",
        },
      }),
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 1,
      updated_at: now,
    },
    {
      id: "49cfbee6-aaaa-4000-8000-000000000002",
      prompt: "R2 — Conexão do desktop e pareamento por QR",
      status: "pending",
      purpose: "implement",
      result_json: null,
      deps_json: JSON.stringify(["0c8694c7-aaaa-4000-8000-000000000001"]),
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 2,
      updated_at: now,
    },
    {
      id: "a49a83aa-aaaa-4000-8000-000000000003",
      prompt: "A5d — Criação rápida de task (tela 15)",
      status: "pending",
      purpose: "implement",
      result_json: null,
      deps_json: null,
      requested_status: "pending",
      // Needs-you strip body (Fila.dc.html); tile title stays A5d.
      requested_reason: "#70584525 A5c e mais 3 esperam liberação depois do commit do ciclo.",
      requested_by: "agent",
      requested_at: now - 2 * 3_600_000,
      superseded_by: null,
      review: null,
      ord: 3,
      updated_at: now,
    },
    {
      id: "c5b6aeaa-aaaa-4000-8000-000000000004",
      prompt: "Terminal: scroll e desenho travam depois de sair da sessão e voltar",
      status: "pending",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 4,
      updated_at: now,
    },
    {
      id: "3fe745aa-aaaa-4000-8000-000000000005",
      prompt: "Navegadores: CPU a 99% com 5 abertos, e o canvas não se move sobre eles",
      status: "pending",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 5,
      updated_at: now,
    },
    {
      id: "91a56869-aaaa-4000-8000-000000000006",
      prompt: 'Card Fila: "Substituídas" como coluna própria',
      status: "pending",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 6,
      updated_at: now,
    },
    {
      id: "511abcb2-aaaa-4000-8000-000000000007",
      // First line is the tile/dialog title; headed sections feed the Resumo tab.
      prompt: `Card que termina o turno sem report recebe o lembrete

O que é
Cards ainda esquecem o report. Quando um implementador termina o turno e não reporta, o próprio card recebe o lembrete; se continuar sem, o orquestrador é avisado uma vez.

O que foi medido
Os gates rodam quando o report chegar, numa worktree isolada.`,
      status: "running",
      purpose: "fix",
      result_json: JSON.stringify({
        gateRun: {
          ok: true,
          commands: [{ cmd: "npm run check:types", exitCode: 0 }],
          diff: {
            gitRoot: "/tmp",
            stat: "",
            patch: "",
            patchTruncated: false,
            files: [
              { path: "src/main/report-watchdog.ts", status: "M", inTerritory: true, territoryDeclared: true },
              { path: "src/main/providers.ts", status: "M", inTerritory: true, territoryDeclared: true },
              { path: "src/renderer/src/TerminalCard.tsx", status: "M", inTerritory: true, territoryDeclared: true },
              { path: "scripts/verify/smoke-report-reminder.mjs", status: "A", inTerritory: true, territoryDeclared: true },
              { path: "tests/unit/report-watchdog.test.ts", status: "A", inTerritory: true, territoryDeclared: true },
              { path: "docs/ORCHESTRATION.md", status: "M", inTerritory: false, territoryDeclared: true },
            ],
            filesTruncated: false,
            total: 6,
            outsideTerritory: 1,
            territoryDeclared: true,
            note: "observed change, not authorship",
          },
        },
      }),
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 7,
      updated_at: now - 38 * 60_000,
      provider: "claude",
      card_id: null,
    },
    {
      id: "ad6787aa-aaaa-4000-8000-000000000008",
      prompt: "Investigação: terminal ao voltar da sessão",
      status: "running",
      purpose: "investigate",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 8,
      updated_at: now - 12 * 60_000,
      provider: "antigravity",
    },
    {
      id: "e0b6b86a-aaaa-4000-8000-000000000009",
      prompt: `Terminais fora da tela não desenham, e app aberto de um card não vira "Stellar"

O aceite
- read_card fora da tela devolve a saída retida
- GPU e renderer caem com cards offscreen`,
      status: "pending",
      purpose: "fix",
      result_json: JSON.stringify({
        gateRun: {
          ok: false,
          commands: [
            { cmd: "npm run check:types", exitCode: 2 },
            { cmd: "npx vitest run", exitCode: 0 },
          ],
          isolation: {
            mode: "isolated",
            undeclaredInTerritory: ["src/renderer/src/TeamPage.tsx", "src/shared/i18n/catalogs.ts"],
          },
        },
      }),
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      // Null: stays in Revisão via report, but does NOT enter "Precisa de você"
      // (that strip is only review="wanted" without a reviewer — a550a7ae).
      review: null,
      ord: 9,
      updated_at: now - 6 * 60_000,
    },
    {
      id: "d97be5aa-aaaa-4000-8000-000000000010",
      prompt: "A9 — Gate de plano e upgrade",
      status: "done",
      purpose: "implement",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 10,
      updated_at: today,
    },
    {
      id: "ba68ddaa-aaaa-4000-8000-000000000011",
      prompt: "A5b — Tasks do time: criar, detalhe, excluir",
      status: "done",
      purpose: "implement",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 11,
      updated_at: today,
    },
    {
      id: "9012e6aa-aaaa-4000-8000-000000000012",
      prompt: "Território compartilhado",
      status: "done",
      purpose: "implement",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 12,
      updated_at: today,
    },
    {
      id: "711281aa-aaaa-4000-8000-000000000013",
      prompt: "Cinco smokes que o destravamento expôs",
      status: "failed",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 13,
      updated_at: Date.parse("2026-09-23T12:00:00Z"),
    },
    {
      id: "ae3e0fe2-aaaa-4000-8000-000000000014",
      prompt: `STELLAR · R4 — Push cifrado pelo desktop (primeira versão)

Push: o desktop cifra o aviso (RFC 8291) e o servidor só assina com VAPID e envia. Nunca chegou a rodar.`,
      status: "superseded",
      purpose: "fix",
      result_json: JSON.stringify({
        supersededReason:
          "dependência criada com um id provisório que nunca existiu; refeita com a dependência certa",
        supersededTitle: "R4 — Push cifrado pelo desktop",
      }),
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: "878514a8-aaaa-4000-8000-000000000099",
      review: null,
      ord: 14,
      updated_at: now,
    },
    {
      id: "b9b00001-aaaa-4000-8000-000000000016",
      prompt: "R4 — Avisos no celular",
      status: "superseded",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: "878514a8-aaaa-4000-8000-000000000099",
      review: null,
      ord: 16,
      updated_at: now,
    },
    {
      id: "b9b00002-aaaa-4000-8000-000000000017",
      prompt: "B9b — Integrações II",
      status: "superseded",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: "ebfc5e30-aaaa-4000-8000-000000000098",
      review: null,
      ord: 17,
      updated_at: now,
    },
    {
      id: "b9b00003-aaaa-4000-8000-000000000018",
      prompt: "A4 — Time no app",
      status: "superseded",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: "36f32fed-aaaa-4000-8000-000000000097",
      review: null,
      ord: 18,
      updated_at: now,
    },
    {
      id: "b9b00004-aaaa-4000-8000-000000000019",
      prompt: "R3 — Notificações no desktop",
      status: "superseded",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: "878514a8-aaaa-4000-8000-000000000099",
      review: null,
      ord: 19,
      updated_at: now,
    },
    {
      id: "b9b00005-aaaa-4000-8000-000000000020",
      prompt: "A5a — Lista de tasks do board",
      status: "superseded",
      purpose: "fix",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: "ba68ddaa-aaaa-4000-8000-000000000011",
      review: null,
      ord: 20,
      updated_at: now,
    },
    {
      id: "a550a7ae-aaaa-4000-8000-000000000015",
      prompt: "Detalhe da task no card Fila, mais organizado",
      status: "pending",
      purpose: "implement",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      // Ready column + needs-you strip via review=wanted without a final report.
      review: "wanted",
      ord: 15,
      updated_at: now,
    },
  ];

  // The see-all label counts every done row. Rows older than today stay out
  // of the done column, which only lists rows updated today. The archive
  // size matches the prototype copy (212).
  const DONE_ARCHIVE_TOTAL = 212;
  const namedDone = rows.filter((r) => r.status === "done").length;
  const archiveUpdatedAt = now - 2 * 86_400_000;
  for (let i = 0; i < DONE_ARCHIVE_TOTAL - namedDone; i++) {
    const n = String(i).padStart(4, "0");
    rows.push({
      id: `arch${n}-aaaa-4000-8000-000000000d01`,
      prompt: "arquivo concluído",
      status: "done",
      purpose: "implement",
      result_json: null,
      deps_json: null,
      requested_status: null,
      requested_reason: null,
      requested_by: null,
      requested_at: null,
      superseded_by: null,
      review: null,
      ord: 100 + i,
      updated_at: archiveUpdatedAt,
    });
  }

  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run({
        id: r.id,
        prompt: r.prompt,
        provider: r.provider ?? null,
        status: r.status,
        card_id: r.card_id ?? null,
        board_id: boardId,
        result_json: r.result_json,
        deps_json: r.deps_json,
        purpose: r.purpose,
        review: r.review,
        ord: r.ord,
        requested_status: r.requested_status,
        requested_reason: r.requested_reason,
        requested_by: r.requested_by,
        requested_at: r.requested_at,
        superseded_by: r.superseded_by,
        sprint_id: sprintId,
        created_at: now - 86_400_000,
        updated_at: r.updated_at,
      });
    }
  });
  tx();
  db.close();
  return now;
}

export { findDb, seedMockTasks };

/** Wire live PTYs + reports so Rodando/Revisão match DADOS §3. */
export function wireLiveLinks(dbPath, clock = FILA_V3_CLOCK) {
  const db = new Database(dbPath);
  const now = clock;
  const runA = "511abcb2-aaaa-4000-8000-000000000007";
  const runB = "ad6787aa-aaaa-4000-8000-000000000008";
  const ready = "c5b6aeaa-aaaa-4000-8000-000000000004";
  const review = "e0b6b86a-aaaa-4000-8000-000000000009";
  const proto = "a550a7ae-aaaa-4000-8000-000000000015";
  const liveA = "fila-v3-live-claude";
  const liveB = "fila-v3-live-gemini";
  const deadReview = "fila-v3-dead-review";
  const deadProto = "fila-v3-dead-proto";
  // Status stays pending — openStore normalizes legacy `running` rows; the
  // running column comes from a live implementer card (cardAlive).
  db.prepare(`UPDATE tasks SET card_id = ?, status = 'pending', updated_at = ? WHERE id = ?`).run(
    liveA,
    now - 38 * 60_000,
    runA,
  );
  db.prepare(`UPDATE tasks SET card_id = ?, status = 'pending', updated_at = ? WHERE id = ?`).run(
    liveB,
    now - 12 * 60_000,
    runB,
  );
  db.prepare(`UPDATE tasks SET card_id = ?, updated_at = ? WHERE id = ?`).run(deadReview, now - 6 * 60_000, review);
  // Keep a550 in ready: no live card and no final report; strip uses review=wanted.
  db.prepare(`UPDATE tasks SET card_id = NULL, updated_at = ? WHERE id = ?`).run(now - 60_000, proto);
  const link = db.prepare(
    `INSERT OR REPLACE INTO task_cards
       (task_id, card_id, role, linked_at, provider, reservation_state, reserved_order, released_at)
     VALUES (?, ?, 'implementer', ?, ?, ?, ?, ?)`,
  );
  link.run(runA, liveA, now, "claude", null, null, null);
  link.run(runB, liveB, now, "antigravity", null, null, null);
  link.run(ready, liveA, now, "claude", "reserved", 1, null);
  link.run(review, deadReview, now, "claude", null, null, now - 5 * 60_000);
  // Elapsed on running tiles uses the latest statusTransitions→running.
  const tr = db.prepare(
    `INSERT OR REPLACE INTO task_transitions
       (id, task_id, kind, from_value, to_value, actor, card_id, user_id, at)
     VALUES (?, ?, 'status', ?, ?, 'app', ?, NULL, ?)`,
  );
  tr.run("fila-v3-tr-run-b", runB, "pending", "running", liveB, now - 12 * 60_000);
  // Nine status transitions on 511abcb2 (trail tab); last →running stamps 38 min.
  const trailSteps = [
    ["pending", "ready"],
    ["ready", "running"],
    ["running", "pending"],
    ["pending", "ready"],
    ["ready", "running"],
    ["running", "pending"],
    ["pending", "ready"],
    ["ready", "pending"],
    ["pending", "running"],
  ];
  for (let i = 0; i < trailSteps.length; i++) {
    const [from, to] = trailSteps[i];
    const at = i === trailSteps.length - 1 ? now - 38 * 60_000 : now - (120 - i * 8) * 60_000;
    tr.run(`fila-v3-tr-trail-${i}`, runA, from, to, liveA, at);
  }
  const verdict = db.prepare(
    `INSERT OR REPLACE INTO task_verdicts (id, task_id, card_id, role, verdict, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Two reviewer verdicts so the review tile shows the second-pass meta label.
  verdict.run("fila-v3-vd-1", review, deadReview, "reviewer", "changes_requested", now - 20 * 60_000);
  verdict.run("fila-v3-vd-2", review, deadReview, "reviewer", "changes_requested", now - 10 * 60_000);
  // Done-column phrases: reviewer x2, Master x4, Master x1.
  const doneRev = "d97be5aa-aaaa-4000-8000-000000000010";
  const doneMaster4 = "ba68ddaa-aaaa-4000-8000-000000000011";
  const doneMaster1 = "9012e6aa-aaaa-4000-8000-000000000012";
  verdict.run("fila-v3-vd-done-r1", doneRev, deadReview, "reviewer", "changes_requested", now - 40 * 60_000);
  verdict.run("fila-v3-vd-done-r2", doneRev, deadReview, "reviewer", "aprovado", now - 30 * 60_000);
  for (let i = 0; i < 4; i++) {
    verdict.run(
      `fila-v3-vd-done-m4-${i}`,
      doneMaster4,
      deadReview,
      "implementer",
      "changes_requested",
      now - (50 - i * 5) * 60_000,
    );
  }
  verdict.run("fila-v3-vd-done-m1", doneMaster1, deadReview, "implementer", "aprovado", now - 15 * 60_000);
  const report = db.prepare(
    `INSERT INTO reports (seq, card_id, report_json, verdict, role, channel, updated_at)
     VALUES (?, ?, ?, NULL, 'implementer', 'mcp', ?)`,
  );
  // ok:true + estado final + declared taskId — awaiting_review only after a
  // final implementer report for THIS task (phase fix).
  report.run(
    900001,
    deadReview,
    JSON.stringify({
      summary: "gate vermelho fora do território",
      ok: true,
      estado: "final",
      taskId: review,
    }),
    now - 6 * 60_000,
  );
  db.close();
}

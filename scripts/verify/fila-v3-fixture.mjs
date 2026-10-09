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

/** Seed the isolated DB with the prototype mock set (fixed ids → short #id). */
function seedMockTasks(dbPath, boardId, sprintId) {
  const db = new Database(dbPath);
  const now = Date.now();
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
      requested_reason: "aguardando liberação",
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
      prompt: `Card que termina o turno sem report recebe o lembrete, também nos providers que não declaram turno

Cards ainda esquecem o report. Quando um implementador termina o turno e não reporta em alguns segundos, o próprio card recebe uma mensagem do Stellar pedindo o report; se continuar sem, o orquestrador é avisado uma vez.

O aceite
- Testes com amostras reais de tela por provider
- Lembrete ao card, depois aviso ao orquestrador, uma vez cada
- Smoke isolado com um card commandcode que termina sem report
- Suíte sem regressão, check:types limpo, comentários em inglês

FAZER
1. Fim de turno pela TELA, declarado por provider como dado
2. O watchdog usa esse fato como declaredIdle`,
      status: "running",
      purpose: "fix",
      result_json: null,
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
      review: "wanted",
      ord: 15,
      updated_at: now,
    },
  ];

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
}

export { findDb, seedMockTasks };

/** Wire live PTYs + reports so Rodando/Revisão match DADOS §3. */
export function wireLiveLinks(dbPath) {
  const db = new Database(dbPath);
  const now = Date.now();
  const runA = "511abcb2-aaaa-4000-8000-000000000007";
  const runB = "ad6787aa-aaaa-4000-8000-000000000008";
  const ready = "c5b6aeaa-aaaa-4000-8000-000000000004";
  const review = "e0b6b86a-aaaa-4000-8000-000000000009";
  const proto = "a550a7ae-aaaa-4000-8000-000000000015";
  const liveA = "fila-v3-live-claude";
  const liveB = "fila-v3-live-gemini";
  const deadReview = "fila-v3-dead-review";
  const deadProto = "fila-v3-dead-proto";
  db.prepare(`UPDATE tasks SET card_id = ?, status = 'pending', updated_at = ? WHERE id = ?`).run(liveA, now, runA);
  db.prepare(`UPDATE tasks SET card_id = ?, status = 'pending', updated_at = ? WHERE id = ?`).run(liveB, now, runB);
  db.prepare(`UPDATE tasks SET card_id = ?, updated_at = ? WHERE id = ?`).run(deadReview, now, review);
  db.prepare(`UPDATE tasks SET card_id = ?, updated_at = ? WHERE id = ?`).run(deadProto, now, proto);
  const link = db.prepare(
    `INSERT OR REPLACE INTO task_cards
       (task_id, card_id, role, linked_at, provider, reservation_state, reserved_order, released_at)
     VALUES (?, ?, 'implementer', ?, ?, ?, ?, ?)`,
  );
  link.run(runA, liveA, now, "claude", null, null, null);
  link.run(runB, liveB, now, "claude", null, null, null);
  link.run(ready, liveA, now, "claude", "reserved", 1, null);
  link.run(review, deadReview, now, "claude", null, null, now - 5 * 60_000);
  link.run(proto, deadProto, now, "claude", null, null, now - 5 * 60_000);
  const report = db.prepare(
    `INSERT INTO reports (seq, card_id, report_json, verdict, role, channel, updated_at)
     VALUES (?, ?, ?, NULL, 'implementer', 'mcp', ?)`,
  );
  report.run(900001, deadReview, JSON.stringify({ summary: "gate vermelho fora do território", ok: false }), now - 6 * 60_000);
  report.run(900002, deadProto, JSON.stringify({ summary: "protótipo pronto para aprovar", ok: true }), now - 60_000);
  db.close();
}

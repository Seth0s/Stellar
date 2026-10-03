import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { decideReportVerdictWrite } from "../../src/main/judgment-write-decision";
import { openStore } from "../../src/main/store";

/**
 * Task 2d74064f — REUSAR UM CARD PARA JULGAR PRECISA CRIAR O VÍNCULO.
 *
 * O caso real: o orquestrador reusou um card de review por `send_to_card` com
 * um brief que NOMEIA a task; o brief entregou, o reviewer julgou, e o gate de
 * veredito o RECUSOU por não haver linha em `task_cards` — seis tasks ficaram
 * `pending` com o veredito na mão.
 *
 * Aqui: (A) o BLOQUEIO de hoje e o DESBLOQUEIO pela existência do vínculo, no
 * gate que recusa; (B) o vínculo que o store grava é o que o gate lê; (C) o
 * caminho novo NÃO afrouxa o anti-hijack — ele passa pela MESMA porta de
 * autoria do `link_task_card`, e um card NÃO encarregado segue recusado.
 */

function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>) {
  return new Proxy({}, { get: (_t, prop: string) => overrides[prop] ?? (() => undefined) }) as Parameters<
    typeof createMessageBus
  >[1];
}

describe("(A) o gate de veredito: sem vínculo recusa, com vínculo desbloqueia", () => {
  it("card REUSADO (sem linha em task_cards) numa task review=\"wanted\" => RECUSA (o bloqueio medido)", () => {
    const res = decideReportVerdictWrite({
      verdict: "aprovado",
      requesterRoleOnTask: null, // não há linha em task_cards para este card
      reviewWanted: true,
      report: { ok: true, evidencia: "npx vitest run => 3120" },
    });
    expect(res.action).toBe("refuse");
    if (res.action === "refuse") expect(res.error).toContain("role=reviewer");
  });

  it("COM o vínculo de reviewer => DESBLOQUEIA (é o vínculo que faltava, e é tudo o que o gate pede)", () => {
    const res = decideReportVerdictWrite({
      verdict: "aprovado",
      requesterRoleOnTask: "reviewer",
      reviewWanted: true,
      report: { ok: true, evidencia: "npx vitest run => 3120" },
    });
    expect(res.action).toBe("allow");
  });

  it("card NÃO encarregado (vínculo como IMPLEMENTER) SEGUE recusado — o vínculo não é passe livre", () => {
    const res = decideReportVerdictWrite({
      verdict: "aprovado",
      requesterRoleOnTask: "implementer",
      reviewWanted: true,
      report: { ok: true, evidencia: "x" },
    });
    expect(res.action).toBe("refuse");
  });
});

describe("(B) o vínculo que o caminho novo grava é o que o gate lê", () => {
  let dir: string | null = null;
  let store: ReturnType<typeof openStore> | null = null;
  afterEach(() => {
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("linkTaskCard(card, 'reviewer') => listTaskCardsForCard devolve role reviewer => o gate permite", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-link-delivery-"));
    store = openStore(dir);
    store.upsertCard({
      id: "rev-card", board_id: "b1", kind: "terminal", provider: "claude", cwd: "/tmp",
      x: 0, y: 0, w: 1, h: 1, resume_id: null, model: null, effort: null, system_prompt: null,
      group_id: null, label: null, updated_at: 1, messages_json: null, archived_at: null, created_at: 1,
    });
    store.upsertTask({
      id: "t1", prompt: "p", provider: null, status: "pending", card_id: null, board_id: "b1", cwd: null,
      spawn_profile: null, result_json: null, deps_json: null, purpose: null, review: "wanted",
      territory_json: null, gates_json: null, allow_commit: null, report_schema_json: null,
      retry_count: 0, attempted_providers_json: null, max_retries: null, fallback_providers_json: null,
      order: null, suggested_order: null, implicit_order: null, diverged_status: null, diverged_actor: null,
      requested_status: null, requested_reason: null, requested_by: null, requested_at: null, sprint_id: null,
      created_at: 1, updated_at: 1,
    } as never);
    store.linkTaskCard("t1", "rev-card", "reviewer");

    const rows = store.listTaskCardsForCard("rev-card");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: "t1", role: "reviewer" });

    // O gate lê EXATAMENTE este `role` — a cadeia fecha.
    const gate = decideReportVerdictWrite({
      verdict: "aprovado",
      requesterRoleOnTask: rows[0]!.role,
      reviewWanted: true,
      report: { ok: true, evidencia: "3120 passed" },
    });
    expect(gate.action).toBe("allow");
  });
});

describe("(C) o caminho novo não afrouxa o anti-hijack", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const task = (over: Record<string, unknown> = {}) => ({
    id: "t1",
    card_id: "impl-card",
    board_id: "b1",
    review: "wanted",
    status: "pending",
    ...over,
  });

  function makeBus(overrides: Record<string, (...args: never[]) => unknown>) {
    dir = mkdtempSync(join(tmpdir(), "stellar-link-delivery-bus-"));
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: () => [{ id: "rev-card", kind: "terminal" }],
        listTasks: () => [],
        listTaskCardsForCard: () => [],
        getTask: () => task(),
        // Sem marca de orquestrador no board: a ÚNICA porta vira "o humano".
        getBoardOrchestratorCardId: () => null,
        ...overrides,
      }),
    );
  }

  it("um card que NÃO é a marca do board não vincula TERCEIRO — recusado pela porta de autoria existente", async () => {
    makeBus({});
    const res = (await bus!.handleRequest({
      cmd: "send",
      target: "rev-card",
      text: "revise a task",
      requesterId: "um-card-qualquer",
      linkTaskId: "t1",
      linkRole: "reviewer",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    // A recusa é a MESMA do link_task_card (autoria de participação), não uma nova.
    expect(res.error).toContain("only the card marked as orchestrator");
  });

  it("um card não se autovincula como reviewer (self-review link)", async () => {
    makeBus({});
    const res = (await bus!.handleRequest({
      cmd: "send",
      target: "rev-card",
      text: "eu julgo",
      requesterId: "rev-card",
      linkTaskId: "t1",
      linkRole: "reviewer",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("self-assigning review");
  });

  it("`linkTaskId` sem `linkRole` é RECUSADO nomeando os dois — papel nunca é inferido", async () => {
    makeBus({});
    const res = (await bus!.handleRequest({
      cmd: "send",
      target: "rev-card",
      text: "x",
      requesterId: "orch-card",
      linkTaskId: "t1",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("linkTaskId");
    expect(res.error).toContain("linkRole");
  });

  it("`linkRole` fora do enum é recusado nomeando o campo (nunca substitui em silêncio)", async () => {
    makeBus({});
    const res = (await bus!.handleRequest({
      cmd: "send",
      target: "rev-card",
      text: "x",
      requesterId: "orch-card",
      linkTaskId: "t1",
      linkRole: "chefe",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("linkRole");
  });

  it("a MARCA do board vincula o terceiro — a validação passa (o vínculo é o caminho novo)", async () => {
    const calls: unknown[] = [];
    makeBus({
      getBoardOrchestratorCardId: () => "orch-card",
      linkTaskCard: (...args: never[]) => {
        calls.push(args);
      },
    });
    // Sem rig de entrega, a chamada pode parar depois do vínculo; o que importa
    // é que a PORTA DE AUTORIA deixou passar e o vínculo foi criado.
    try {
      await bus!.handleRequest({
        cmd: "send",
        target: "rev-card",
        text: "revise",
        requesterId: "orch-card",
        linkTaskId: "t1",
        linkRole: "reviewer",
      } as BusRequest);
    } catch {
      /* a entrega em si não é o objeto deste teste */
    }
    expect(calls).toHaveLength(1);
    expect((calls[0] as unknown[]).slice(0, 3)).toEqual(["t1", "rev-card", "reviewer"]);
  });
});

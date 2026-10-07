import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { decideStatusWrite, type StatusWriteDecision } from "../../src/main/status-write-decision";
import type { StatusActor } from "../../src/task-status-derive";
import type { ReportRow, TaskCardRow, TaskRow } from "../../src/main/store";

/**
 * task c10a1faf — `close_card` NÃO pode concluir uma task que nunca começou.
 *
 * DEFEITO MEDIDO 2026-10-04 (board 64): a task ea3801e4 foi ligada por
 * `link_task_card mode:deliver` a um card e depois desligada com
 * `update_task cardId:null`, sem o card ter começado/reportado. O `close_card`
 * do card respondeu `concludedTasks:[ea3801e4]` e a task virou `done` — porque
 * a decisão usava "o último report do CARD é ok:true" sem olhar DE QUAL TASK o
 * report era (o card é um SLOT que responde por várias). E o `done` carimbado
 * pelo fechamento virava um status autoritativo que RETINHA a correção
 * ("the human status done prevails"), tornando-o irreversível.
 *
 * Estes testes exercitam o CAMINHO REAL do bus (handleRequest + consent
 * resolvido), com um funil de status emulando o choke point do store
 * (`decideStatusWrite`), porque o REPOINT/`actor` são o que o item 3 mede.
 */

type Link = {
  task_id: string;
  card_id: string;
  role: string;
  released: boolean;
  reservation_state: string | null;
  /** When the card was linked to the task; the "round" of a report starts here. */
  linked_at: number | null;
};

const WORK = "/tmp/stellar-c10a1faf-work";

function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: `task ${id}`,
    provider: "commandcode",
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: WORK,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    review: null,
    created_at: 1,
    updated_at: 1,
    verdicts: [],
    ...over,
  } as unknown as TaskRow;
}

function link(taskId: string, cardId: string, over: Partial<Link> = {}): Link {
  return { task_id: taskId, card_id: cardId, role: "implementer", released: false, reservation_state: null, linked_at: 1, ...over };
}

type Rig = {
  bus: ReturnType<typeof createMessageBus>;
  dir: string;
  state: { tasks: Map<string, { row: TaskRow; lastActor: StatusActor | null }>; upserts: Array<{ id: string; status: string; actor: StatusActor | null }> };
  links: Link[];
  reports: Array<{ cardId: string; seq: number; body: unknown }>;
  closeRequests: Array<{ requestId: string; target: string; requesterId: string }>;
};

function makeRig(
  overrides: {
    links?: Link[];
    reports?: Array<{ cardId: string; seq: number; body: unknown }>;
    task?: TaskRow;
    /** Reserved task links the card still holds (what `listReservationsForCard` returns). */
    reservations?: Array<{ task_id: string }>;
  } = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), "stellar-close-conclusion-"));
  const state: Rig["state"] = { tasks: new Map(), upserts: [] };
  const task = overrides.task ?? baseTask("T", { card_id: null });
  state.tasks.set(task.id, { row: task, lastActor: "agent" });
  const links = overrides.links ?? [];
  const reports = overrides.reports ?? [];
  const closeRequests: Rig["closeRequests"] = [];

  const upsertTask = (t: TaskRow): StatusWriteDecision => {
    const transient = t as unknown as { actor?: StatusActor; actorCardId?: string | null; statusProposed?: boolean };
    const st = state.tasks.get(t.id);
    const decision = decideStatusWrite({
      previousActor: st?.lastActor ?? null,
      previousStatus: st?.row.status ?? null,
      proposedStatus: transient.statusProposed === false ? null : t.status,
      newActor: transient.actor ?? "agent",
      existingDivergedStatus: null,
      existingDivergedActor: null,
    });
    const row: TaskRow = { ...(st?.row ?? t), ...t, status: decision.status };
    const lastActor = decision.statusChanged ? (transient.actor ?? "agent") : (st?.lastActor ?? null);
    state.tasks.set(t.id, { row, lastActor });
    state.upserts.push({ id: t.id, status: decision.status, actor: transient.actor ?? null });
    return decision;
  };

  const liveImplementers = (taskId: string) =>
    links.filter((l) => l.task_id === taskId && l.role === "implementer" && !l.released);

  const callbacks = new Proxy(
    {
      listCards: () => [
        { id: "C", kind: "terminal", provider: "commandcode", cwd: WORK, label: null, displayName: "C" },
        { id: "O", kind: "terminal", provider: "commandcode", cwd: WORK, label: null, displayName: "O" },
      ],
      isCardAlive: () => true,
      getCardBoardId: (id: string) => (id === "C" || id === "O" || id === "98576172" ? "b1" : undefined),
      getBoardOrchestratorCardId: () => "O",
      isBoardAutonomous: () => true,
      describeCardLabel: (id: string) => id,
      getAnyCard: () => ({ boardId: "b1", kind: "terminal", provider: "commandcode" }),
      listReservationsForCard: () => overrides.reservations ?? [],
      listTaskCardsForCard: (cardId: string) =>
        links.filter((l) => l.card_id === cardId && !l.released) as unknown as TaskCardRow[],
      getTaskCards: (taskId: string) =>
        links.filter((l) => l.task_id === taskId && !l.released) as unknown as TaskCardRow[],
      listLiveImplementersForTask: (taskId: string) =>
        liveImplementers(taskId).map((l) => ({ card_id: l.card_id, reservation_state: l.reservation_state })),
      listTasks: () => [...state.tasks.values()].map((s) => s.row),
      getTask: (id: string) => state.tasks.get(id)?.row,
      getReport: (cardId: string, afterSeq?: number): ReportRow | undefined => {
        const rows = reports.filter((r) => r.cardId === cardId).sort((a, b) => a.seq - b.seq);
        if (afterSeq === undefined) return rows[rows.length - 1] as unknown as ReportRow | undefined;
        const next = rows.find((r) => r.seq > afterSeq);
        return next
          ? ({ card_id: cardId, seq: next.seq, report_json: JSON.stringify(next.body), verdict: null, role: null, channel: "socket", updated_at: next.seq } as unknown as ReportRow)
          : undefined;
      },
      upsertTask,
      releaseTaskCardFromTask: (input: { taskId: string; cardId: string; reason: string; releasedBy: string | null; actor: StatusActor; keepStatus?: boolean }) => {
        const l = links.find((x) => x.task_id === input.taskId && x.card_id === input.cardId && !x.released);
        if (!l) return { ok: false as const, error: "not a live participant" };
        l.released = true;
        const left = liveImplementers(input.taskId).length;
        let taskStatus: string | null = null;
        // Mirrors the store: with `keepStatus` the link is freed and the pointer
        // cleared, and no status is written.
        const principal = state.tasks.get(input.taskId);
        if (principal && principal.row.card_id === input.cardId) principal.row = { ...principal.row, card_id: null };
        if (input.keepStatus) {
          taskStatus = state.tasks.get(input.taskId)?.row.status ?? null;
        } else if (left === 0) {
          const st = state.tasks.get(input.taskId);
          if (st) {
            const decision = upsertTask({
              ...st.row,
              status: "pending",
              updated_at: Date.now(),
              actor: input.actor,
              actorCardId: input.releasedBy,
              statusProposed: true,
            });
            taskStatus = decision.status;
          }
        }
        return { ok: true as const, releasedAt: Date.now(), nextPrincipalCardId: null, liveImplementersLeft: left, taskStatus, statusHeld: false, declaredStatus: null };
      },
      onCloseCardRequest: (requestId: string, requesterId: string, target: string) => {
        closeRequests.push({ requestId, target, requesterId });
      },
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) },
  ) as Parameters<typeof createMessageBus>[1];

  const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { bus, dir, state, links, reports, closeRequests };
}

describe("close_card: conclusão exige report DA PRÓPRIA task (c10a1faf)", () => {
  let rig: Rig | null = null;
  afterEach(() => {
    rig?.bus.close();
    if (rig) rmSync(rig.dir, { recursive: true, force: true });
    rig = null;
  });

  async function closeAndConsent(r: Rig, target: string, requesterId: string, extra: Record<string, unknown> = {}) {
    const pending = r.bus.handleRequest({ cmd: "close_card", target, requesterId, ...extra } as BusRequest);
    await new Promise((res) => setTimeout(res, 20));
    if (r.closeRequests.length > 0) r.bus.resolveCloseCard(r.closeRequests[r.closeRequests.length - 1]!.requestId, true);
    return (await pending) as { ok: boolean; error?: string; concludedTasks?: string[]; releasedTasks?: string[] };
  }

  it("DEFEITO: card com report ok:true de OUTRA task NÃO conclui esta — fecha, solta o vínculo e o status fica pending", async () => {
    // O card C está ligado à task T (implementer) e tem um report ok:true que
    // é da task T2 (o slot responde por várias). Antes do conserto, o
    // `lastReportOk` do CARD assinava T como concluída.
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C")],
      reports: [{ cardId: "C", seq: 10, body: { ok: true, taskId: "T2" } }],
    });

    const res = await closeAndConsent(rig, "C", "O");

    expect(res.ok).toBe(true);
    expect(res.concludedTasks ?? []).toEqual([]);
    expect(res.releasedTasks).toEqual(["T"]);
    // The status was NOT touched and no upsert concluded T.
    expect(rig.state.tasks.get("T")!.row.status).toBe("pending");
    expect(rig.state.upserts.some((u) => u.id === "T" && u.status === "done")).toBe(false);
    // The link was released (the task waits for a card again).
    expect(rig.links.every((l) => l.released)).toBe(true);
    expect(rig.state.tasks.get("T")!.row.card_id ?? null).toBeNull();
    // Houve consentimento: nada foi solto antes dele.
    expect(rig.closeRequests).toHaveLength(1);
  });

  it("CASO MEDIDO 2 (explorador ligado por engano): o report é ANTERIOR ao vínculo — não conclui, solta o vínculo", async () => {
    // The explorer reported ok:true naming the task (t=500) and only THEN was linked
    // to it by mistake (t=1000). That report is not work of this round.
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C", { linked_at: 1000 })],
      reports: [{ cardId: "C", seq: 500, body: { ok: true, taskId: "T" } }],
    });

    const res = await closeAndConsent(rig, "C", "O");

    expect(res.ok).toBe(true);
    expect(res.concludedTasks ?? []).toEqual([]);
    expect(res.releasedTasks).toEqual(["T"]);
    expect(rig.state.tasks.get("T")!.row.status).toBe("pending");
    expect(rig.state.upserts.some((u) => u.id === "T" && u.status === "done")).toBe(false);
    expect(rig.links.every((l) => l.released)).toBe(true);
  });

  it("report ok:true ACEITO NA RODADA (depois do vínculo) segue concluindo — a intenção da regra", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C", { linked_at: 1000 })],
      reports: [
        { cardId: "C", seq: 500, body: { ok: true, taskId: "T" } }, // before the link: ignored
        { cardId: "C", seq: 2000, body: { ok: true, taskId: "T" } }, // na rodada: vale
      ],
    });
    const res = await closeAndConsent(rig, "C", "O");
    expect(res.ok).toBe(true);
    expect(res.concludedTasks).toEqual(["T"]);
    expect(res.releasedTasks ?? []).toEqual([]);
    expect(rig.state.tasks.get("T")!.row.status).toBe("done");
  });

  it("report ok:false na rodada NÃO conclui (o último report da task decide)", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C", { linked_at: 1000 })],
      reports: [
        { cardId: "C", seq: 2000, body: { ok: true, taskId: "T" } },
        { cardId: "C", seq: 3000, body: { ok: false, taskId: "T" } },
      ],
    });
    const res = await closeAndConsent(rig, "C", "O");
    expect(res.concludedTasks ?? []).toEqual([]);
    expect(rig.state.tasks.get("T")!.row.status).toBe("pending");
  });

  it("vínculo sem data (linha legada) não prova rodada: nada é concluído", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C", { linked_at: null })],
      reports: [{ cardId: "C", seq: 2000, body: { ok: true, taskId: "T" } }],
    });
    const res = await closeAndConsent(rig, "C", "O");
    expect(res.concludedTasks ?? []).toEqual([]);
    expect(res.releasedTasks).toEqual(["T"]);
    expect(rig.state.tasks.get("T")!.row.status).toBe("pending");
  });

  it("o card que fecha é REVISOR de task sem review exigido: não conclui, só fecha", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "I" }),
      links: [link("T", "I"), link("T", "C", { role: "reviewer" })],
      reports: [{ cardId: "C", seq: 2000, body: { ok: true, taskId: "T" } }],
    });
    const res = await closeAndConsent(rig, "C", "O");
    expect(res.ok).toBe(true);
    expect(res.concludedTasks ?? []).toEqual([]);
    expect(res.releasedTasks ?? []).toEqual([]);
    expect(rig.state.tasks.get("T")!.row.status).toBe("pending");
  });

  it("o PRÓPRIO implementer pedindo o fechamento sem report da rodada é recusado (não sai sozinho da task)", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C")],
      reports: [],
    });
    const res = await closeAndConsent(rig, "C", "C");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot leave a task by itself/);
    expect(rig.closeRequests).toEqual([]);
    expect(rig.links.every((l) => !l.released)).toBe(true);
  });

  it("CASO MEDIDO 1 (B11): task JÁ done + reserva do card + releaseReservations — o status segue done, nada vira pending", async () => {
    // The implementer card still holds a reservation of a task that was already
    // judged done. Releasing the reservation on close must not write `pending`
    // with the requesting card as author, reopening the task.
    rig = makeRig({
      task: baseTask("B11", { status: "done", card_id: "C" }),
      links: [link("B11", "C", { reservation_state: "reserved" })],
      reservations: [{ task_id: "B11" }],
    });
    const res = await closeAndConsent(rig, "C", "O", { releaseReservations: true });

    expect(res.ok).toBe(true);
    expect(rig.state.tasks.get("B11")!.row.status).toBe("done");
    expect(rig.state.upserts.filter((u) => u.id === "B11")).toEqual([]);
    // The link was released and the principal pointer cleared, status untouched.
    expect(rig.links.every((l) => l.released)).toBe(true);
    expect(rig.state.tasks.get("B11")!.row.card_id ?? null).toBeNull();
  });

  it("task done ligada ao card que fecha não é tocada pelo fechamento (nem concluída, nem reaberta)", async () => {
    rig = makeRig({
      task: baseTask("B11", { status: "done", card_id: "C" }),
      links: [link("B11", "C")],
      reports: [],
    });
    const res = await closeAndConsent(rig, "C", "O");
    expect(res.ok).toBe(true);
    expect(res.concludedTasks ?? []).toEqual([]);
    expect(res.releasedTasks ?? []).toEqual([]);
    expect(rig.state.tasks.get("B11")!.row.status).toBe("done");
    expect(rig.state.upserts.filter((u) => u.id === "B11")).toEqual([]);
  });

  it("LEGÍTIMO: report ok:true DA PRÓPRIA task conclui com o fechamento (actor app)", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C")],
      reports: [{ cardId: "C", seq: 10, body: { ok: true, taskId: "T" } }],
    });

    const pending = rig.bus.handleRequest({ cmd: "close_card", target: "C", requesterId: "O" } as BusRequest);
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.closeRequests).toHaveLength(1);
    rig.bus.resolveCloseCard(rig.closeRequests[0]!.requestId, true);
    const res = (await pending) as { ok: boolean; concludedTasks?: string[] };

    expect(res.ok).toBe(true);
    expect(res.concludedTasks).toEqual(["T"]);
    const st = rig.state.tasks.get("T")!;
    expect(st.row.status).toBe("done");
    // O done do FECHAMENTO é cerimônia do APP, não julgamento do orquestrador.
    const doneUpsert = rig.state.upserts.find((u) => u.id === "T" && u.status === "done");
    expect(doneUpsert?.actor).toBe("app");
    expect(st.lastActor).toBe("app");
  });

  it("ITEM 3: o orquestrador REVERTE um done escrito pelo close (não fica retido como status humano)", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C")],
      reports: [{ cardId: "C", seq: 10, body: { ok: true, taskId: "T" } }],
    });

    // 1) close conclui a task (actor app).
    const pendingClose = rig.bus.handleRequest({ cmd: "close_card", target: "C", requesterId: "O" } as BusRequest);
    await new Promise((r) => setTimeout(r, 20));
    rig.bus.resolveCloseCard(rig.closeRequests[0]!.requestId, true);
    await pendingClose;
    expect(rig.state.tasks.get("T")!.row.status).toBe("done");

    // 2) O orquestrador reverte para pending. Antes do conserto, o done com
    // actor `orchestrator` era autoritativo e RETINHA esta escrita (o write de
    // `pending` é carimbado `agent`), com "the human status done prevails".
    const revert = (await rig.bus.handleRequest({ cmd: "update_task", taskId: "T", status: "pending", requesterId: "O" } as BusRequest)) as {
      ok: boolean;
      status?: string;
      warning?: string;
    };
    expect(revert.ok).toBe(true);
    expect(revert.warning).toBeUndefined();
    expect(revert.status).toBe("pending");
    expect(rig.state.tasks.get("T")!.row.status).toBe("pending");
  });

  it("ITEM 4a: ligada → `update_task cardId:null` desliga de verdade → card fecha e a task continua pending", async () => {
    rig = makeRig({
      task: baseTask("T", { card_id: "C" }),
      links: [link("T", "C")],
      reports: [], // nenhum report — o card nem começou
    });

    // O desligamento (o mesmo do defeito medido).
    const detached = (await rig.bus.handleRequest({ cmd: "update_task", taskId: "T", cardId: null, requesterId: "O" } as BusRequest)) as { ok: boolean };
    expect(detached.ok).toBe(true);
    // O vínculo VIVO foi liberado (não só o ponteiro `card_id`).
    expect(rig.links.every((l) => l.released)).toBe(true);
    expect(rig.state.tasks.get("T")!.row.card_id ?? null).toBeNull();

    // Agora o close não acha mais a task: fecha sem concluir.
    const pendingClose = rig.bus.handleRequest({ cmd: "close_card", target: "C", requesterId: "O" } as BusRequest);
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.closeRequests).toHaveLength(1);
    rig.bus.resolveCloseCard(rig.closeRequests[0]!.requestId, true);
    const res = (await pendingClose) as { ok: boolean; concludedTasks?: string[] };

    expect(res.ok).toBe(true);
    expect(res.concludedTasks ?? []).toEqual([]);
    expect(rig.state.tasks.get("T")!.row.status).toBe("pending");
  });
});

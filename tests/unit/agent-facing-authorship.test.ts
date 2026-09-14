import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatAgentFacingAuthorship,
  hasAgentFacingAuthorPrefix,
  REPORT_AVAILABLE_POINTER_BODY,
  unreportedExitPointerBody,
} from "../../src/main/agent-facing-authorship";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

describe("formatAgentFacingAuthorship — uma forma só", () => {
  it("texto sem prefixo ganha um", () => {
    expect(formatAgentFacingAuthorship("aviso-de-report", "Fix pronto")).toBe(
      "[de: aviso-de-report] Fix pronto",
    );
  });

  it("texto que já traz autoria não ganha o segundo", () => {
    const already = "[de: aviso-de-report] Fix pronto";
    expect(formatAgentFacingAuthorship("aviso-de-report", already)).toBe(already);
    expect(formatAgentFacingAuthorship("outro", already)).toBe(already);
  });

  it("sem from: corpo intacto", () => {
    expect(formatAgentFacingAuthorship(null, "echo hi")).toBe("echo hi");
    expect(formatAgentFacingAuthorship(undefined, "echo hi")).toBe("echo hi");
    expect(formatAgentFacingAuthorship("", "echo hi")).toBe("echo hi");
  });

  it("ponteiro de relatório e send produzem a MESMA forma de autoria", () => {
    const label = "Child One";
    const viaSend = formatAgentFacingAuthorship(label, "olá do send");
    const viaReport = formatAgentFacingAuthorship(label, REPORT_AVAILABLE_POINTER_BODY);
    const viaExit = formatAgentFacingAuthorship(label, unreportedExitPointerBody(1));

    expect(viaSend.startsWith(`[de: ${label}] `)).toBe(true);
    expect(viaReport).toBe(`[de: ${label}] ${REPORT_AVAILABLE_POINTER_BODY}`);
    expect(viaExit).toBe(`[de: ${label}] ${unreportedExitPointerBody(1)}`);
    // Same constructor → same prefix shape (not two hand-rolled templates).
    expect(viaSend.slice(0, `[de: ${label}]`.length)).toBe(viaReport.slice(0, `[de: ${label}]`.length));
    expect(viaSend.slice(0, `[de: ${label}]`.length)).toBe(viaExit.slice(0, `[de: ${label}]`.length));
  });

  it("hasAgentFacingAuthorPrefix reconhece a convenção", () => {
    expect(hasAgentFacingAuthorPrefix("[de: X] corpo")).toBe(true);
    expect(hasAgentFacingAuthorPrefix("[de: Bash 2°] x")).toBe(true);
    expect(hasAgentFacingAuthorPrefix("sem prefixo")).toBe(false);
    expect(hasAgentFacingAuthorPrefix("de: falso")).toBe(false);
  });
});

describe("message-bus: send e ponteiro de report usam a mesma forma; sem dedupe cego", () => {
  let dir: string | undefined;
  let bus: ReturnType<typeof createMessageBus> | undefined;

  afterEach(() => {
    bus?.close();
    bus = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  type FakeReportRow = { card_id: string; seq: number; report_json: string; updated_at: number };

  /** Same Proxy double as message-bus-report-notify: missing hooks are
   * no-ops, and `hasOwnProperty` stays false so deliverCard uses
   * `writeToCard` (not the optional origin path). */
  function callbacksWithOverrides(
    overrides: Record<string, (...args: never[]) => unknown>,
  ): Parameters<typeof createMessageBus>[1] {
    const reportsByCard = new Map<string, FakeReportRow[]>();
    const reportDefaults: Record<string, (...args: never[]) => unknown> = {
      getReport: ((cardId: string, afterSeq?: number) => {
        const rows = reportsByCard.get(cardId) ?? [];
        if (afterSeq === undefined) return rows.length ? rows[rows.length - 1] : undefined;
        return rows.find((r) => r.seq > afterSeq);
      }) as never,
      upsertReport: ((row: FakeReportRow) => {
        const rows = reportsByCard.get(row.card_id) ?? [];
        rows.push(row);
        reportsByCard.set(row.card_id, rows);
      }) as never,
      nextReportSeqSeed: (() => 0) as never,
      listTasks: (() => []) as never,
      listTaskCardsForCard: (() => []) as never,
    };
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => overrides[prop] ?? reportDefaults[prop] ?? (() => undefined),
      },
    ) as Parameters<typeof createMessageBus>[1];
  }

  function makeDeliveryBus(overrides: Record<string, (...args: never[]) => unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), "stellar-authorship-"));
    const written: Array<[string, string]> = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: () => [
          { id: "spawner-1", kind: "terminal", provider: "claude", cwd: "", label: "MASTER", displayName: "MASTER" },
          { id: "child-1", kind: "terminal", provider: "cursor", cwd: "", label: "aviso-de-report", displayName: "aviso-de-report" },
          { id: "target", kind: "terminal", provider: "claude", cwd: "", label: null, displayName: "Claude" },
        ],
        writeToCard: (...args: unknown[]) => written.push(args as [string, string]),
        isCardAlive: () => true,
        getCardWriteReadiness: () => null,
        onReadCardRequest: ((requestId: string) =>
          bus?.resolveReadCard(requestId, { ok: true, text: "" })) as never,
        describeCardLabel: ((id: string) =>
          id === "child-1" ? "aviso-de-report" : id === "spawner-1" ? "MASTER" : id) as never,
        listAllConnectors: (() => [
          { kind: "spawned", from_card_id: "spawner-1", to_card_id: "child-1", updated_at: Date.now() },
        ]) as never,
        ...overrides,
      }),
    );
    return { bus: bus!, written };
  }

  async function waitForBodies(written: Array<[string, string]>, min: number, timeoutMs = 4000): Promise<string[]> {
    const start = Date.now();
    for (;;) {
      const bodies = written.filter(([, data]) => data !== "\r").map(([, data]) => data);
      if (bodies.length >= min) return bodies;
      if (Date.now() - start >= timeoutMs) return bodies;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  it("send: corpo sem prefixo ganha um; corpo já autorado não ganha o segundo", async () => {
    const { bus: b, written } = makeDeliveryBus();

    await b.handleRequest({
      cmd: "send",
      target: "target",
      text: "Fix pronto",
      requesterId: "child-1",
    } as BusRequest);
    await b.handleRequest({
      cmd: "send",
      target: "target",
      text: "[de: aviso-de-report] Fix pronto (já carimbado)",
      requesterId: "child-1",
    } as BusRequest);

    const bodies = await waitForBodies(written, 2);
    expect(bodies[0]).toBe("[de: aviso-de-report] Fix pronto");
    expect(bodies[1]).toBe("[de: aviso-de-report] Fix pronto (já carimbado)");
    expect(bodies[1].match(/\[de:/g)?.length).toBe(1);
  });

  it("ponteiro de report e send usam a mesma forma `[de: label] …`", async () => {
    const { bus: b, written } = makeDeliveryBus();

    await b.handleRequest({
      cmd: "send",
      target: "spawner-1",
      text: "ping",
      requesterId: "child-1",
    } as BusRequest);
    await b.handleRequest({
      cmd: "report",
      requesterId: "child-1",
      report: { ok: true },
    } as BusRequest);

    const bodies = await waitForBodies(written, 2);
    const sendLine = bodies.find((t) => t.includes("ping"));
    const pointerLine = bodies.find((t) => t.includes(REPORT_AVAILABLE_POINTER_BODY));
    expect(sendLine).toBe("[de: aviso-de-report] ping");
    expect(pointerLine).toBe(`[de: aviso-de-report] ${REPORT_AVAILABLE_POINTER_BODY}`);
    expect(sendLine!.startsWith("[de: aviso-de-report] ")).toBe(true);
    expect(pointerLine!.startsWith("[de: aviso-de-report] ")).toBe(true);
  });

  it("caso 469: duas entregas byte-a-byte idênticas continuam as duas (sem dedupe de conteúdo)", async () => {
    // Card 469 seq 222+223: agent re-sent the same report pointer on purpose
    // via another channel. Content+target+window dedupe would have eaten the
    // second. Identity is the delivery id — both must land.
    const { bus: b, written } = makeDeliveryBus();
    const twin = "[de: aviso-de-report] mesmo bytes de propósito";

    const a = (await b.handleRequest({
      cmd: "send",
      target: "spawner-1",
      text: twin,
      requesterId: "child-1",
    } as BusRequest)) as { id: string };
    const c = (await b.handleRequest({
      cmd: "send",
      target: "spawner-1",
      text: twin,
      requesterId: "child-1",
    } as BusRequest)) as { id: string };

    expect(a.id).not.toBe(c.id);
    const bodies = await waitForBodies(written, 2);
    const twins = bodies.filter((t) => t === twin);
    expect(twins).toHaveLength(2);
  });
});

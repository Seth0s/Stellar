import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NOTICE } from "../../src/main/agent-facing-notices";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Approving a prototype tells the card that does the work to go on — and says
 * plainly that this is NOT the approval of the task. If that card cannot read a
 * typed line (dead, or a plain shell), the board's orchestrator is told instead.
 */

function callbacksWithOverrides(
  overrides: Record<string, (...args: never[]) => unknown>,
): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    { get: (_target, prop: string) => overrides[prop] ?? (() => undefined) },
  ) as Parameters<typeof createMessageBus>[1];
}

const card = (id: string, provider = "claude") => ({
  id,
  kind: "terminal",
  provider,
  cwd: "",
  label: id,
  displayName: id,
});

let bus: ReturnType<typeof createMessageBus> | null = null;
let dir: string | null = null;

afterEach(() => {
  bus?.close();
  bus = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function makeBus(
  cards: ReturnType<typeof card>[],
  alive: Set<string>,
  orchestrator: string | null,
) {
  dir = mkdtempSync(join(tmpdir(), "stellar-proto-approval-"));
  bus = createMessageBus(
    join(dir, "agent-canvas.sock"),
    callbacksWithOverrides({
      listCards: () => cards,
      isCardAlive: (id: string) => alive.has(id),
      getCardBoardId: () => "b1",
      getBoardOrchestratorCardId: () => orchestrator,
      listAllConnectors: () => [],
      writeToCard: () => undefined,
      beginCardDelivery: () => true,
      getCardWriteReadiness: () => ({
        spawnedAtMs: Date.now() - 1_000,
        hasReceivedData: true,
        lastActivityAtMs: Date.now() - 1_000,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
      }),
      getCardLastActivityAt: () => Date.now(),
    }),
  );
  return bus;
}

async function deliveriesTo(target: string): Promise<{ id: string; text?: string }[]> {
  const res = (await bus!.handleRequest({
    cmd: "list_deliveries",
    target,
  } as BusRequest)) as unknown as {
    deliveries: { id: string; text?: string; message?: string }[];
  };
  return res.deliveries.map((d) => ({ id: d.id, text: d.text ?? d.message }));
}

describe("notifyPrototypeApproved", () => {
  const input = {
    taskId: "a550a7ae-aaaa-4000-8000-000000000015",
    path: "fila.dc.html",
    boardId: "b1",
  };

  it("the line it types names the file and the task, and is not the task's approval", () => {
    const line = APP_NOTICE.prototypeApproved(input);
    expect(line).toContain("fila.dc.html");
    expect(line).toContain("task a550a7ae");
    expect(line).toContain("does not approve the task");
    expect(line).toContain("final report");
    expect(line.includes("\n")).toBe(false);
  });

  it("tells the implementer card, once", async () => {
    const b = makeBus([card("impl"), card("orch")], new Set(["impl", "orch"]), "orch");
    expect(b.notifyPrototypeApproved({ ...input, cardIds: ["impl"] })).toBe("impl");
    const sent = await deliveriesTo("impl");
    expect(sent).toHaveLength(1);
    expect(await deliveriesTo("orch")).toHaveLength(0);
  });

  it("falls back to the orchestrator when the implementer is gone or a plain shell", async () => {
    const dead = makeBus([card("impl"), card("orch")], new Set(["orch"]), "orch");
    expect(dead.notifyPrototypeApproved({ ...input, cardIds: ["impl"] })).toBe("orch");
    expect(await deliveriesTo("orch")).toHaveLength(1);
    bus?.close();
    rmSync(dir!, { recursive: true, force: true });
    const shell = makeBus([card("impl", "bash"), card("orch")], new Set(["impl", "orch"]), "orch");
    expect(shell.notifyPrototypeApproved({ ...input, cardIds: ["impl"] })).toBe("orch");
    expect(await deliveriesTo("impl")).toHaveLength(0);
  });

  it("returns null when nobody can read it (the approval stays on the task)", () => {
    const b = makeBus([card("impl")], new Set(), null);
    expect(b.notifyPrototypeApproved({ ...input, cardIds: ["impl"] })).toBeNull();
  });
});

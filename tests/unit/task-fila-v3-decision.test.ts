import { describe, expect, it } from "vitest";
import {
  QUEUE_COLUMN_ORDER,
  columnForQueueTask,
  countQueueFilter,
  decideColumnRails,
  deriveAgoraBanner,
  deriveTileStatusPhrase,
  filterByQueueFilter,
  isDoneToday,
  summarizeRecentAction,
  taskNeedsYou,
  tileShowsLiveActivity,
  type QueueColumn,
  type QueueTaskFacts,
} from "../../src/renderer/src/task-fila-v3-decision";

function facts(partial: Partial<QueueTaskFacts> & Pick<QueueTaskFacts, "phase">): QueueTaskFacts {
  return {
    status: "pending",
    cardAlive: false,
    blockedQuestion: null,
    requestedStatus: null,
    review: null,
    cards: [],
    ...partial,
  };
}

describe("columnForQueueTask (DADOS §3)", () => {
  it("puts blockedQuestion and requestedStatus in waiting ahead of phase", () => {
    expect(columnForQueueTask(facts({ phase: "running", cardAlive: true, blockedQuestion: { text: "x" } }))).toBe("waiting");
    expect(columnForQueueTask(facts({ phase: "ready", requestedStatus: "done" }))).toBe("waiting");
    expect(columnForQueueTask(facts({ phase: "waiting_deps" }))).toBe("waiting");
  });

  it("maps ready/reserved to ready and running+alive to running", () => {
    expect(columnForQueueTask(facts({ phase: "ready" }))).toBe("ready");
    expect(columnForQueueTask(facts({ phase: "reserved" }))).toBe("ready");
    expect(columnForQueueTask(facts({ phase: "running", cardAlive: true }))).toBe("running");
  });

  it("sends running with a dead card to ready, never running", () => {
    expect(columnForQueueTask(facts({ phase: "running", cardAlive: false }))).toBe("ready");
  });

  it("maps review/done/failed/superseded", () => {
    expect(columnForQueueTask(facts({ phase: "awaiting_review" }))).toBe("review");
    expect(columnForQueueTask(facts({ phase: "changes_requested" }))).toBe("review");
    expect(columnForQueueTask(facts({ phase: "done" }))).toBe("done");
    expect(columnForQueueTask(facts({ phase: "failed" }))).toBe("failed");
    expect(columnForQueueTask(facts({ phase: "superseded" }))).toBe("superseded");
  });
});

describe("deriveTileStatusPhrase (DADOS §4)", () => {
  it("prefers blockedQuestion and requestedStatus", () => {
    expect(deriveTileStatusPhrase(facts({ phase: "running", cardAlive: true, blockedQuestion: {} }))).toBe("Espera sua resposta");
    expect(deriveTileStatusPhrase(facts({ phase: "ready", requestedStatus: "done" }))).toBe(
      "Pausada até você liberar",
    );
  });

  it("formats waiting_deps and reserved", () => {
    expect(
      deriveTileStatusPhrase(
        facts({ phase: "waiting_deps", deps: ["0c8694c7-aaaa"], depTitles: { "0c8694c7-aaaa": "R1" } }),
      ),
    ).toBe("Depois de #0c8694c7 R1");
    expect(
      deriveTileStatusPhrase(facts({ phase: "reserved", cards: [{ role: "implementer", label: "IMPL · Claude" }] })),
    ).toBe("Reservada para IMPL · Claude");
  });

  it("uses measured recentAction for running, else trabalhando", () => {
    expect(
      deriveTileStatusPhrase(
        facts({
          phase: "running",
          cardAlive: true,
          cards: [{ role: "implementer", label: "IMPL · Claude" }],
          recentAction: "escrevendo testes",
        }),
      ),
    ).toBe("IMPL · Claude escrevendo testes");
    expect(
      deriveTileStatusPhrase(
        facts({ phase: "running", cardAlive: true, cards: [{ role: "implementer", label: "EXPLORER" }] }),
      ),
    ).toBe("EXPLORER trabalhando");
  });

  it("names dead running as card encerrou sem report", () => {
    expect(deriveTileStatusPhrase(facts({ phase: "running", cardAlive: false }))).toBe("card encerrou sem report");
  });

  it("formats superseded with optional concluída", () => {
    expect(deriveTileStatusPhrase(facts({ phase: "superseded", supersededBy: "faae5162-xxxx" }))).toBe("→ #faae5162");
    expect(
      deriveTileStatusPhrase(facts({ phase: "superseded", supersededBy: "faae5162-xxxx", supersededTargetDone: true })),
    ).toBe("→ #faae5162 concluída");
  });

  it("contracts done approver as pelo revisor / pelo Master / por você", () => {
    expect(
      deriveTileStatusPhrase(facts({ phase: "done", approverLabel: "revisor", rounds: 2 })),
    ).toBe("✓ aprovada pelo revisor · 2 rodadas");
    expect(
      deriveTileStatusPhrase(facts({ phase: "done", approverLabel: "Master", rounds: 4 })),
    ).toBe("✓ aprovada pelo Master · 4 rodadas");
    expect(
      deriveTileStatusPhrase(facts({ phase: "done", approverLabel: "Master", rounds: 1 })),
    ).toBe("✓ aprovada pelo Master · 1 rodada");
    expect(deriveTileStatusPhrase(facts({ phase: "done" }))).toBe("✓ aprovada por você");
  });
});

describe("deriveAgoraBanner (DADOS §5)", () => {
  const now = 1_000_000;

  it("builds the running blue band", () => {
    const banner = deriveAgoraBanner(
      facts({
        phase: "running",
        cardAlive: true,
        cards: [{ role: "implementer", label: "IMPL · Claude" }],
        lastActivityAgeMs: 40_000,
        contextPercent: 34,
        hasReportThisRound: false,
      }),
      now,
    );
    expect(banner?.variant).toBe("blue");
    expect(banner?.title).toBe("IMPL · Claude está trabalhando");
    expect(banner?.actions.map((a) => a.label)).toEqual(["Abrir o card", "Pedir status"]);
  });

  it("suggests Medir de novo when the red is outside territory", () => {
    const banner = deriveAgoraBanner(
      facts({
        phase: "awaiting_review",
        gateRun: { ok: false, failedCommand: "npm run check:types", isolation: { undeclaredInTerritory: ["a.ts", "b.ts"] } },
        gateRedOutsideTerritory: true,
        gateFailedFilesOutside: 2,
      }),
      now,
    );
    expect(banner?.variant).toBe("amber-alert");
    expect(banner?.actions.map((a) => a.label)).toEqual(["Medir de novo", "Revisar"]);
  });

  it("opens the successor for superseded", () => {
    const banner = deriveAgoraBanner(
      facts({ phase: "superseded", supersededBy: "878514a8-xxxx", supersededTitle: "R4", supersededReason: "dep errada" }),
      now,
    );
    expect(banner?.variant).toBe("neutral");
    expect(banner?.actions[0]?.label).toBe("Abrir a nova task");
  });
});

describe("taskNeedsYou / filters (DADOS §6)", () => {
  it("counts only blocked, status-ask, and human review without reviewer", () => {
    const list = [
      facts({ phase: "running", cardAlive: true, blockedQuestion: {} }),
      facts({ phase: "ready", requestedStatus: "done" }),
      facts({ phase: "awaiting_review", review: "wanted", cards: [] }),
      facts({ phase: "awaiting_review", review: "wanted", cards: [{ role: "reviewer" }] }),
      facts({ phase: "running", cardAlive: true }),
    ];
    expect(list.filter(taskNeedsYou)).toHaveLength(3);
    expect(countQueueFilter(list, "needsYou")).toBe(3);
    expect(countQueueFilter(list, "liveAgent")).toBe(1);
    expect(filterByQueueFilter(list, "liveAgent")).toHaveLength(1);
  });

  it("includes review=wanted while still in Pronta (ready)", () => {
    expect(taskNeedsYou(facts({ phase: "ready", review: "wanted", cards: [] }))).toBe(true);
    expect(taskNeedsYou(facts({ phase: "ready", review: "wanted", cards: [{ role: "reviewer" }] }))).toBe(false);
  });

  it("Tudo excludes superseded and archived done (Fila.dc.html Tudo 14)", () => {
    const now = Date.parse("2026-10-09T18:00:00Z");
    const list = [
      facts({ phase: "waiting_deps" }),
      facts({ phase: "ready" }),
      facts({ phase: "running", cardAlive: true }),
      facts({ phase: "awaiting_review" }),
      facts({ phase: "done", updatedAt: now - 3_600_000 }),
      facts({ phase: "done", updatedAt: now - 2 * 86_400_000 }),
      facts({ phase: "failed" }),
      facts({ phase: "superseded" }),
    ];
    expect(countQueueFilter(list, "all", now)).toBe(6);
  });
});

describe("tileShowsLiveActivity / isDoneToday / summarizeRecentAction", () => {
  it("shows live only for running alive without blocked ask", () => {
    expect(tileShowsLiveActivity(facts({ phase: "running", cardAlive: true }))).toBe(true);
    expect(tileShowsLiveActivity(facts({ phase: "running", cardAlive: true, blockedQuestion: {} }))).toBe(false);
  });

  it("detects done today from local midnight", () => {
    const now = Date.parse("2026-10-09T15:00:00");
    expect(isDoneToday(Date.parse("2026-10-09T01:00:00"), now)).toBe(true);
    expect(isDoneToday(Date.parse("2026-10-08T23:00:00"), now)).toBe(false);
  });

  it("summarizes a tool line from the output tail without inventing", () => {
    expect(summarizeRecentAction(null)).toBeNull();
    expect(summarizeRecentAction("noise\n● Read(useTerminal.ts)\nok")).toBe("Read(useTerminal.ts)");
  });
});

describe("decideColumnRails (Fila v3.1)", () => {
  const fullCounts = Object.fromEntries(QUEUE_COLUMN_ORDER.map((c) => [c, 2])) as Record<QueueColumn, number>;

  it("opens every column with content when the board is wide enough", () => {
    const rails = decideColumnRails({
      availableWidth: 1700,
      counts: fullCounts,
      userCollapsed: new Set(),
      userExpanded: new Set(),
    });
    expect([...rails]).toEqual([]);
  });

  it("born-collapses empty columns unless the user expanded them", () => {
    const counts = { ...fullCounts, running: 0, review: 0 };
    const born = decideColumnRails({
      availableWidth: 1700,
      counts,
      userCollapsed: new Set(),
      userExpanded: new Set(),
    });
    expect(born.has("running")).toBe(true);
    expect(born.has("review")).toBe(true);
    expect(born.has("waiting")).toBe(false);

    const expanded = decideColumnRails({
      availableWidth: 1700,
      counts,
      userCollapsed: new Set(),
      userExpanded: new Set<QueueColumn>(["running"]),
    });
    expect(expanded.has("running")).toBe(false);
    expect(expanded.has("review")).toBe(true);
  });

  it("collapses from the right when the card is 1200 / 800 wide", () => {
    // Exact 1200 fills open columns; Concluida must still become a rail.
    const atExact1200 = decideColumnRails({
      availableWidth: 1200,
      counts: fullCounts,
      userCollapsed: new Set(),
      userExpanded: new Set(),
    });
    expect(atExact1200.has("done")).toBe(true);
    expect(atExact1200.has("failed")).toBe(true);
    expect(atExact1200.has("superseded")).toBe(true);

    const at1200 = decideColumnRails({
      availableWidth: 1164,
      counts: fullCounts,
      userCollapsed: new Set(),
      userExpanded: new Set(),
    });
    expect(at1200.has("superseded")).toBe(true);
    expect(at1200.has("failed")).toBe(true);
    expect(at1200.has("done")).toBe(true);
    expect(at1200.has("waiting")).toBe(false);
    expect(at1200.has("ready")).toBe(false);

    const at800 = decideColumnRails({
      availableWidth: 764,
      counts: fullCounts,
      userCollapsed: new Set(),
      userExpanded: new Set(),
    });
    expect(at800.has("running")).toBe(true);
    expect(at800.has("review")).toBe(true);
    expect(at800.has("waiting")).toBe(false);
    expect(at800.has("ready")).toBe(false);
  });

  it("honours user-collapsed even when the board is wide", () => {
    const rails = decideColumnRails({
      availableWidth: 1700,
      counts: fullCounts,
      userCollapsed: new Set<QueueColumn>(["ready"]),
      userExpanded: new Set(),
    });
    expect(rails.has("ready")).toBe(true);
    expect(rails.has("waiting")).toBe(false);
  });
});

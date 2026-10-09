import { describe, expect, it } from "vitest";
import {
  columnForQueueTask,
  countQueueFilter,
  deriveAgoraBanner,
  deriveTileStatusPhrase,
  filterByQueueFilter,
  isDoneToday,
  summarizeRecentAction,
  taskNeedsYou,
  tileShowsLiveActivity,
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

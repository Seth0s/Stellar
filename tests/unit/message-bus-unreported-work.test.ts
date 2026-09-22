import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { CoverageSession } from "../../src/main/unreported-work-decision";

/**
 * A CONFRONTAÇÃO como COMANDO (task 5d47312c) — "o card trabalhou e não deixou
 * rastro" tem de ser DETECTÁVEL.
 *
 * Antes deste comando NÃO EXISTIA pergunta nenhuma: `reports` diz quem contou,
 * `spawns` diz quem nasceu, os stores dos harnesses dizem onde houve sessão — e
 * ninguém cruzava os três. Medido no board vivo: 234 cards em `spawns`, 100 sem
 * relatório, 23 deles com sessão de harness começando até 15min depois do
 * nascimento. Cinco cards morreram por cota no meio do trabalho e deixaram 2031
 * linhas não commitadas sem uma linha de relatório; o dono descobriu lendo
 * `git status` horas depois, à mão.
 *
 * ESTE ARQUIVO NASCEU VERMELHO: o cmd `unreported_work` não existia (o bus
 * respondia `unknown cmd`). As fontes de I/O são costuras injetadas
 * (`listCoverageCards` / `discoverCoverageSessions`), como todo o resto deste
 * arquivo já faz — o teste não toca disco de harness nenhum.
 */
function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === "listAllConnectors") return () => [];
        if (prop === "listCards") return () => [];
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("cmd unreported_work — o card que trabalhou sem deixar rastro", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A FORMA que o store devolve (`listCoverageCards`), não a já decidida: o
   * cmd é quem deriva `hasReport`/`storeDeclared`/`clock` — é justamente o que
   * este arquivo mede. */
  type Source = {
    cardId: string;
    provider: string;
    cwd: string | null;
    createdAtMs: number;
    taskId: string | null;
    reportCount: number;
    live: number;
  };

  function rig(opts: {
    cards: Source[];
    sessions?: Record<string, CoverageSession[]>;
    orphanReports?: number;
  }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-unreported-"));
    const discovered: string[] = [];
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCoverageCards: (() => opts.cards) as never,
        discoverCoverageSessions: ((provider: string, cwd: string) => {
          discovered.push(`${provider}|${cwd}`);
          return opts.sessions?.[`${provider}|${cwd}`] ?? [];
        }) as never,
        countOrphanReports: (() => opts.orphanReports ?? 0) as never,
      }),
    );
    return { discovered };
  }

  const card = (over: Partial<Source> = {}): Source => ({
    cardId: "c1",
    provider: "claude",
    cwd: "/repo",
    createdAtMs: 1_000_000,
    taskId: null,
    reportCount: 0,
    live: 0,
    ...over,
  });

  it("card com sessão no store e SEM relatório aparece como worked_unreported", async () => {
    const { discovered } = rig({
      cards: [card({ cardId: "silencioso" })],
      sessions: { "claude|/repo": [{ sessionId: "s-a", timestampMs: 1_010_000, sizeBytes: 4096 }] },
    });
    const res = (await bus!.handleRequest({ cmd: "unreported_work" } as BusRequest)) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    const counts = res.counts as Record<string, number>;
    expect(counts.worked_unreported).toBe(1);
    const findings = res.findings as Record<string, unknown>[];
    expect(findings[0].cardId).toBe("silencioso");
    expect(findings[0].sessionId).toBe("s-a");
    expect(findings[0].sizeBytes).toBe(4096);
    expect(String(findings[0].why)).toMatch(/not in this data/i);
    // Varredura por STORE, não por card.
    expect(discovered).toEqual(["claude|/repo"]);
  });

  it("card com relatório NÃO aparece (nada a dizer quando o rastro existe)", async () => {
    rig({ cards: [card({ cardId: "contou", reportCount: 1 })], sessions: { "claude|/repo": [] } });
    const res = (await bus!.handleRequest({ cmd: "unreported_work" } as BusRequest)) as Record<string, unknown>;
    expect((res.counts as Record<string, number>).worked_unreported).toBe(0);
    expect((res.findings as unknown[]).length).toBe(0);
  });

  it("provider sem store declarado é unobservable, nunca acusado", async () => {
    const { discovered } = rig({ cards: [card({ provider: "misterio" })] });
    const res = (await bus!.handleRequest({ cmd: "unreported_work" } as BusRequest)) as Record<string, unknown>;
    const findings = res.findings as Record<string, unknown>[];
    expect(findings[0].verdict).toBe("unobservable");
    // Não se varre o disco de um provider que não declara onde guarda nada.
    expect(discovered).toEqual([]);
  });

  it("sessão VELHA demais não é atribuída: o card fica no_session, não culpado", async () => {
    rig({
      cards: [card({ cardId: "velho" })],
      // 1h depois do nascimento: fora da janela medida de 15min.
      sessions: { "claude|/repo": [{ sessionId: "s-tarde", timestampMs: 1_000_000 + 3_600_000, sizeBytes: 10 }] },
    });
    const res = (await bus!.handleRequest({ cmd: "unreported_work" } as BusRequest)) as Record<string, unknown>;
    const findings = res.findings as Record<string, unknown>[];
    expect(findings[0].verdict).toBe("no_session");
    expect(String(findings[0].why)).toMatch(/cannot be accused/);
  });

  it("um store por (provider, cwd), não um por card — o custo é o da varredura", async () => {
    const { discovered } = rig({
      cards: [
        card({ cardId: "a", createdAtMs: 1_000_000 }),
        card({ cardId: "b", createdAtMs: 2_000_000 }),
        card({ cardId: "c", provider: "codex", cwd: "/repo2", createdAtMs: 3_000_000 }),
      ],
      sessions: {},
    });
    await bus!.handleRequest({ cmd: "unreported_work" } as BusRequest);
    expect(discovered.sort()).toEqual(["claude|/repo", "codex|/repo2"]);
  });

  it("a captura errada é DECLARADA no resultado, não escondida", async () => {
    rig({ cards: [card({ cardId: "x" })], sessions: {}, orphanReports: 139 });
    const res = (await bus!.handleRequest({ cmd: "unreported_work" } as BusRequest)) as Record<string, unknown>;
    expect(res.misattributionSuspected).toBe(true);
    expect(res.orphanReports).toBe(139);
  });
});

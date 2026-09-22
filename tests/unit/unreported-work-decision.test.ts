import { describe, it, expect } from "vitest";
import {
  COVERAGE_ATTRIBUTION_WINDOW_MS,
  attributeSessionsToCards,
  clockFromSessionStore,
  decideUnreportedWork,
  type CoverageCard,
} from "../../src/main/unreported-work-decision";

/**
 * A decisão da confrontação, pura (task 5d47312c).
 *
 * O ERRO QUE A PRIMEIRA MEDIÇÃO COMETEU, e que estes testes pinam: casar
 * "candidato posterior ao nascimento" atribui a sessão de um card mais NOVO a
 * TODOS os cards mais velhos do mesmo store. Medido no board vivo com essa
 * regra: deltas de +601276s (sete dias) e a mesma sessão aparecendo em oito
 * cards. A regra que sobrou é a vizinhança: o dono é o card mais recente nascido
 * ANTES do registro, e só dentro da janela.
 */
const card = (over: Partial<CoverageCard> = {}): CoverageCard => ({
  cardId: "c1",
  provider: "claude",
  cwd: "/repo",
  createdAtMs: 1_000_000,
  taskId: null,
  hasReport: false,
  live: false,
  storeDeclared: true,
  clock: "last-activity",
  ...over,
});

describe("attribution por vizinhança", () => {
  it("a sessão pertence ao card nascido IMEDIATAMENTE antes dela", () => {
    const cards = [card({ cardId: "velho", createdAtMs: 1_000_000 }), card({ cardId: "novo", createdAtMs: 2_000_000 })];
    const out = attributeSessionsToCards({
      cards,
      candidates: [{ sessionId: "s1", timestampMs: 2_010_000, sizeBytes: 10 }],
    });
    expect([...out.keys()]).toEqual(["novo"]);
    expect(out.get("novo")!.deltaMs).toBe(10_000);
  });

  it("registro ANTERIOR ao primeiro card não pertence a ninguém", () => {
    const out = attributeSessionsToCards({
      cards: [card({ createdAtMs: 5_000_000 })],
      candidates: [{ sessionId: "velha", timestampMs: 1_000_000, sizeBytes: 10 }],
    });
    expect(out.size).toBe(0);
  });

  it("fora da janela medida (15min) NÃO é atribuído: o dono seria o próximo card", () => {
    const out = attributeSessionsToCards({
      cards: [card({ cardId: "so-um", createdAtMs: 1_000_000 })],
      candidates: [{ sessionId: "de-outro", timestampMs: 1_000_000 + COVERAGE_ATTRIBUTION_WINDOW_MS + 1, sizeBytes: 10 }],
    });
    expect(out.size).toBe(0);
  });

  it("dois registros do mesmo card: fica o MAIOR (a evidência mais forte)", () => {
    const out = attributeSessionsToCards({
      cards: [card({ createdAtMs: 1_000_000 })],
      candidates: [
        { sessionId: "pequena", timestampMs: 1_001_000, sizeBytes: 16 },
        { sessionId: "grande", timestampMs: 1_002_000, sizeBytes: 9_000_000 },
      ],
    });
    expect(out.get("c1")!.session.sessionId).toBe("grande");
    expect(out.get("c1")!.deltaMs).toBe(2_000);
  });

  it("carimbo ausente (store sem tempo) não atribui nada — ausência declarada", () => {
    const out = attributeSessionsToCards({
      cards: [card()],
      candidates: [{ sessionId: "sem-tempo", timestampMs: null, sizeBytes: 5 }],
    });
    expect(out.size).toBe(0);
  });
});

describe("clock declarado pelo store", () => {
  it("mtime é ÚLTIMA ATIVIDADE; carimbo de dentro do registro é NASCIMENTO", () => {
    expect(clockFromSessionStore({ kind: "files", time: { from: "mtime" } })).toBe("last-activity");
    expect(clockFromSessionStore({ kind: "files", time: { from: "json" } })).toBe("birth");
    expect(clockFromSessionStore({ kind: "sqlite", discovery: {} })).toBe("birth");
    expect(clockFromSessionStore(null)).toBe("none");
  });
});

describe("veredito", () => {
  it("com relatório: nada a dizer (não entra na lista)", () => {
    const { findings, counts } = decideUnreportedWork({
      cards: [card({ cardId: "contou", hasReport: true })],
      attributed: new Map(),
    });
    expect(findings).toEqual([]);
    expect(counts.worked_unreported).toBe(0);
  });

  it("sem store declarado: unobservable, com a frase que declara o limite", () => {
    const { findings, counts } = decideUnreportedWork({
      cards: [card({ provider: "misterio", storeDeclared: false, clock: "none" })],
      attributed: new Map(),
    });
    expect(findings[0].verdict).toBe("unobservable");
    expect(findings[0].why).toMatch(/declared limit, not a finding/);
    expect(counts.unobservable).toBe(1);
  });

  it("store observável e sessão atribuída: worked_unreported, com evidência e sem inventar causa", () => {
    const cards = [card({ cardId: "silencioso", taskId: "t1", live: true })];
    const attributed = attributeSessionsToCards({
      cards,
      candidates: [{ sessionId: "s", timestampMs: cards[0].createdAtMs + 4_000, sizeBytes: 3_000 }],
    });
    const { findings, counts } = decideUnreportedWork({ cards, attributed, misattributionSuspected: true });
    expect(findings[0].verdict).toBe("worked_unreported");
    expect(findings[0].sessionId).toBe("s");
    expect(findings[0].sizeBytes).toBe(3_000);
    expect(findings[0].why).toMatch(/WHY it stayed silent is NOT in this data/);
    expect(findings[0].why).toMatch(/may exist under another id/);
    expect(counts.worked_unreported_live).toBe(1);
    expect(counts.worked_unreported_on_task).toBe(1);
  });

  it("store observável e nenhuma sessão: no_session — não se acusa quem não deixou rastro", () => {
    const { findings } = decideUnreportedWork({ cards: [card({ cardId: "nunca" })], attributed: new Map() });
    expect(findings[0].verdict).toBe("no_session");
    expect(findings[0].why).toMatch(/cannot be accused/);
  });

  it("a ordem põe o trabalho que existe primeiro, e o vivo antes do morto", () => {
    const cards = [
      card({ cardId: "morto-com-trabalho", createdAtMs: 1_000_000 }),
      card({ cardId: "vivo-com-trabalho", createdAtMs: 2_000_000, live: true }),
      card({ cardId: "sem-sessao", createdAtMs: 3_000_000 }),
    ];
    const attributed = new Map([
      ["morto-com-trabalho", { session: { sessionId: "a", timestampMs: 1_001_000, sizeBytes: 10 }, deltaMs: 1_000 }],
      ["vivo-com-trabalho", { session: { sessionId: "b", timestampMs: 2_001_000, sizeBytes: 20 }, deltaMs: 1_000 }],
    ]);
    const { findings } = decideUnreportedWork({ cards, attributed });
    expect(findings.map((f) => f.cardId)).toEqual(["vivo-com-trabalho", "morto-com-trabalho", "sem-sessao"]);
  });
});

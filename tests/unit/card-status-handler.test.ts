import { describe, it, expect } from "vitest";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Gate do `card_status` (task 4245c6f5) — o caminho que estava SEM cobertura
 * de unidade, e por isso a mentira sobreviveu: `running` para um TUI parado
 * que repinta, `idle` para um shell no prompt.
 *
 * O que este arquivo trava, no nível do handler:
 *   - o FATO DE TURNO manda, não os bytes (`getCardTurnEndedAt`);
 *   - sem fato, a resposta é `unknown` — não um palpite entre running e idle;
 *   - bash tem vocabulário próprio (`at-prompt`) e NUNCA `idle`;
 *   - a resposta diz o `provider`, que é o que impede mandar brief de agente
 *     para um card bash.
 */

const NOW = Date.now();

type Facts = {
  provider: string;
  alive?: boolean;
  waitingOnConsent?: boolean;
  lastActivityAt?: number | null;
  turnEndedAt?: number | null;
  hasPendingHumanInput?: boolean;
};

function busWith(facts: Facts) {
  const consent = new Set<string>(facts.waitingOnConsent ? ["c1"] : []);
  return createMessageBus(
    "/tmp/nonexistent-stellar-card-status.sock",
    new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "listCards") {
            return () => [{ id: "c1", kind: "terminal", provider: facts.provider, cwd: "", label: "c1", displayName: "c1" }];
          }
          if (prop === "isCardAlive") return () => facts.alive !== false;
          if (prop === "getCardLastActivityAt") return () => (facts.lastActivityAt === undefined ? NOW : facts.lastActivityAt);
          if (prop === "getCardTurnEndedAt") return () => (facts.turnEndedAt === undefined ? null : facts.turnEndedAt);
          if (prop === "getCardWriteReadiness") {
            return () => ({ spawnedAtMs: NOW - 60_000, hasReceivedData: true, lastActivityAtMs: NOW, hasPendingHumanInput: facts.hasPendingHumanInput === true });
          }
          if (prop === "listAllConnectors") return () => [];
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1],
  );
}

async function statusOf(facts: Facts) {
  const bus = busWith(facts);
  try {
    return (await bus.handleRequest({ cmd: "card_status", target: "c1" } as BusRequest)) as {
      ok: boolean;
      status?: string;
      provider?: string | null;
      note?: string;
    };
  } finally {
    bus.close();
  }
}

describe("card_status: o estado tem que corresponder à tela", () => {
  it("TUI que repinta e NUNCA declarou turno = unknown (o caso dos cinco cards)", async () => {
    const res = await statusOf({ provider: "claude", lastActivityAt: NOW });
    expect(res.status).toBe("unknown");
    expect(res.note).toContain("não dá para dizer");
  });

  it("turno declarado sem saída depois = idle, mesmo com bytes recentes antes", async () => {
    const res = await statusOf({ provider: "claude", turnEndedAt: NOW - 100, lastActivityAt: NOW - 200 });
    expect(res.status).toBe("idle");
  });

  it("saída DEPOIS do turno declarado = running", async () => {
    const res = await statusOf({ provider: "claude", turnEndedAt: NOW - 5_000, lastActivityAt: NOW });
    expect(res.status).toBe("running");
  });

  it("bash QUIETO = at-prompt, com o provider na resposta (não confundir shell com agente)", async () => {
    const res = await statusOf({ provider: "bash", lastActivityAt: NOW - 10_000 });
    expect(res.status).toBe("at-prompt");
    expect(res.provider).toBe("bash");
    expect(res.note).toContain("não é um agente");
  });

  it("bash com bytes = unknown, porque um TUI pode estar DENTRO do card", async () => {
    // O caso real: card `bash` com o TUI do commandcode dentro (repinta).
    // Responder `running` aqui é a mentira que a task existe para matar.
    expect((await statusOf({ provider: "bash", lastActivityAt: NOW })).status).toBe("unknown");
  });

  // A precedência do CONSENTIMENTO (`waiting` antes de qualquer outra coisa)
  // não é exercitada aqui de propósito: o conjunto `waitingOnConsent` é
  // INTERNO ao bus (populado quando um `open_url`/`spawn_agent` passa por
  // ele e fica aguardando decisão humana) — um duble de callbacks não o
  // alcança, e inventar um jeito de setá-lo testaria o teste, não o bus.
  // Ela está travada em `card-status-decision.test.ts` (puro) e no smoke
  // `smoke-mcp-card-status-waiting.mjs` (ponta a ponta, com pedido real).

  it("card morto = exited", async () => {
    expect((await statusOf({ provider: "claude", alive: false })).status).toBe("exited");
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { FIRST_OUTPUT_DEADLINE_MS } from "../../src/main/silent-boot-decision";

/**
 * O AVISO DE "SUBIU E NUNCA FALOU" pelo canal do watchdog de ocioso
 * (task d77b524b) — o buraco que `SPAWN_TIMEOUT_MS` não cobria.
 *
 * Antes disto: um card cujo PTY não emitia byte nenhum ficava vivo, calado, e
 * `card_status` respondia `unknown` para sempre; quem o spawnou não sabia de
 * nada. Decisão do dono: AVISAR, NUNCA MATAR — este arquivo mede o aviso, e o
 * caminho testado não tem nenhum kill.
 *
 * ESTE ARQUIVO NASCEU VERMELHO: o scan não conhecia o fato e `card_status` não
 * tinha o estado; as asserções centrais falhavam antes do conserto.
 */
function callbacksWithOverrides(overrides: Record<string, (...args: never[]) => unknown>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === "listAllConnectors") return () => [];
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "listTasksForIdleScan") return () => [];
        if (prop === "getReport") return () => undefined;
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

describe("card que subiu e nunca falou (d77b524b)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null = null;
  let writes: { target: string; text: string }[];

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** `idadeDoPtyMs` é o que o registry diria: `spawnedAtMs` no passado. */
  function rig(opts: { vivo?: boolean; emitiuByte?: boolean; idadeDoPtyMs?: number }) {
    dir = mkdtempSync(join(tmpdir(), "stellar-silent-boot-"));
    writes = [];
    const agora = Date.now();
    const calado = { id: "silencioso", kind: "terminal", provider: "opencode", cwd: "/repo", label: "Calado" };
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      callbacksWithOverrides({
        listCards: (() => [calado, { id: "spawner", kind: "terminal", provider: "claude", cwd: "/repo", label: "Orq" }]) as never,
        listTerminalCards: (() => [calado]) as never,
        isCardAlive: ((id: string) => (id === "silencioso" ? opts.vivo !== false : true)) as never,
        getCardWriteReadiness: ((id: string) =>
          id === "silencioso"
            ? {
                spawnedAtMs: agora - (opts.idadeDoPtyMs ?? FIRST_OUTPUT_DEADLINE_MS + 5_000),
                hasReceivedData: opts.emitiuByte === true,
                lastActivityAtMs: agora,
                hasPendingHumanInput: false,
                inputLineLastAtMs: null,
                bracketedPasteMode: false,
                bracketedPasteOffEvents: 0,
              }
            : undefined) as never,
        // A linhagem: o MESMO resolvedor que o watchdog de ocioso usa para achar
        // o destinatário do aviso.
        findSpawnByChild: ((id: string) => (id === "silencioso" ? { from_card_id: "spawner" } : undefined)) as never,
        getCardBoardId: (() => "118") as never,
        describeCardLabel: ((id: string) => (id === "silencioso" ? "Calado" : "Orquestrador")) as never,
        onReadCardRequest: ((requestId: string) => {
          bus?.resolveReadCard(requestId, { ok: true, text: "❯\n" });
        }) as never,
        writeToCardWithOrigin: ((id: string, data: string, origin: string) => {
          if (origin === "delivery") writes.push({ target: id, text: data });
        }) as never,
        writeToCard: ((id: string, data: string) => writes.push({ target: id, text: data })) as never,
      }),
    );
  }

  const flush = () => new Promise((r) => setTimeout(r, 5));

  it("PTY sem NENHUM byte depois do limite: o spawner recebe o aviso, uma vez só", async () => {
    rig({});
    bus!.scanIdleWithoutReport();
    await flush();
    const avisos = writes.filter((w) => w.target === "spawner");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].text).toContain("Calado");
    // A frase diz o que se sabe e o que NÃO se sabe — nada de acusar abandono.
    expect(avisos[0].text).toMatch(/no byte at all/i);
    // UM aviso por card: o scan roda a cada 5s e não pode virar metralhadora.
    bus!.scanIdleWithoutReport();
    bus!.scanIdleWithoutReport();
    await flush();
    expect(writes.filter((w) => w.target === "spawner")).toHaveLength(1);
  });

  it("o PRIMEIRO byte limpa o estado: nada é avisado, e o card_status deixa de dizer no-output", async () => {
    rig({ emitiuByte: true });
    bus!.scanIdleWithoutReport();
    await flush();
    expect(writes.filter((w) => w.target === "spawner")).toHaveLength(0);
    const status = (await bus!.handleRequest({ cmd: "card_status", target: "silencioso" } as BusRequest)) as {
      status: string;
    };
    expect(status.status).not.toBe("no-output");
  });

  it("card_status responde no-output enquanto ninguém falou — o estado VISÍVEL do enunciado", async () => {
    rig({});
    const status = (await bus!.handleRequest({ cmd: "card_status", target: "silencioso" } as BusRequest)) as {
      status: string;
      note: string;
    };
    expect(status.status).toBe("no-output");
    expect(status.note).toMatch(/NOT ONE byte/i);
  });

  it("card morto ou dentro da janela: nada de aviso (o SINAL 2 e a paciência cuidam disso)", async () => {
    rig({ vivo: false });
    bus!.scanIdleWithoutReport();
    await flush();
    expect(writes).toHaveLength(0);
    bus!.close();
    // `.close()` derruba o bus, mas uma entrega já enfileirada ainda pode
    // escrever o Enter dela no PTY do rig ANTERIOR — e `writes` é do arquivo,
    // resetado pelo `rig()` seguinte. Sem esta drenagem o Enter do rig 1 cai no
    // array do rig 2 e o teste falha por CORRIDA (medido: 3/3 verde sozinho,
    // vermelho sob a suíte cheia, que é quando a máquina está ocupada).
    await flush();
    rig({ idadeDoPtyMs: 3_000 });
    bus!.scanIdleWithoutReport();
    await flush();
    expect(writes).toHaveLength(0);
  });
});

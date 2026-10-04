import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { loadDynamicProviders } from "../../src/main/providers-dynamic";

/**
 * Task d42c119a (2026-10-04) — o aviso TARDIO de assentamento foi REMOVIDO.
 * Mesmo com a fila do commandcode corrigida (eda2b59b), o remetente ainda
 * recebia "…may not have landed" falso. Agora NENHUM desfecho tardio é
 * enfileirado ao remetente: `send_to_card` responde `queued` na hora e quem
 * quiser o veredito consulta `get_delivery`/`list_deliveries`.
 *
 * Estes testes provam, pela borda do bus:
 *  (a) 'Queued (1) › texto' num card commandcode → `parked`, 1 Enter;
 *  (b) nunca uma mensagem tardia ao remetente (parked);
 *  (c) jamais um aviso "não consumido" quando o card sai com o item na fila;
 *  (d) entrega `unconfirmed` também NÃO gera mensagem tardia;
 *  (e) o item consumido (turno terminou depois do park) ainda é PROMOVIDO a
 *      `delivered` no get_delivery.
 */

const BEFORE = "✻ Working on it…";
const QUEUED = (text: string) => `${BEFORE}\n  Queued (1)\n  › ${text}`;
const rule = "─".repeat(24);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("message-bus: nenhum aviso tardio de assentamento ao remetente", () => {
  let ctx: ReturnType<typeof harness> | null = null;

  beforeAll(() => {
    loadDynamicProviders(mkdtempSync(join(tmpdir(), "stellar-cc-queue-")));
  });

  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  function harness(opts: { provider: string; screen: (i: number) => string; turnEndedAt?: () => number | null }) {
    const dir = mkdtempSync(join(tmpdir(), "stellar-cc-queue-"));
    const writes: { target: string; text: string }[] = [];
    let reads = 0;
    const readySince = Date.now() - 1_000;
    const callbacks = {
      listCards: () => [
        { id: "target", kind: "terminal", provider: opts.provider, cwd: "", label: null, displayName: "Alvo" },
        { id: "sender", kind: "terminal", provider: "cline", cwd: "", label: "Remetente", displayName: "Remetente" },
      ],
      describeCardLabel: (id: string) => id,
      writeToCard: (_id: string, text: string) => {
        writes.push({ target: _id, text });
      },
      writeToCardWithOrigin: (id: string, text: string) => {
        writes.push({ target: id, text });
      },
      beginCardDelivery: () => true,
      endCardDelivery: () => undefined,
      isCardAlive: () => true,
      getCardLastActivityAt: () => readySince,
      getCardWriteReadiness: () => ({
        spawnedAtMs: readySince,
        hasReceivedData: true,
        lastActivityAtMs: readySince,
        hasPendingHumanInput: false,
        inputLineLastAtMs: null,
      }),
      onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: opts.screen(reads++) }),
      getCardTurnEndedAt: () => opts.turnEndedAt?.() ?? null,
      nextReportSeqSeed: () => 0,
      onAutoConnect: () => undefined,
      listAllConnectors: () => [],
      findSpawnByChild: () => undefined,
      listSpawnsByParent: () => [],
      getCardBoardId: () => "b1",
      isBoardAutonomous: () => false,
      listTasks: () => [],
      getReport: () => undefined,
      listTaskCardsForCard: () => [],
    } as unknown as Parameters<typeof createMessageBus>[1];
    const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    return { bus, writes, dir };
  }

  async function settle(id: string, ms = 6_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const status = (await ctx!.bus.handleRequest({ cmd: "get_delivery", id } as BusRequest)) as unknown as {
        delivery?: string;
        confirm?: { result: string; enters: number; steered?: boolean };
      };
      if (status.delivery !== "queued") return status;
      if (Date.now() >= deadline) return status;
      await delay(20);
    }
  }

  const send = (text: string) =>
    ctx!.bus.handleRequest({ cmd: "send", target: "target", text, requesterId: "sender" } as BusRequest) as unknown as Promise<{
      delivery: string;
      id: string;
    }>;

  it("(a)(b) 'Queued (1) › texto' num card commandcode → parked, 1 Enter, SEM mensagem tardia", async () => {
    ctx = harness({ provider: "commandcode", screen: (i) => (i === 0 ? BEFORE : QUEUED("rode a task e reporte")) });
    const sent = await send("rode a task e reporte");
    expect(sent.delivery).toBe("queued");

    const status = await settle(sent.id);
    expect(status.delivery).toBe("parked");
    // Nenhuma tecla extra: só o Enter do submit (o steer não existe aqui).
    expect(status.confirm?.enters).toBe(1);
    expect(status.confirm?.steered).toBeUndefined();

    await delay(400);
    expect(ctx.writes.some((w) => w.target === "sender")).toBe(false);
  });

  it("(c) card SAI com o item ainda na fila → NENHUM aviso ao remetente (o 'não consumido' morreu)", async () => {
    ctx = harness({
      provider: "commandcode",
      screen: (i) => (i === 0 ? BEFORE : QUEUED("rode a task e reporte")),
      turnEndedAt: () => null,
    });
    const sent = await send("rode a task e reporte");
    await settle(sent.id);

    ctx.bus.resolveCardExit("target", 0);
    await delay(600);
    expect(ctx.writes.some((w) => w.target === "sender")).toBe(false);
  });

  it("(d) entrega 'unconfirmed' (texto preso no composer) → NENHUMA mensagem tardia", async () => {
    // Composer real com o corpo preso: 4 Enters, laço desiste, resultado
    // unconfirmed/failed — histórico: era AQUI que o remetente recebia o
    // "may not have landed". Agora, silêncio.
    ctx = harness({
      provider: "claude",
      screen: (i) => (i === 0 ? `${rule}\n❯ \n${rule}` : `${rule}\n❯ consertar o roteamento do push agora\n${rule}`),
    });
    const sent = await send("consertar o roteamento do push agora");
    const status = await settle(sent.id);
    expect(["failed", "unconfirmed"]).toContain(status.delivery);

    await delay(500);
    expect(ctx.writes.some((w) => w.target === "sender")).toBe(false);
  });

  it("(e) item consumido (turno terminou depois do park) ainda é promovido a `delivered`, sem aviso", async () => {
    let ended: number | null = null;
    ctx = harness({
      provider: "commandcode",
      screen: (i) => (i === 0 ? BEFORE : QUEUED("rode a task e reporte")),
      turnEndedAt: () => ended,
    });
    const sent = await send("rode a task e reporte");
    await settle(sent.id);

    ended = Date.now();
    ctx.bus.resolveCardExit("target", 0);
    await delay(400);

    expect(ctx.writes.some((w) => w.target === "sender")).toBe(false);
    const after = (await ctx.bus.handleRequest({ cmd: "get_delivery", id: sent.id } as BusRequest)) as unknown as { delivery?: string };
    expect(after.delivery).toBe("delivered");
  });
});

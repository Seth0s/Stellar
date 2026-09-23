import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * O REMETENTE FICA SABENDO QUE A MENSAGEM CHEGOU (task 40e3b551).
 *
 * Medição que originou isto (sessão 3166d2b0): **888** chamadas `send_to_card`
 * contra **10** menções a `get_delivery` (~1%). A ferramenta devolvia
 * `{delivery:"queued"}` — verdade sobre o enfileiramento, nada sobre a chegada —
 * e o remetente repetia "para garantir": 5 mensagens daquela janela se anunciam
 * como duplicata/complemento/ping, e **0** das 33 longas eram duplicatas
 * byte-a-byte (por isso um guarda por conteúdo não pegaria nenhuma).
 *
 * A PRIMEIRA forma do conserto — esperar o desfecho dentro do `send` — foi
 * DESCARTADA pela própria suíte: `message-bus-send-does-not-await-pty` pina um
 * incidente medido em 2026-09-13 em que um `send` que esperava o PTY ficou preso
 * no portão humano, o cliente MCP estourou e RE-DIGITOU o mesmo texto. Esperar
 * aqui recria a mesma classe. Então o `send` continua devolvendo `queued` na
 * hora (invariante de 250ms, pinada abaixo) e a verdade vai ao remetente por
 * outro canal: um ack CURTO quando o item assenta.
 *
 * Nasceu VERMELHO: antes disto nenhum ack existia.
 */
const rule = "─".repeat(24);

function harness(opts: { screen: (i: number) => string; hold?: "human-input" }) {
  const dir = mkdtempSync(join(tmpdir(), "stellar-send-ack-"));
  const writes: { target: string; text: string }[] = [];
  let reads = 0;
  const readySince = Date.now() - 1_000;
  const callbacks = {
    listCards: () => [
      { id: "target", kind: "terminal", provider: "claude", cwd: "", label: null, displayName: "Alvo" },
      { id: "sender", kind: "terminal", provider: "cline", cwd: "", label: "Remetente", displayName: "Remetente" },
    ],
    describeCardLabel: (id: string) => (id === "sender" ? "Remetente" : id),
    writeToCard: () => undefined,
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
      hasPendingHumanInput: opts.hold === "human-input",
      inputLineLastAtMs: opts.hold === "human-input" ? Date.now() : null,
    }),
    onReadCardRequest: (requestId: string) => bus?.resolveReadCard(requestId, { ok: true, text: opts.screen(reads++) }),
    nextReportSeqSeed: () => 0,
    onAutoConnect: () => undefined,
    listAllConnectors: () => [],
    findSpawnByChild: () => undefined,
    listSpawnsByParent: () => [],
    getCardBoardId: () => "b1",
    isBoardAutonomous: () => false,
  } as unknown as Parameters<typeof createMessageBus>[1];
  const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
  return { bus, writes, dir };
}

async function waitFor(check: () => boolean, ms = 4_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return check();
}

describe("message-bus: send_to_card avisa o remetente que chegou", () => {
  let ctx: ReturnType<typeof harness> | null = null;

  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  const send = (text: string, withSender = true) =>
    ctx!.bus.handleRequest({
      cmd: "send",
      target: "target",
      text,
      ...(withSender ? { requesterId: "sender" } : {}),
    } as BusRequest);

  it("entrega LIMPA: NENHUM ack — silêncio = entregue (o caminho comum não ganha linha)", async () => {
    ctx = harness({ screen: (i) => (i === 0 ? "> " : `→ ${ctx!.writes[0]?.text ?? ""}\n  Working`) });
    const res = (await send("relatório: tudo verde")) as Record<string, unknown>;
    expect(res.delivery).toBe("queued"); // a chamada continua não esperando
    // O retorno DIZ a regra, para o remetente não duvidar de "queued".
    expect(String(res.note)).toMatch(/silence means delivered/);
    // E o PTY do remetente fica intacto: nada digitado.
    await new Promise((r) => setTimeout(r, 900));
    expect(ctx.writes.some((w) => w.target === "sender")).toBe(false);
  });

  it("`send` continua voltando na hora com `queued` (o invariante do incidente de 2026-09-13)", async () => {
    // Alvo preso atrás do input humano: se o `send` esperasse, ficaria aqui.
    ctx = harness({ screen: () => `${rule}\n❯ \n${rule}`, hold: "human-input" });
    const startedAt = Date.now();
    const res = (await send("oi")) as Record<string, unknown>;
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(res.delivery).toBe("queued");
    expect(res.reason).toBe("human-input");
    expect(ctx.writes.some((w) => w.target === "target")).toBe(false); // nada digitado ainda
  });

  it("entrega que NÃO confirmou: o ack manda CONFERIR antes de reenviar (nunca manda reenviar)", async () => {
    // O corpo fica preso no composer da moldura: 4 Enters e o laço desiste.
    ctx = harness({
      screen: (i) => (i === 0 ? `${rule}\n❯ \n${rule}` : `${rule}\n❯ ${ctx!.writes[0]?.text ?? ""}\n${rule}`),
    });
    await send("relatório longo que nao submete");
    expect(await waitFor(() => ctx!.writes.some((w) => w.target === "sender"), 8_000)).toBe(true);
    const ack = ctx.writes.find((w) => w.target === "sender")!;
    expect(ack.text).toMatch(/NOT confirmed/);
    expect(ack.text).toMatch(/check read_card target/);
    expect(ack.text).not.toContain("resend on this alone");
  });

  it("sem requesterId (composer GLOBAL, onde quem digita é o humano): nenhum ack", async () => {
    ctx = harness({ screen: (i) => (i === 0 ? "> " : `→ ${ctx!.writes[0]?.text ?? ""}\n  Working`) });
    await send("recado do dono", false);
    await new Promise((r) => setTimeout(r, 600));
    expect(ctx.writes.some((w) => w.target === "sender")).toBe(false);
  });
});

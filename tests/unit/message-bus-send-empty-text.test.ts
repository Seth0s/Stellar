import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * Task 9c28adde — `send_to_card` com `text` vazio enfileirava só o rótulo
 * `[de: <nome>]`: uma mensagem que o remetente NÃO escreveu. A decisão é
 * RECUSAR, nomeando o campo (não tratar vazio como o gesto de steer — o steer
 * já tem gatilho explícito e `steer:true` sobre uma entrega parqueada).
 *
 * O caminho de recusa retorna ANTES do enqueue, então o rig só precisa da
 * lista de cards (o alvo tem de existir para chegar à checagem do texto).
 */
describe("send_to_card: `text` vazio é recusado (task 9c28adde)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBus(): ReturnType<typeof createMessageBus> {
    dir = mkdtempSync(join(tmpdir(), "stellar-empty-send-"));
    const callbacks = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "listCards") return () => [{ id: "c1", kind: "terminal" }];
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(join(dir, "a.sock"), callbacks);
    return bus;
  }

  it("text vazio (ou só espaços) → { ok:false, error } nomeando `text`", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({
      cmd: "send",
      target: "c1",
      text: "   ",
      requesterId: "orch",
    } as BusRequest)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/`text` is empty/);
  });

  it("text ausente também é recusado (nunca vira só o rótulo)", async () => {
    const b = makeBus();
    const res = (await b.handleRequest({ cmd: "send", target: "c1", requesterId: "orch" } as BusRequest)) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/`text` is empty/);
  });
});

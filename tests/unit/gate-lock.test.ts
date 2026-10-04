import { afterEach, describe, expect, it } from "vitest";
import {
  MACHINE_LOCK_KEY,
  acquireGateLock,
  allGateLockSnapshots,
  gateLockKey,
  gateLockSnapshot,
  resetGateLocks,
  type GateLockHolder,
} from "../../src/main/gate-lock";

/**
 * Task ff24b36d — o lock de gate: FIFO por chave, com estado observável (quem
 * segura/espera). O mesmo lock que o gate-runner usa (repo) e o global
 * (machine, para o que mede desempenho e não pode concorrer com nada).
 */

const holder = (label: string): GateLockHolder => ({ taskId: null, cardId: null, label });

afterEach(() => resetGateLocks());

describe("gate-lock: FIFO e estado", () => {
  it("dois chamadores na MESMA chave serializam; o 2º espera o 1º liberar", async () => {
    const order: string[] = [];
    const a = await acquireGateLock("/repo/a", holder("A"));
    order.push("A");
    let bGranted = false;
    const bP = acquireGateLock("/repo/a", holder("B")).then((acq) => {
      bGranted = true;
      order.push("B");
      return acq;
    });
    await Promise.resolve();
    expect(bGranted).toBe(false);
    a.release();
    const b = await bP;
    expect(bGranted).toBe(true);
    expect(order).toEqual(["A", "B"]);
    expect(b.holderWhileWaiting?.label).toBe("A");
    expect(b.positionAtRequest).toBe(1);
    b.release();
  });

  it("chaves diferentes NÃO serializam (entra direto)", async () => {
    const a = await acquireGateLock("/repo/a", holder("A"));
    const b = await acquireGateLock("/repo/b", holder("B"));
    expect(b.positionAtRequest).toBe(0);
    expect(b.waitedMs).toBe(0);
    a.release();
    b.release();
  });

  it("scope machine = a MESMA chave global, mesmo entre repos", () => {
    expect(gateLockKey("machine", "/repo/a")).toBe(MACHINE_LOCK_KEY);
    expect(gateLockKey("machine", "/repo/b")).toBe(MACHINE_LOCK_KEY);
    expect(gateLockKey("repo", "/repo/a")).toBe("/repo/a");
  });

  it("machine serializa entre repos diferentes", async () => {
    const mKey = gateLockKey("machine", "/repo/a");
    const a = await acquireGateLock(mKey, holder("A"));
    let bGranted = false;
    const bP = acquireGateLock(gateLockKey("machine", "/repo/b"), holder("B")).then((acq) => {
      bGranted = true;
      return acq;
    });
    await Promise.resolve();
    expect(bGranted).toBe(false);
    a.release();
    const b = await bP;
    expect(bGranted).toBe(true);
    expect(b.holderWhileWaiting?.label).toBe("A");
    b.release();
  });

  it("entrega na ordem dos pedidos e o snapshot diz quem segura e a fila", async () => {
    const a = await acquireGateLock("/repo/a", holder("A"));
    const order: string[] = [];
    const bP = acquireGateLock("/repo/a", holder("B")).then((x) => {
      order.push("B");
      return x;
    });
    const cP = acquireGateLock("/repo/a", holder("C")).then((x) => {
      order.push("C");
      return x;
    });
    await Promise.resolve();
    const snap = gateLockSnapshot("/repo/a", "repo");
    expect(snap.running?.holder.label).toBe("A");
    expect(snap.queue.map((q) => q.holder.label)).toEqual(["B", "C"]);
    expect(snap.queue.map((q) => q.position)).toEqual([1, 2]);

    a.release();
    const b = await bP;
    b.release();
    const c = await cP;
    c.release();
    expect(order).toEqual(["B", "C"]);
    expect(gateLockSnapshot("/repo/a", "repo").running).toBeNull();
    expect(allGateLockSnapshots()).toEqual([]);
  });

  it("release é idempotente (liberar duas vezes não passa a vez duas vezes)", async () => {
    const a = await acquireGateLock("/repo/a", holder("A"));
    const bP = acquireGateLock("/repo/a", holder("B"));
    a.release();
    a.release();
    const b = await bP;
    expect(gateLockSnapshot("/repo/a", "repo").running?.holder.label).toBe("B");
    b.release();
  });
});

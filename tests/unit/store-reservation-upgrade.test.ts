import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore } from "../../src/main/store";

/**
 * Task 377a6029 — a migração de `task_cards` é ADITIVA e IDEMPOTENTE: um banco
 * no schema ANTIGO (sem `reservation_state`/`reserved_order`) é atualizado sem
 * reescrever nenhuma linha existente (as colunas novas ficam NULL = vínculo
 * ACTIVE, o comportamento de sempre), e reabrir o banco não quebra.
 */

describe("task_cards: migração aditiva da reserva (upgrade do schema antigo)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("banco ANTIGO (sem as colunas) é atualizado: colunas novas + zero reescrita + reabrir idempotente", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-reserve-upgrade-"));
    const dbPath = join(dir, "agent-canvas.db");

    // Schema ANTIGO: task_cards só com as colunas-base, e uma linha legada.
    const raw = new Database(dbPath);
    raw.exec(
      "CREATE TABLE task_cards (task_id TEXT NOT NULL, card_id TEXT NOT NULL, role TEXT NOT NULL, linked_at INTEGER, PRIMARY KEY (task_id, card_id))",
    );
    raw.prepare("INSERT INTO task_cards (task_id, card_id, role, linked_at) VALUES ('legacy-task','legacy-card','implementer', 1)").run();
    raw.close();

    // Abrir pelo store roda a migração.
    const store = openStore(dir);
    const verify = new Database(dbPath);
    const cols = (verify.prepare("PRAGMA table_info(task_cards)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("reservation_state");
    expect(cols).toContain("reserved_order");
    // A linha EXISTENTE não foi reescrita: reserva NULL = vínculo active.
    const legacy = verify.prepare("SELECT role, reservation_state, reserved_order FROM task_cards WHERE task_id='legacy-task'").get() as {
      role: string;
      reservation_state: string | null;
      reserved_order: number | null;
    };
    expect(legacy.role).toBe("implementer");
    expect(legacy.reservation_state).toBeNull();
    expect(legacy.reserved_order).toBeNull();
    verify.close();
    store.close();

    // Reabrir: a migração é idempotente (colunas já existem — não pode lançar).
    const again = openStore(dir);
    again.close();
  });

  it("reserva: enfileira em ordem, não é active, e reordena como permutação", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-reserve-queue-"));
    const store = openStore(dir);

    expect(store.reserveTaskCard("t1", "cardA", undefined)).toBe(1);
    expect(store.reserveTaskCard("t2", "cardA", undefined)).toBe(1);
    store.reserveTaskCard("t3", "cardA", undefined);

    const queue = store.listReservationsForCard("cardA");
    expect(queue.map((r) => r.task_id)).toEqual(["t1", "t2", "t3"]);
    expect(queue.every((r) => r.reservation_state === "reserved")).toBe(true);

    // A fila de OUTRO card é independente.
    expect(store.listReservationsForCard("cardB")).toEqual([]);

    // Reordenar move a ordem; `activate` tira da fila (vira active).
    store.reorderReservedTaskCards("cardA", ["t3", "t1", "t2"]);
    expect(store.listReservationsForCard("cardA").map((r) => r.task_id)).toEqual(["t3", "t1", "t2"]);
    expect(store.activateReservedTaskCard("t3", "cardA")).toBe(1);
    expect(store.listReservationsForCard("cardA").map((r) => r.task_id)).toEqual(["t1", "t2"]);

    store.close();
  });
});

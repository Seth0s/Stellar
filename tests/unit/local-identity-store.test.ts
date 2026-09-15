/**
 * Identidade local × store.ts — carimbar as escritas, espelhar sem
 * mandar, e a regra que decide se a entrega vale: NÃO BACKFILL.
 *
 * STELLAR_TEAM.md §6 decisão 4 + §8 ("não inventar sujeito onde não
 * há"): linhas históricas de task_transitions ficam NULL para sempre;
 * só escrita NOVA carimba user_id. O user_id sobrevive a um banco
 * recriado porque a fonte é o arquivo em userData, nunca o SQLite.
 */
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type TaskRow } from "../../src/main/store";
import { isOpaqueId } from "../../src/main/local-identity-decision";
import { identityFilePath } from "../../src/main/local-identity";

function base(id: string, extra: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "p",
    provider: null,
    status: "pending",
    card_id: null,
    board_id: "b1",
    cwd: null,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: now,
    updated_at: now,
    actor: "agent",
    ...extra,
  };
}

function readMirror(dir: string): Record<string, unknown> | undefined {
  const db = new Database(join(dir, "agent-canvas.db"), { readonly: true });
  try {
    return db.prepare("SELECT user_id, install_id, created_at FROM local_identity WHERE slot = 'local'").get() as
      | Record<string, unknown>
      | undefined;
  } finally {
    db.close();
  }
}

describe("identidade local no store", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function tmp(): string {
    dir = mkdtempSync(join(tmpdir(), "stellar-id-store-"));
    return dir;
  }

  it("openStore resolve a identidade: arquivo fonte + espelho no banco, ids opacos distintos", () => {
    const d = tmp();
    const store = openStore(d);
    try {
      const id = store.getLocalIdentity();
      expect(isOpaqueId(id.user_id)).toBe(true);
      expect(isOpaqueId(id.install_id)).toBe(true);
      expect(id.user_id).not.toBe(id.install_id);
      const file = JSON.parse(readFileSync(identityFilePath(d), "utf-8")) as Record<string, unknown>;
      expect(file.user_id).toBe(id.user_id);
      expect(readMirror(d)).toMatchObject({ user_id: id.user_id, install_id: id.install_id });
    } finally {
      store.close();
    }
  });

  it("escrita NOVA carimba user_id em task_transitions; actor continua sendo a CLASSE", () => {
    const d = tmp();
    const store = openStore(d);
    try {
      const { user_id } = store.getLocalIdentity();
      store.upsertTask(base("t1", { actorCardId: "416" }));
      const status = store.getTask("t1")!.transitions!.find((t) => t.kind === "status");
      expect(status?.actor).toBe("agent");
      expect(status?.card_id).toBe("416");
      expect(status?.user_id).toBe(user_id);
    } finally {
      store.close();
    }
  });

  it("request/request_denied (setStatusAsk) também carimbam o sujeito", () => {
    const d = tmp();
    const store = openStore(d);
    try {
      const { user_id } = store.getLocalIdentity();
      store.upsertTask(base("t1", { actor: "human" }));
      store.setStatusAsk("t1", { status: "done", reason: "r", requesterId: "416", at: Date.now() });
      const request = store.getTask("t1")!.transitions!.find((t) => t.kind === "request");
      expect(request?.user_id).toBe(user_id);
      store.setStatusAsk("t1", null);
      const denied = store.getTask("t1")!.transitions!.find((t) => t.kind === "request_denied");
      expect(denied?.user_id).toBe(user_id);
    } finally {
      store.close();
    }
  });

  it("NÃO BACKFILL: linha histórica continua NULL depois do migrate, e nada mais a toca", () => {
    const d = tmp();
    // Simula instalação antiga: task_transitions SEM a coluna user_id
    // e uma transição órfã gravada antes da decisão existir.
    const legacy = new Database(join(d, "agent-canvas.db"));
    legacy.exec(`
      CREATE TABLE task_transitions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_value TEXT,
        to_value TEXT NOT NULL,
        actor TEXT NOT NULL,
        card_id TEXT,
        at INTEGER NOT NULL
      );
      INSERT INTO task_transitions (id, task_id, kind, from_value, to_value, actor, card_id, at)
      VALUES ('legacy-1', 't-old', 'status', NULL, 'done', 'agent', NULL, 1600000000000);
    `);
    legacy.close();

    const store = openStore(d);
    try {
      // Abrir sobre o banco legado não quebra: migrate adiciona a
      // coluna via ALTER e a identidade nasce normal (espelho escrito).
      expect(readMirror(d)).toBeDefined();
    } finally {
      store.close();
    }
    const after = new Database(join(d, "agent-canvas.db"), { readonly: true });
    try {
      const cols = after.prepare("PRAGMA table_info(task_transitions)").all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain("user_id");
      const legacyRow = after
        .prepare("SELECT user_id FROM task_transitions WHERE id = 'legacy-1'")
        .get() as { user_id: string | null };
      expect(legacyRow.user_id).toBeNull();
    } finally {
      after.close();
    }
  });

  it("user_id sobrevive a um BANCO RECRIADO — o arquivo em userData é a fonte", () => {
    const d = tmp();
    const store = openStore(d);
    const first = store.getLocalIdentity();
    store.close();
    // Apaga o banco inteiro (WAL trio) — o arquivo de identidade fica.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(d, `agent-canvas.db${suffix}`), { force: true });
    const reopened = openStore(d);
    try {
      const second = reopened.getLocalIdentity();
      expect(second.user_id).toBe(first.user_id);
      expect(second.install_id).toBe(first.install_id);
      expect(readMirror(d)).toMatchObject({ user_id: first.user_id });
    } finally {
      reopened.close();
    }
  });

  it("arquivo corrompido + banco intacto: espelho RESTAURA a identidade e o arquivo é reparado", () => {
    const d = tmp();
    const store = openStore(d);
    const first = store.getLocalIdentity();
    store.close();
    writeFileSync(identityFilePath(d), '{"schema_version":1,"trunc');
    const reopened = openStore(d);
    try {
      expect(reopened.getLocalIdentity()).toEqual(first);
      const file = JSON.parse(readFileSync(identityFilePath(d), "utf-8")) as Record<string, unknown>;
      expect(file.user_id).toBe(first.user_id);
      // quarantena preservou os bytes corrompidos (nome tem timestamp)
      const quarantined = readdirSync(d).find((f) => f.startsWith("local-identity.corrupt-"));
      expect(quarantined).toBeDefined();
      expect(readFileSync(join(d, quarantined!), "utf-8")).toBe('{"schema_version":1,"trunc');
    } finally {
      reopened.close();
    }
  });

  it("espelho adulterado + arquivo válido: arquivo vence e o espelho é reparado", () => {
    const d = tmp();
    const store = openStore(d);
    const first = store.getLocalIdentity();
    store.close();
    const tamper = new Database(join(d, "agent-canvas.db"));
    tamper
      .prepare("UPDATE local_identity SET user_id = '99999999-9999-4999-8999-999999999999' WHERE slot = 'local'")
      .run();
    tamper.close();
    const reopened = openStore(d);
    try {
      expect(reopened.getLocalIdentity().user_id).toBe(first.user_id);
      expect(readMirror(d)).toMatchObject({ user_id: first.user_id });
    } finally {
      reopened.close();
    }
  });

  it("identidade estável entre aberturas normais", () => {
    const d = tmp();
    const a = openStore(d);
    const first = a.getLocalIdentity();
    a.close();
    const b = openStore(d);
    try {
      expect(b.getLocalIdentity()).toEqual(first);
      expect(existsSync(identityFilePath(d))).toBe(true);
    } finally {
      b.close();
    }
  });
});

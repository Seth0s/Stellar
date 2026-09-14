import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/main/store";
import { deriveSpawnDepth } from "../../src/main/spawn-record-decision";

describe("store.ts: spawn registry", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("records agent spawn with derived fields; survives reopen", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-reg-"));
    const store = openStore(dir);
    const row = store.recordSpawn({
      boardId: "b1",
      fromCardId: "orch",
      toCardId: "child",
      reason: "measure the spawn path",
      taskId: "t1",
      provider: "claude",
      cardKind: "terminal",
      cwd: "/tmp/proj",
      origin: "agent",
      createdAt: 1000,
    });
    expect(row.reason).toBe("measure the spawn path");
    expect(row.from_card_id).toBe("orch");
    expect(row.to_card_id).toBe("child");
    expect(row.task_id).toBe("t1");
    expect(row.provider).toBe("claude");
    expect(row.cwd).toBe("/tmp/proj");
    expect(row.origin).toBe("agent");
    store.close();

    const again = openStore(dir);
    const found = again.findSpawnByChild("child");
    expect(found).toMatchObject({
      reason: "measure the spawn path",
      from_card_id: "orch",
      to_card_id: "child",
      task_id: "t1",
      provider: "claude",
      cwd: "/tmp/proj",
      origin: "agent",
      created_at: 1000,
    });
    expect(again.listSpawnsByParent("orch")).toHaveLength(1);
    again.close();
  });

  it("records human spawn without reason or requester", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-human-"));
    const store = openStore(dir);
    store.recordSpawn({
      boardId: "b1",
      fromCardId: null,
      toCardId: "h1",
      reason: null,
      provider: "bash",
      cardKind: "terminal",
      cwd: "/home/x",
      origin: "human",
    });
    const found = store.findSpawnByChild("h1")!;
    expect(found.from_card_id).toBeNull();
    expect(found.reason).toBeNull();
    expect(found.origin).toBe("human");
    store.close();
  });

  it("derives depth across a 3-level agent chain after restart", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-spawn-depth-"));
    const store = openStore(dir);
    store.recordSpawn({
      boardId: "b1",
      fromCardId: null,
      toCardId: "root",
      reason: null,
      origin: "human",
      provider: "bash",
      cardKind: "terminal",
    });
    store.recordSpawn({
      boardId: "b1",
      fromCardId: "root",
      toCardId: "a1",
      reason: "level 1",
      origin: "agent",
      provider: "claude",
      cardKind: "terminal",
    });
    store.recordSpawn({
      boardId: "b1",
      fromCardId: "a1",
      toCardId: "a2",
      reason: "level 2",
      origin: "agent",
      provider: "claude",
      cardKind: "terminal",
    });
    store.recordSpawn({
      boardId: "b1",
      fromCardId: "a2",
      toCardId: "a3",
      reason: "level 3",
      origin: "agent",
      provider: "claude",
      cardKind: "terminal",
    });
    store.close();

    const again = openStore(dir);
    const parentOf = (id: string) => again.findSpawnByChild(id) ?? null;
    expect(deriveSpawnDepth("root", parentOf)).toBe(0);
    expect(deriveSpawnDepth("a1", parentOf)).toBe(1);
    expect(deriveSpawnDepth("a2", parentOf)).toBe(2);
    expect(deriveSpawnDepth("a3", parentOf)).toBe(3);
    expect(again.listSpawnsByParent("a2").map((s) => s.to_card_id)).toEqual(["a3"]);
    again.close();
  });
});

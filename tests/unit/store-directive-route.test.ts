import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/main/store";

// DESIGN-BACKLOG.md §0 "Relatorio nao chega ao orquestrador depois de um
// restart" — `findLatestDirectiveSender` is the SQL twin of
// `pickLatestDirectiveSender`: inbound `modified`, highest `updated_at`.

describe("store.ts: findLatestDirectiveSender", () => {
  let dir: string;
  let store: ReturnType<typeof openStore>;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeStore() {
    dir = mkdtempSync(join(tmpdir(), "stellar-store-directive-"));
    store = openStore(dir);
    return store;
  }

  it("escolhe a aresta modified inbound mais recente; ignora spawned e outros alvos", () => {
    const s = makeStore();
    s.upsertConnector({
      id: "c-spawned",
      board_id: "default",
      from_card_id: "spawner",
      to_card_id: "worker",
      updated_at: 500,
      kind: "spawned",
      label: null,
    });
    s.upsertConnector({
      id: "c-old",
      board_id: "default",
      from_card_id: "orch-a",
      to_card_id: "worker",
      updated_at: 100,
      kind: "modified",
      label: "brief antigo",
    });
    s.upsertConnector({
      id: "c-new",
      board_id: "default",
      from_card_id: "orch-b",
      to_card_id: "worker",
      updated_at: 300,
      kind: "modified",
      label: "brief novo",
    });
    s.upsertConnector({
      id: "c-other",
      board_id: "default",
      from_card_id: "orch-b",
      to_card_id: "outro",
      updated_at: 999,
      kind: "modified",
      label: "outro card",
    });

    expect(s.findLatestDirectiveSender("worker")).toBe("orch-b");
    expect(s.findLatestDirectiveSender("sem-diretiva")).toBeNull();
  });
});

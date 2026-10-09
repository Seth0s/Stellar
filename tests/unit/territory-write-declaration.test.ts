import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageBus,
  describeOutOfTerritoryWrites,
  outOfTerritoryWritesFromResultJson,
  type BusRequest,
} from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

/**
 * Item 6 do sticky — TERRITÓRIO QUE MORDE, mecanismo (a): a escrita FORA do
 * território declarado precisa ser ao menos DECLARADA/VERIFICÁVEL.
 *
 * Onde isto é aplicável foi MEDIDO antes de escolher: não há hook de `git add`
 * nem watch de filesystem (vedados por `task-contract-decision.ts`); o que já
 * existe é a verificação pós-hoc do `gate-runner`, que rotula cada arquivo com
 * `inTerritory`. Aqui NÃO se cria fonte nova — só se NOMEIA o que já foi medido.
 */

function gateRunWith(files: { path: string; inTerritory: boolean; territoryDeclared: boolean }[], declared: boolean): string {
  return JSON.stringify({
    gateRun: {
      diff: {
        gitRoot: "/repo",
        stat: "",
        patch: "",
        patchTruncated: false,
        files: files.map((f) => ({ ...f, status: "M" })),
        filesTruncated: false,
        total: files.length,
        outsideTerritory: files.filter((f) => f.territoryDeclared && !f.inTerritory).length,
        note: declared ? "" : "a task não declarou território",
      },
    },
  });
}

describe("escrita fora do território: declaração (puros)", () => {
  it("território DECLARADO com arquivos fora → nomeia os arquivos e conta", () => {
    const got = outOfTerritoryWritesFromResultJson(
      gateRunWith(
        [
          { path: "src/main/message-bus.ts", inTerritory: true, territoryDeclared: true },
          { path: "docs/outro.md", inTerritory: false, territoryDeclared: true },
        ],
        true,
      ),
    );
    expect(got).toEqual({ count: 1, files: ["docs/outro.md"], total: 2 });
    expect(describeOutOfTerritoryWrites(got!)).toContain("docs/outro.md");
    expect(describeOutOfTerritoryWrites(got!)).toContain("OUTSIDE the territory");
  });

  it("tudo dentro do território → declaração ZERO (não é violação)", () => {
    const got = outOfTerritoryWritesFromResultJson(
      gateRunWith([{ path: "src/main/message-bus.ts", inTerritory: true, territoryDeclared: true }], true),
    );
    expect(got).toEqual({ count: 0, files: [], total: 1 });
  });

  it("AUSÊNCIA de território é DADO — nada é declarado, nenhuma violação inventada", () => {
    // Nenhum arquivo rotulado (a task não declarou território).
    expect(
      outOfTerritoryWritesFromResultJson(
        gateRunWith([{ path: "qualquer.ts", inTerritory: false, territoryDeclared: false }], false),
      ),
    ).toBeNull();
    // Sem diff capturado / result vazio / JSON podre.
    expect(outOfTerritoryWritesFromResultJson(null)).toBeNull();
    expect(outOfTerritoryWritesFromResultJson(JSON.stringify({ ok: true }))).toBeNull();
    expect(outOfTerritoryWritesFromResultJson("não é json")).toBeNull();
    expect(outOfTerritoryWritesFromResultJson(gateRunWith([], false))).toBeNull();
  });
});

function taskWith(result_json: string | null): TaskRow {
  return {
    id: "t1",
    prompt: "faz X",
    provider: "commandcode",
    status: "done",
    card_id: null,
    board_id: "64",
    cwd: null,
    spawn_profile: null,
    result_json,
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
    created_at: 1,
    updated_at: 1,
  };
}

describe("escrita fora do território: verificação pelo get_task", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function getTask(result_json: string | null) {
    dir = mkdtempSync(join(tmpdir(), "stellar-territory-"));
    const task = taskWith(result_json);
    const callbacks = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "getTask") return (id: string) => (id === task.id ? task : undefined);
          if (prop === "getTaskCards") return () => [];
          if (prop === "getCardBoardId") return () => "64";
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(join(dir, "a.sock"), callbacks);
    const res = (await bus.handleRequest({ cmd: "get_task", taskId: "t1" } as BusRequest)) as unknown as {
      task?: { outOfTerritoryWrites?: unknown };
      outOfTerritoryWrites?: unknown;
    };
    return res.task?.outOfTerritoryWrites ?? res.outOfTerritoryWrites ?? null;
  }

  it("get_task NOMEIA os arquivos escritos fora do território", async () => {
    const got = await getTask(
      gateRunWith(
        [
          { path: "src/main/message-bus.ts", inTerritory: true, territoryDeclared: true },
          { path: "scripts/measure/x.mjs", inTerritory: false, territoryDeclared: true },
        ],
        true,
      ),
    );
    expect(got).toEqual({ count: 1, files: ["scripts/measure/x.mjs"], total: 2 });
  });

  it("sem território declarado, get_task não declara nada", async () => {
    const got = await getTask(gateRunWith([{ path: "x.ts", inTerritory: false, territoryDeclared: false }], false));
    expect(got).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { ACBRIDGE_PROTOCOL } from "../../src/main/acbridge-protocol-decision";

/**
 * Classe do truncamento em pipe (2026-09-14): `console.log` + `process.exit`
 * antes do drain → leitor do pipe só vê 65536 bytes (capacidade do buffer
 * do kernel). O teste abaixo sobe um bus real, pede `list-tasks` via o
 * acbridge do repo com stdout em PIPE, e exige o JSON inteiro. Sem o
 * `finish()`/`stdout.end` no acbridge, esta asserção falha em 65536.
 */

const ACBRIDGE_PATH = resolve(__dirname, "../../resources/bin/acbridge");
const PIPE_CAP = 65536;

describe("acbridge: stdout drain antes do exit (pipe > 64 KiB)", () => {
  let dir: string | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function baseTask(id: string, prompt: string): TaskRow {
    const now = Date.now();
    return {
      id,
      prompt,
      provider: "claude",
      status: "done",
      card_id: null,
      board_id: "board-drain",
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
    } as TaskRow;
  }

  function runAcbridgePipedByteCount(sockPath: string): Promise<{ code: number | null; bytes: number; stderr: string }> {
    // Reproduce the measured failure mode exactly: stdout into a shell pipe
    // (`| wc -c`). An eagerly-reading Node parent can race past the bug;
    // the shell pipeline is what agents actually do (`acbridge … | jq`).
    return new Promise((resolveP, reject) => {
      const child = spawn(
        "bash",
        [
          "-c",
          'node "$ACBRIDGE" list-tasks 2>"$ERRFILE" | wc -c',
        ],
        {
          env: {
            ...process.env,
            ACBRIDGE: ACBRIDGE_PATH,
            ERRFILE: join(dir!, "acbridge.err"),
            AGENT_CANVAS_SOCK: sockPath,
            AGENT_CANVAS_CARD_ID: "drain-test",
            AGENT_CANVAS_NODE: process.execPath,
            ELECTRON_RUN_AS_NODE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const errFile = join(dir!, "acbridge.err");
        try {
          stderr += readFileSync(errFile, "utf8");
        } catch {
          /* no stderr file */
        }
        resolveP({ code, bytes: Number(out.trim()), stderr });
      });
    });
  }

  it("list-tasks > 64 KiB via pipe chega inteiro (falharia em 65536 sem finish/drain)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-acbridge-drain-"));
    const store = openStore(dir);
    // ~90 × 1 KiB prompts → JSON bem acima de 64 KiB (e abaixo de um
    // timeout absurdo). O firehose real da DB ao vivo passou de 230 KiB.
    const chunk = "x".repeat(1024);
    for (let i = 0; i < 90; i++) {
      store.upsertTask(baseTask(`drain-${i}`, `prompt-${i}-${chunk}`));
    }
    const sockPath = join(dir, "agent-canvas.sock");
    const callbacks = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "listTasks") return () => store.listTasks();
          if (prop === "listTasksByBoard") return (boardId: string) => store.listTasksByBoard(boardId);
          if (prop === "listCards") return () => [];
          if (prop === "isCardAlive") return () => false;
          if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
          if (prop === "nextReportSeqSeed") return () => 0;
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(sockPath, callbacks);

    // Expected size = what the bus itself would serialize (no pipe).
    const direct = (await bus.handleRequest({ cmd: "list_tasks" } as BusRequest)) as { ok: boolean; tasks: unknown[] };
    expect(direct.ok).toBe(true);
    const expected = Buffer.from(JSON.stringify(direct.tasks) + "\n", "utf8");
    expect(expected.length).toBeGreaterThan(PIPE_CAP);

    // Wait for listen.
    for (let i = 0; i < 100; i++) {
      try {
        await bus.handleRequest({ cmd: "hello", protocol: ACBRIDGE_PROTOCOL } as unknown as BusRequest);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const { code, bytes, stderr } = await runAcbridgePipedByteCount(sockPath);
    expect(code, stderr).toBe(0);
    expect(
      bytes,
      `pipe truncated at ${bytes} (kernel cap ${PIPE_CAP}); acbridge must drain stdout before exit — expected ${expected.length}`,
    ).toBe(expected.length);

    store.close();
  });

  it("o script sai por finish()/stdout.end, não por process.exit cru após o print", () => {
    // Classe medida no shell: `node -e 'console.log("x".repeat(1e5));process.exit(0)' | wc -c`
    // → 65536. O acbridge real cobre a regressão acima; este pin impede
    // alguém "simplificar" de volta pro exit imediato.
    const source = readFileSync(ACBRIDGE_PATH, "utf8");
    expect(source).toMatch(/function finish\(/);
    expect(source).toMatch(/stream\.end\(one\)/);
    expect(source).toMatch(/finish\(0\);/);
    const afterHandlers = source.slice(source.lastIndexOf("browser-eval"));
    expect(afterHandlers).not.toMatch(/process\.exit\(0\)/);
  });
});

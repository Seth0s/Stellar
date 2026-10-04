import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskGates, type GateRunEvidence } from "../../src/main/gate-runner";
import { allGateLockSnapshots, resetGateLocks, type GateLockSnapshot } from "../../src/main/gate-lock";

/**
 * Task ff24b36d — gate EXCLUSIVO (`{ cmd, exclusive: "machine" }`): roda por
 * ÚLTIMO e sob o lock GLOBAL da máquina, depois dos gates comuns. Strings
 * continuam funcionando como hoje (compatibilidade).
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "stellar-gate-excl-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  resetGateLocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spySpawn(seen: string[], machineAt: Record<string, GateLockSnapshot | null>) {
  return ((_file: string, args: string[]) => {
    const command = args[args.length - 1] ?? "";
    seen.push(command);
    if (command.startsWith("exclusive")) {
      machineAt[command] = allGateLockSnapshots().find((s) => s.scope === "machine") ?? null;
    }
    const child: any = new EventEmitter();
    child.pid = 999_990;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => child.emit("close", 0, null), 0);
    return child;
  }) as never;
}

describe("gate-runner: gate exclusivo de máquina", () => {
  it("exclusivo roda POR ÚLTIMO e sob o lock GLOBAL (com holder = task)", async () => {
    const dir = tempDir();
    const seen: string[] = [];
    const machineAt: Record<string, GateLockSnapshot | null> = {};

    const evidence: GateRunEvidence = await runTaskGates({
      taskId: "t-excl",
      cwd: dir,
      declaredRoot: dir,
      gates: ["common-1", { cmd: "exclusive-1", exclusive: "machine" }, "common-2"],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: spySpawn(seen, machineAt),
    });

    // Ordem: os comuns na ordem declarada; o exclusivo por último.
    expect(seen).toEqual(["common-1", "common-2", "exclusive-1"]);
    expect(evidence.ok).toBe(true);
    // No instante do spawn do exclusivo, o lock de máquina estava em curso,
    // com o holder nomeando a task.
    expect(machineAt["exclusive-1"]?.running?.holder.taskId).toBe("t-excl");
    // E nada ficou preso depois.
    expect(allGateLockSnapshots()).toEqual([]);
  });

  it("SÓ strings continua funcionando (compatibilidade) e sem tocar o lock de máquina", async () => {
    const dir = tempDir();
    const seen: string[] = [];
    const machineAt: Record<string, GateLockSnapshot | null> = {};
    const evidence = await runTaskGates({
      taskId: "t-str",
      cwd: dir,
      declaredRoot: dir,
      gates: ["a", "b", "c"],
      timeoutMs: 5_000,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: spySpawn(seen, machineAt),
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(evidence.ok).toBe(true);
    expect(Object.keys(machineAt)).toEqual([]);
    expect(allGateLockSnapshots()).toEqual([]);
  });
});

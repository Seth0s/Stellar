import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLockedCommand } from "../../src/main/gate-locked-run";
import { allGateLockSnapshots, resetGateLocks } from "../../src/main/gate-lock";
import type { GateLockHolder } from "../../src/main/gate-lock";

/**
 * Task ff24b36d — `run_locked`/`gate-lock`: roda o comando PESADO do agente
 * sob o lock, devolve o exit code real, e LIBERA o lock mesmo quando o
 * processo morre (fim normal, erro ou timeout). Comandos `node -e` curtos:
 * sem rede, baratos, reais.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "stellar-gate-locked-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  resetGateLocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const holder = (label: string): GateLockHolder => ({ taskId: null, cardId: null, label });
const PATH = process.env.PATH ?? "";
const sleep = (script: string) => `node -e ${JSON.stringify(script)}`;
const SLEEP_250 = sleep("setTimeout(() => process.exit(0), 250)");
/** A lock key private to a test's temp dir — never the repository lock the app
 * gate may be holding while the suite runs under `acbridge gate-lock`. */
const privateKey = (cwd: string): string => join(cwd, ".test-gate-lock");

describe("runLockedCommand", () => {
  it("devolve o exit code REAL e a saída do processo", async () => {
    const cwd = tempDir();
    const ok = await runLockedCommand({ command: sleep("process.stdout.write('HELLO'); process.exit(0)"), cwd, scope: "repo", holder: holder("A"), pathValue: PATH, lockKey: privateKey(cwd) });
    expect(ok.ok).toBe(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("HELLO");

    const bad = await runLockedCommand({ command: sleep("process.stderr.write('BOOM'); process.exit(3)"), cwd, scope: "repo", holder: holder("A"), pathValue: PATH, lockKey: privateKey(cwd) });
    expect(bad.ok).toBe(false);
    expect(bad.exitCode).toBe(3);
    expect(bad.stderr).toContain("BOOM");
  });

  it("dois comandos na MESMA chave SERIALIZAM (o 2º espera)", async () => {
    const cwd = tempDir();
    const [a, b] = await Promise.all([
      runLockedCommand({ command: SLEEP_250, cwd, scope: "repo", holder: holder("A"), pathValue: PATH, lockKey: privateKey(cwd) }),
      runLockedCommand({ command: SLEEP_250, cwd, scope: "repo", holder: holder("B"), pathValue: PATH, lockKey: privateKey(cwd) }),
    ]);
    // `positionAtRequest` is the fact "entered directly" (0) or "waited" (>0);
    // `waitedMs` is a wall-clock duration that can tick once under load even on
    // direct entry, so it is not the assertion of interest.
    const positions = [a.positionAtRequest, b.positionAtRequest].sort((x, y) => x - y);
    expect(positions[0]).toBe(0); // um entrou direto
    expect(positions[1]).toBeGreaterThan(0); // o outro esperou o primeiro
    const waited = a.waitedMs > 0 ? a : b;
    expect(waited.holderWhileWaiting?.label === "A" || waited.holderWhileWaiting?.label === "B").toBe(true);
  });

  it("scope machine serializa comandos de repos DIFERENTES", async () => {
    const cwdA = tempDir();
    const cwdB = tempDir();
    const [a, b] = await Promise.all([
      runLockedCommand({ command: SLEEP_250, cwd: cwdA, scope: "machine", holder: holder("A"), pathValue: PATH }),
      runLockedCommand({ command: SLEEP_250, cwd: cwdB, scope: "machine", holder: holder("B"), pathValue: PATH }),
    ]);
    expect(Math.max(a.waitedMs, b.waitedMs)).toBeGreaterThan(0);
  });

  it("processo que MORRE (exit ≠ 0) LIBERA o lock", async () => {
    const cwd = tempDir();
    const first = await runLockedCommand({ command: sleep("process.exit(9)"), cwd, scope: "repo", holder: holder("A"), pathValue: PATH, lockKey: privateKey(cwd) });
    expect(first.exitCode).toBe(9);
    expect(allGateLockSnapshots()).toEqual([]);
    // O próximo entra DIRETO — nada ficou preso.
    const second = await runLockedCommand({ command: sleep("process.exit(0)"), cwd, scope: "repo", holder: holder("B"), pathValue: PATH, lockKey: privateKey(cwd) });
    expect(second.positionAtRequest).toBe(0);
    expect(second.exitCode).toBe(0);
  });

  it("TIMEOUT mata o processo e libera o lock (124 no chamador)", async () => {
    const cwd = tempDir();
    const res = await runLockedCommand({
      command: sleep("setTimeout(() => process.exit(0), 5000)"),
      cwd,
      scope: "repo",
      holder: holder("A"),
      timeoutMs: 300,
      pathValue: PATH,
      lockKey: privateKey(cwd),
    });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
    expect(allGateLockSnapshots()).toEqual([]);
  });
});

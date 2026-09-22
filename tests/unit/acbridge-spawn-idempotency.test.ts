import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * A SEGUNDA PORTA do spawn_agent: o CLI `acbridge` (task bf1fb0a7).
 *
 * Medido com o script REAL contra o bus real: `acbridge spawn-agent` não mandava
 * `reason` NENHUM, e o bus recusa spawn de agente sem ele — então, a partir de um
 * card (que é quando `AGENT_CANVAS_CARD_ID` existe), a CLI era recusada inteira:
 *
 *   $ AGENT_CANVAS_CARD_ID=… acbridge spawn-agent qualquer-coisa
 *   acbridge: missing reason — spawn by an agent requires reason (why this card)
 *
 * Sem `--reason` a `--idempotency-key` que este arquivo exercita nem chegaria a
 * ser alcançada. Os dois andam juntos porque são a MESMA coisa: a retentativa de
 * um spawn precisa poder dizer por que existe e não pode fabricar um segundo
 * card. Este teste roda o CLI de verdade (processo separado, filho real) contra
 * um bus real no socket, não uma simulação do payload.
 */
const ACBRIDGE_PATH = resolve(__dirname, "../../resources/bin/acbridge");
const execFileAsync = promisify(execFile);

describe("acbridge spawn-agent: --reason e --idempotency-key (bf1fb0a7)", () => {
  let dir: string | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function rig() {
    dir = mkdtempSync(join(tmpdir(), "stellar-acbridge-idem-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const spawned: Record<string, unknown>[] = [];
    const overrides: Record<string, unknown> = {
      onSpawnAgentRequest: (requestId: string, _requesterId: string, params: Record<string, unknown>) => {
        spawned.push(params);
        bus?.resolveSpawnAgent(requestId, { ok: true, cardId: "card-do-cli" });
      },
      listCards: () => [],
      listAllConnectors: () => [],
      listSpawnsByParent: () => [],
      findSpawnByChild: () => undefined,
      recordSpawn: () => ({ id: "spawn-stub" }),
      getCardBoardId: () => "118",
      isBoardAutonomous: () => false,
      nextReportSeqSeed: () => 0,
    };
    bus = createMessageBus(sockPath, new Proxy({}, { get: (_t, prop: string) => overrides[prop] ?? (() => undefined) }) as never);
    return { sockPath, spawned };
  }

  async function ready(sockPath: string) {
    for (let i = 0; i < 100; i++) {
      try {
        await execFileAsync(process.execPath, [ACBRIDGE_PATH, "version"], {
          env: { ...process.env, AGENT_CANVAS_SOCK: sockPath, AGENT_CANVAS_CARD_ID: "" },
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    throw new Error("bus socket never came up");
  }

  async function runCli(sockPath: string, cardId: string, args: string[]) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [ACBRIDGE_PATH, ...args], {
        env: { ...process.env, AGENT_CANVAS_SOCK: sockPath, AGENT_CANVAS_CARD_ID: cardId },
      });
      return { ok: true as const, stdout: stdout.trim() };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      return { ok: false as const, stderr: (e.stderr ?? "").trim(), stdout: (e.stdout ?? "").trim() };
    }
  }

  it("sem --reason a CLI continua recusada: o gate do bus não foi afrouxado", async () => {
    const { sockPath, spawned } = rig();
    await ready(sockPath);
    const res = await runCli(sockPath, "card-caller", ["spawn-agent", "bash"]);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/missing reason/);
    expect(spawned).toHaveLength(0);
  });

  it("com --reason a CLI spawna; com --idempotency-key, a retentativa devolve o MESMO card", async () => {
    const { sockPath, spawned } = rig();
    await ready(sockPath);
    const args = [
      "spawn-agent",
      "bash",
      "/tmp",
      "--reason",
      "medição: retentativa depois de timeout",
      "--brief",
      "primeira metade",
      "--idempotency-key",
      "bf1fb0a7/cli-retry",
    ];
    const first = await runCli(sockPath, "card-caller", args);
    expect(first.ok, first.ok ? "" : first.stderr).toBe(true);
    const second = await runCli(sockPath, "card-caller", args);
    expect(second.ok, second.ok ? "" : second.stderr).toBe(true);

    // UM card, duas chamadas — e a segunda se identifica como reuso.
    expect(spawned).toHaveLength(1);
    expect(JSON.parse(first.stdout).cardId).toBe("card-do-cli");
    const replay = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(replay.cardId).toBe("card-do-cli");
    expect(replay.idempotentReplay).toBe(true);
  });
});

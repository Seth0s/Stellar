import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMessageBus } from "../../src/main/message-bus";

/**
 * A segunda porta da confrontação (task 5d47312c): `acbridge unreported-work`.
 *
 * Roda o CLI REAL, em processo filho, contra um bus REAL no socket — mesma
 * disciplina do teste de idempotência do spawn: uma porta que só existe no MCP
 * é meia porta (agentes sem MCP, cards bash, scripts), e a única prova de que o
 * comando chega ao bus é o processo filho falando pelo socket.
 */
const ACBRIDGE_PATH = resolve(__dirname, "../../resources/bin/acbridge");
const execFileAsync = promisify(execFile);

describe("acbridge unreported-work", () => {
  let dir: string | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

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

  function rig() {
    dir = mkdtempSync(join(tmpdir(), "stellar-acbridge-coverage-"));
    const sockPath = join(dir, "agent-canvas.sock");
    bus = createMessageBus(
      sockPath,
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "listCoverageCards")
              return () => [
                {
                  cardId: "987654",
                  provider: "claude",
                  cwd: "/repo",
                  createdAtMs: 1_000_000,
                  taskId: "t1",
                  reportCount: 0,
                  live: 0,
                },
              ];
            if (prop === "discoverCoverageSessions")
              return () => [{ sessionId: "s-1", timestampMs: 1_003_000, sizeBytes: 2_048 }];
            if (prop === "countOrphanReports") return () => 0;
            if (prop === "listCards") return () => [];
            if (prop === "listAllConnectors") return () => [];
            return () => undefined;
          },
        },
      ) as never,
    );
    return sockPath;
  }

  it("devolve o JSON com as contagens e a evidência, pelo CLI de verdade", async () => {
    const sock = rig();
    await ready(sock);
    const { stdout } = await execFileAsync(process.execPath, [ACBRIDGE_PATH, "unreported-work"], {
      env: { ...process.env, AGENT_CANVAS_SOCK: sock, AGENT_CANVAS_CARD_ID: "999" },
    });
    const res = JSON.parse(stdout) as { ok: boolean; counts: Record<string, number>; findings: Record<string, unknown>[] };
    expect(res.ok).toBe(true);
    expect(res.counts.worked_unreported).toBe(1);
    expect(res.counts.worked_unreported_on_task).toBe(1);
    expect(res.findings[0].cardId).toBe("987654");
    expect(res.findings[0].sessionId).toBe("s-1");
    expect(res.findings[0].sizeBytes).toBe(2_048);
    // A frase de limite viaja junto: quem lê pela CLI também sabe o que o dado
    // NÃO sabe.
    expect(String(res.findings[0].why)).toMatch(/NOT in this data/);
  });

  it("limite inválido é recusado na porta, não silenciado", async () => {
    const sock = rig();
    await ready(sock);
    await expect(
      execFileAsync(process.execPath, [ACBRIDGE_PATH, "unreported-work", "zero"], {
        env: { ...process.env, AGENT_CANVAS_SOCK: sock, AGENT_CANVAS_CARD_ID: "999" },
      }),
    ).rejects.toThrow(/usage: acbridge unreported-work/);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { resolveBuildIdentity } from "../../src/main/build-identity";
import { ACBRIDGE_PROTOCOL } from "../../src/main/acbridge-protocol-decision";
import { createMessageBus } from "../../src/main/message-bus";

describe("resolveBuildIdentity", () => {
  it("dev dirty tree: honest label, no builtAt, never claims packaged", () => {
    const id = resolveBuildIdentity({
      isPackaged: false,
      version: "0.7.0",
      busProtocol: 2,
      gitProbe: () => ({ commit: "abc1234", dirty: true }),
    });
    expect(id).toEqual({
      mode: "dev",
      version: "0.7.0",
      commit: "abc1234",
      builtAt: null,
      dirty: true,
      busProtocol: 2,
      label: "dev abc1234 (dirty tree)",
    });
  });

  it("dev clean tree: label without dirty marker", () => {
    const id = resolveBuildIdentity({
      isPackaged: false,
      version: "0.7.0",
      busProtocol: 2,
      gitProbe: () => ({ commit: "abc1234", dirty: false }),
    });
    expect(id.label).toBe("dev abc1234");
    expect(id.dirty).toBe(false);
    expect(id.builtAt).toBeNull();
  });

  it("packaged: uses injected stamps, never dirty", () => {
    const id = resolveBuildIdentity({
      isPackaged: true,
      version: "0.7.0",
      busProtocol: 2,
      stamps: { commit: "14b5bd0", builtAt: "2026-09-14T13:00:00.000Z" },
    });
    expect(id).toEqual({
      mode: "packaged",
      version: "0.7.0",
      commit: "14b5bd0",
      builtAt: "2026-09-14T13:00:00.000Z",
      dirty: false,
      busProtocol: 2,
      label: "packaged 14b5bd0 @ 2026-09-14T13:00:00.000Z",
    });
  });

  it("packaged without stamps: still readable via version", () => {
    const id = resolveBuildIdentity({
      isPackaged: true,
      version: "0.7.0",
      busProtocol: 2,
      stamps: { commit: null, builtAt: null },
    });
    expect(id.label).toBe("packaged v0.7.0 (no build stamp)");
    expect(id.commit).toBeNull();
  });
});

describe("bus consumers: build_identity + hello", () => {
  let dir: string | null = null;
  let bus: ReturnType<typeof createMessageBus> | null = null;

  afterEach(() => {
    bus?.close();
    bus = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const identity = {
    mode: "packaged" as const,
    version: "0.7.0",
    commit: "proof-bbb",
    builtAt: "2026-09-14T15:30:00.000Z",
    dirty: false,
    busProtocol: ACBRIDGE_PROTOCOL,
    label: "packaged proof-bbb @ 2026-09-14T15:30:00.000Z",
  };

  function makeBus() {
    dir = mkdtempSync(join(tmpdir(), "stellar-build-identity-"));
    const sockPath = join(dir, "agent-canvas.sock");
    const callbacks = new Proxy(
      { getBuildIdentity: () => identity },
      {
        get: (t, prop: string) => {
          if (prop === "getBuildIdentity") return t.getBuildIdentity;
          if (prop === "listCards") return () => [];
          if (prop === "nextReportSeqSeed") return () => 0;
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
    bus = createMessageBus(sockPath, callbacks);
    return sockPath;
  }

  function roundtrip(sockPath: string, lines: unknown[]): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolveP, reject) => {
      let data = "";
      const socket = connect({ path: sockPath }, () => {
        socket.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      });
      socket.on("data", (c) => (data += c.toString("utf8")));
      socket.on("end", () => resolveP(data.trim().split("\n").map((l) => JSON.parse(l))));
      socket.on("error", reject);
    });
  }

  async function ready(sockPath: string) {
    for (let i = 0; i < 100; i++) {
      try {
        await roundtrip(sockPath, [{ cmd: "hello", protocol: ACBRIDGE_PROTOCOL }]);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    throw new Error("bus socket never came up");
  }

  it("orchestrator: build_identity cmd returns the process identity", async () => {
    const sock = makeBus();
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "build_identity", protocol: ACBRIDGE_PROTOCOL }]);
    expect(res).toEqual({ ok: true, ...identity });
  });

  it("orchestrator: hello carries the same identity beside protocol", async () => {
    const sock = makeBus();
    await ready(sock);
    const [res] = await roundtrip(sock, [{ cmd: "hello", protocol: ACBRIDGE_PROTOCOL }]);
    expect(res).toMatchObject({ ok: true, protocol: ACBRIDGE_PROTOCOL, ...identity });
  });
});

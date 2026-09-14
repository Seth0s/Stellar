import { describe, expect, it } from "vitest";
import {
  decidePtyHoldAppend,
  decideRendererGone,
  decideSafeSend,
  decideSafeSendErrorLog,
  formatRendererGoneLogLine,
  isFrameDisposedError,
  pruneRendererGoneReloads,
  RENDERER_GONE_PTY_HOLD,
  RENDERER_GONE_RETRY,
} from "../../src/main/renderer-gone-decision";

describe("decideRendererGone", () => {
  const base = {
    exitCode: 1,
    nowMs: 100_000,
    recentReloadAtMs: [] as number[],
    windowAlive: true,
    isQuitting: false,
  };

  it("ignora clean-exit (saída normal do webContents)", () => {
    expect(decideRendererGone({ ...base, reason: "clean-exit" })).toEqual({
      action: "ignore",
      record: false,
      why: "clean-exit",
    });
  });

  it("ignora durante quit / janela morta", () => {
    expect(decideRendererGone({ ...base, reason: "crashed", isQuitting: true }).action).toBe("ignore");
    expect(decideRendererGone({ ...base, reason: "crashed", windowAlive: false }).action).toBe("ignore");
  });

  it("recarrega no primeiro crash (PTY vive no main)", () => {
    expect(decideRendererGone({ ...base, reason: "crashed" })).toEqual({
      action: "reload",
      record: true,
      reloadsInWindow: 0,
    });
    expect(decideRendererGone({ ...base, reason: "oom" }).action).toBe("reload");
    expect(decideRendererGone({ ...base, reason: "killed" }).action).toBe("reload");
  });

  it("permite até maxReloads, depois quit por retry-limit", () => {
    const t0 = 100_000;
    const afterOne = decideRendererGone({
      ...base,
      reason: "crashed",
      nowMs: t0 + 1_000,
      recentReloadAtMs: [t0],
    });
    expect(afterOne).toEqual({ action: "reload", record: true, reloadsInWindow: 1 });

    const atLimit = decideRendererGone({
      ...base,
      reason: "crashed",
      nowMs: t0 + 2_000,
      recentReloadAtMs: [t0, t0 + 1_000],
    });
    expect(atLimit).toEqual({
      action: "quit",
      record: true,
      why: "retry-limit",
      reloadsInWindow: 2,
    });
    expect(RENDERER_GONE_RETRY.maxReloads).toBe(2);
  });

  it("janela deslizante esquece reloads velhos", () => {
    const nowMs = 200_000;
    const stale = nowMs - RENDERER_GONE_RETRY.windowMs - 1_000;
    const decision = decideRendererGone({
      ...base,
      reason: "crashed",
      nowMs,
      recentReloadAtMs: [stale - 200, stale - 100, stale],
    });
    expect(decision).toEqual({ action: "reload", record: true, reloadsInWindow: 0 });
  });

  it("quit imediato em launch-failed / integrity-failure", () => {
    expect(decideRendererGone({ ...base, reason: "launch-failed" })).toMatchObject({
      action: "quit",
      why: "unrecoverable-reason",
    });
    expect(decideRendererGone({ ...base, reason: "integrity-failure" })).toMatchObject({
      action: "quit",
      why: "unrecoverable-reason",
    });
  });
});

describe("pruneRendererGoneReloads / formatRendererGoneLogLine", () => {
  it("prune corta fora da janela", () => {
    expect(pruneRendererGoneReloads([10, 50, 90], 100, 40)).toEqual([90]);
  });

  it("log line é JSON com action e reason", () => {
    const line = formatRendererGoneLogLine({
      atMs: Date.parse("2026-09-14T14:30:36.000Z"),
      reason: "crashed",
      exitCode: 5,
      decision: { action: "reload", record: true, reloadsInWindow: 0 },
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      at: "2026-09-14T14:30:36.000Z",
      reason: "crashed",
      exitCode: 5,
      action: "reload",
      reloadsInWindow: 0,
    });
  });
});

describe("decideSafeSend", () => {
  it("bloqueia janela/contents destruídos e frame inalcançável", () => {
    expect(
      decideSafeSend({ windowDestroyed: true, contentsDestroyed: false, rendererReachable: true }).reason,
    ).toBe("window-destroyed");
    expect(
      decideSafeSend({ windowDestroyed: false, contentsDestroyed: true, rendererReachable: true }).reason,
    ).toBe("contents-destroyed");
    expect(
      decideSafeSend({ windowDestroyed: false, contentsDestroyed: false, rendererReachable: false }).reason,
    ).toBe("renderer-unreachable");
    expect(
      decideSafeSend({ windowDestroyed: false, contentsDestroyed: false, rendererReachable: true }),
    ).toEqual({ action: "send" });
  });
});

describe("decideSafeSendErrorLog", () => {
  it("reconhece o erro do journal 2026-09-14", () => {
    expect(
      isFrameDisposedError("Render frame was disposed before WebFrameMain could be accessed"),
    ).toBe(true);
  });

  it("loga só o primeiro frame-disposed da streak; outros erros sempre", () => {
    expect(
      decideSafeSendErrorLog({
        errorMessage: "Render frame was disposed before WebFrameMain could be accessed",
        consecutiveFrameDisposed: 0,
      }),
    ).toEqual({ log: true, kind: "frame-disposed" });
    expect(
      decideSafeSendErrorLog({
        errorMessage: "Render frame was disposed before WebFrameMain could be accessed",
        consecutiveFrameDisposed: 1,
      }),
    ).toEqual({ log: false, kind: "frame-disposed" });
    expect(
      decideSafeSendErrorLog({
        errorMessage: "Object has been destroyed",
        consecutiveFrameDisposed: 99,
      }),
    ).toEqual({ log: true, kind: "other" });
  });
});

describe("decidePtyHoldAppend", () => {
  it("acumula abaixo do teto", () => {
    expect(decidePtyHoldAppend({ existingBytes: 10, incoming: "abcd" })).toEqual({
      action: "append",
      nextBytes: 14,
    });
  });

  it("trunca a cabeça quando estoura o teto (mantém cauda)", () => {
    const max = 8;
    const decision = decidePtyHoldAppend({
      existingBytes: 6,
      incoming: "ABCDEFGH", // 8 → total 14
      maxBytes: max,
    });
    expect(decision.action).toBe("append-truncate-head");
    if (decision.action === "append-truncate-head") {
      expect(decision.nextBytes).toBe(max);
      expect(decision.keepFrom).toBe(6); // 14 - 8
      const joined = "oldold" + "ABCDEFGH";
      expect(joined.slice(decision.keepFrom)).toHaveLength(max);
    }
    expect(RENDERER_GONE_PTY_HOLD.maxBytesPerCard).toBe(512_000);
  });
});

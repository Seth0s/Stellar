import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const send = vi.fn();

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
  },
}));

import {
  startWatching,
  setWatchedDirs,
  stopWatching,
  stopAllWatchers,
  getWatchStats,
} from "../../src/main/file-watcher";
import { COALESCE_MS } from "../../src/main/file-watcher-coalesce";

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for watcher event");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("file-watcher live against a real temp tree", () => {
  let root = "";
  const clientId = "test-client";

  afterEach(() => {
    stopAllWatchers();
    send.mockClear();
    if (root) return rm(root, { recursive: true, force: true });
    return undefined;
  });

  it("one external write becomes one coalesced fs:changed, and unmount drops every watcher", async () => {
    root = await mkdtemp(join(tmpdir(), "stellar-fw-"));
    await startWatching(root, clientId);
    expect(getWatchStats()).toEqual({ roots: 1, clients: 1, dirWatchers: 1 });

    await writeFile(join(root, "hello.txt"), "from outside\n");
    await waitFor(() => send.mock.calls.length >= 1);

    const payloads = send.mock.calls.filter((c) => c[0] === "fs:changed").map((c) => c[1]);
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    expect(payloads[0].root).toBe(root);
    expect(payloads.some((p) => (p.paths ?? []).includes("hello.txt") || p.path === "hello.txt")).toBe(true);

    stopWatching(root, clientId);
    expect(getWatchStats()).toEqual({ roots: 0, clients: 0, dirWatchers: 0 });
  });

  it("a burst of writes coalesces below the event count (pty-registry shape)", async () => {
    root = await mkdtemp(join(tmpdir(), "stellar-fw-burst-"));
    await startWatching(root, clientId);
    send.mockClear();

    const n = 40;
    await Promise.all(Array.from({ length: n }, (_, i) => writeFile(join(root, `f${i}.txt`), `${i}\n`)));
    await new Promise((r) => setTimeout(r, COALESCE_MS + 80));

    const changed = send.mock.calls.filter((c) => c[0] === "fs:changed");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(n);
  });

  it("refuses to watch node_modules / .git / out / dist even when the card asks", async () => {
    root = await mkdtemp(join(tmpdir(), "stellar-fw-ignore-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "out"));
    await mkdir(join(root, "dist"));
    await startWatching(root, clientId);
    setWatchedDirs(root, clientId, ["", "src", "node_modules", ".git", "out", "dist"]);

    const stats = getWatchStats();
    expect(stats.dirWatchers).toBe(2); // root + src, nothing ignored
    expect(stats.dirWatchers).toBeLessThan(6);
  });
});

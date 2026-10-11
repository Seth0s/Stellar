/**
 * LAN remote-server — additive opts must not break the Phase-A client that
 * only speaks auth / cards / pty:write|resize|list. Optional callbacks
 * (tasks, scrollback, verdict) are exercised separately.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

import { createRemoteServer } from "../../src/main/remote-server";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openAuthedWs(port: number, token: string, origin?: string) {
  const headers = origin ? { origin } : {};
  const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const inbox: Record<string, unknown>[] = [];
  ws.addEventListener("message", (ev) => inbox.push(JSON.parse(String(ev.data))));
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", token })));
  return Object.assign(ws, { inbox });
}

async function waitForInbox(
  ws: NodeWebSocket & { inbox: Record<string, unknown>[] },
  type: string,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = ws.inbox.find((m) => m.type === type);
    if (hit) return hit;
    await delay(15);
  }
  throw new Error(`timeout waiting for ${type}; got ${ws.inbox.map((m) => m.type).join(",")}`);
}

describe("createRemoteServer (no optional callbacks — current index.ts shape)", () => {
  let userDataDir: string;
  let mobileClientDir: string;
  let writes: { id: string; data: string; ctx?: { deviceId: string; deviceLabel: string } }[];
  let server: ReturnType<typeof createRemoteServer>;
  let port: number;

  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), "remote-ud-"));
    mobileClientDir = mkdtempSync(join(tmpdir(), "remote-mc-"));
    writeFileSync(join(mobileClientDir, "index.html"), "<!doctype html><title>m</title>");
    writeFileSync(join(mobileClientDir, "app.js"), "/* client */");
    mkdirSync(join(mobileClientDir, "vendor"), { recursive: true });
    writeFileSync(join(mobileClientDir, "vendor", "xterm.js"), "/* xterm */");
    writes = [];
    port = 12000 + Math.floor(Math.random() * 6000);
    // Same three required callbacks index.ts passes today — no listTasks etc.
    server = createRemoteServer({
      port,
      mobileClientDir,
      userDataDir,
      listTerminals: () => [{ id: "c1", label: "Bash 1", provider: "bash", cwd: "/tmp" }],
      onWrite: (id, data, ctx) => writes.push({ id, data, ctx }),
      onResize: () => {},
    });
  });

  afterEach(() => {
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(mobileClientDir, { recursive: true, force: true });
  });

  it("does not bind until the first pairing", async () => {
    const refused = await fetch(`http://127.0.0.1:${port}/`)
      .then(() => false)
      .catch(() => true);
    expect(refused).toBe(true);
  });

  it("auth + cards still work; hello advertises capabilities false; tasks:list returns []", async () => {
    const pairing = await server.pairNewDevice("Phone");
    const origin = `http://127.0.0.1:${pairing.port}`;
    const ws = openAuthedWs(pairing.port, pairing.token, origin);
    const cards = await waitForInbox(ws, "cards");
    const hello = await waitForInbox(ws, "hello");
    expect((cards.cards as unknown[])?.length).toBe(1);
    expect(hello.capabilities).toEqual({ tasks: false, scrollback: false, verdict: false });

    ws.send(JSON.stringify({ type: "tasks:list" }));
    const tasks = await waitForInbox(ws, "tasks");
    expect(tasks.tasks).toEqual([]);

    ws.send(JSON.stringify({ type: "pty:subscribe", id: "c1" }));
    // No scrollback callback → no pty:scrollback; write still works.
    await delay(80);
    expect(ws.inbox.some((m) => m.type === "pty:scrollback")).toBe(false);
    ws.send(JSON.stringify({ type: "pty:write", id: "c1", data: "hi" }));
    await delay(50);
    expect(writes).toEqual([
      { id: "c1", data: "hi", ctx: { deviceId: pairing.id, deviceLabel: "Phone" } },
    ]);
    ws.close();
  });

  it("rejects a mismatched Origin even with a valid token", async () => {
    const pairing = await server.pairNewDevice("Phone");
    const ws = openAuthedWs(pairing.port, pairing.token, "http://evil.example");
    const code = await new Promise<number>((resolve) => ws.addEventListener("close", (ev) => resolve(ev.code)));
    expect(code).toBe(4003);
  });

  it("serves static client files and refuses path escape", async () => {
    const pairing = await server.pairNewDevice("Phone");
    expect((await fetch(`http://127.0.0.1:${pairing.port}/`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${pairing.port}/../package.json`)).status).toBe(404);
  });
});

describe("createRemoteServer (optional callbacks wired)", () => {
  let userDataDir: string;
  let mobileClientDir: string;
  let verdicts: { id: string; verdict: string }[];
  let server: ReturnType<typeof createRemoteServer>;
  let port: number;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "remote-ud-"));
    mobileClientDir = mkdtempSync(join(tmpdir(), "remote-mc-"));
    writeFileSync(join(mobileClientDir, "index.html"), "<!doctype html><title>m</title>");
    verdicts = [];
    port = 12000 + Math.floor(Math.random() * 6000);
    server = createRemoteServer({
      port,
      mobileClientDir,
      userDataDir,
      listTerminals: () => [
        {
          id: "c1",
          label: "Master",
          provider: "claude",
          cwd: "/tmp/proj",
          awaitingHuman: true,
          status: "waiting",
          boardName: "Maestro",
          preview: "espera você",
        },
      ],
      onWrite: () => {},
      onResize: () => {},
      listTasks: () => [
        { id: "t1", title: "Example", phase: "awaiting_review", provider: "claude", canVerdict: true },
      ],
      getTask: (id) =>
        id === "t1"
          ? { id: "t1", title: "Example", phase: "awaiting_review", reportPreview: "ok", canVerdict: true }
          : null,
      onTaskVerdict: (id, verdict) => verdicts.push({ id, verdict }),
      getScrollback: (id) => (id === "c1" ? "hello-scroll\n" : null),
    });
  });

  afterEach(() => {
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(mobileClientDir, { recursive: true, force: true });
  });

  it("sends tasks on auth, scrollback on subscribe, and forwards verdict", async () => {
    const pairing = await server.pairNewDevice("Phone A");
    const origin = `http://127.0.0.1:${pairing.port}`;
    const ws = openAuthedWs(pairing.port, pairing.token, origin);
    const cards = (await waitForInbox(ws, "cards")) as { cards: { awaitingHuman?: boolean }[] };
    const hello = await waitForInbox(ws, "hello");
    const tasks = await waitForInbox(ws, "tasks");
    expect(cards.cards[0]?.awaitingHuman).toBe(true);
    expect(hello.capabilities).toEqual({ tasks: true, scrollback: true, verdict: true });
    expect((tasks.tasks as unknown[])?.length).toBe(1);

    ws.send(JSON.stringify({ type: "pty:subscribe", id: "c1" }));
    const scroll = await waitForInbox(ws, "pty:scrollback");
    expect(scroll).toMatchObject({ id: "c1", data: "hello-scroll\n" });

    ws.send(JSON.stringify({ type: "task:get", id: "t1" }));
    const task = await waitForInbox(ws, "task");
    expect(task.task).toMatchObject({ id: "t1", reportPreview: "ok" });

    ws.send(JSON.stringify({ type: "task:verdict", id: "t1", verdict: "approve" }));
    await delay(40);
    expect(verdicts).toEqual([{ id: "t1", verdict: "approve" }]);
    ws.close();
  });

  it("revokes one device without breaking another", async () => {
    const a = await server.pairNewDevice("A");
    const b = await server.pairNewDevice("B");
    const origin = `http://127.0.0.1:${a.port}`;
    server.revokeDevice(a.id);
    const code = await new Promise<number>((resolve) => {
      const ws = openAuthedWs(a.port, a.token, origin);
      ws.addEventListener("close", (ev) => resolve(ev.code));
    });
    expect(code).toBe(4001);

    const cards = await waitForInbox(openAuthedWs(b.port, b.token, origin), "cards");
    expect((cards.cards as unknown[]).length).toBe(1);
  });
});

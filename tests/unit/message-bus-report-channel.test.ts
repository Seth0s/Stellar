import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ReportRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { ACBRIDGE_PROTOCOL } from "../../src/main/acbridge-protocol-decision";

// `channel` on reports — server stamps ingress (http|socket), never the
// agent. Gate: socket row ≠ http row; pre-column rows stay NULL; get_report
// does not widen the API with channel (owner measurement is a SELECT).

function callbacksBackedByStore(store: ReturnType<typeof openStore>): Parameters<typeof createMessageBus>[1] {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === "getReport") return (cardId: string, afterSeq?: number) => store.getReport(cardId, afterSeq);
        if (prop === "upsertReport") return (row: ReportRow) => store.upsertReport(row);
        if (prop === "nextReportSeqSeed") return () => store.nextReportSeqSeed();
        if (prop === "listTaskCardsForCard") return () => [];
        if (prop === "recordParticipationRound") return () => undefined;
        if (prop === "listTasks") return () => [];
        if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
        if (prop === "listCards") return () => [];
        // O rig não tem pty-registry: todo id que ele nomeia É um card vivo.
        // Sem esta linha o Proxy devolveria `undefined` para `isCardAlive`, e
        // o guarda de identidade do `report` (task 34e27f66) recusaria um
        // relatório legítimo por "o card não existe" — o guarda é exercitado,
        // com os dois lados, em report-card-identity-existence.test.ts.
        if (prop === "isCardAlive") return () => true;
        return () => undefined;
      },
    },
  ) as Parameters<typeof createMessageBus>[1];
}

function rawChannel(dir: string, cardId: string): string | null {
  const raw = new Database(join(dir, "agent-canvas.db"), { readonly: true });
  try {
    return (
      raw.prepare("SELECT channel FROM reports WHERE card_id = ? ORDER BY seq DESC LIMIT 1").get(cardId) as {
        channel: string | null;
      }
    ).channel;
  } finally {
    raw.close();
  }
}

function socketReport(sockPath: string, body: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        sock.end();
        try {
          resolve(JSON.parse(buf.trim()) as Record<string, unknown>);
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", reject);
    sock.write(JSON.stringify({ ...body, protocol: ACBRIDGE_PROTOCOL }) + "\n");
  });
}

describe("reports.channel — ingress stamped by the server", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("report via handleRequest({channel:'http'}) stores http; {channel:'socket'} stores socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-channel-"));
    const store = openStore(dir);
    const bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store));
    try {
      const httpRes = (await bus.handleRequest(
        { cmd: "report", requesterId: "c-http", report: { ok: true } } as BusRequest,
        { channel: "http" },
      )) as { ok: boolean; seq: number };
      expect(httpRes.ok).toBe(true);
      expect(rawChannel(dir, "c-http")).toBe("http");
      expect(store.getReport("c-http")!.channel).toBe("http");

      const sockRes = (await bus.handleRequest(
        { cmd: "report", requesterId: "c-sock", report: { ok: true } } as BusRequest,
        { channel: "socket" },
      )) as { ok: boolean; seq: number };
      expect(sockRes.ok).toBe(true);
      expect(rawChannel(dir, "c-sock")).toBe("socket");
      expect(store.getReport("c-sock")!.channel).toBe("socket");
    } finally {
      bus.close();
      store.close();
    }
  });

  it("real Unix-socket ingress stamps channel=socket (bus frontend, not a test opts stub)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-channel-sock-"));
    const store = openStore(dir);
    const sockPath = join(dir, "b.sock");
    const bus = createMessageBus(sockPath, callbacksBackedByStore(store));
    try {
      // Wait until the server is listening — createMessageBus binds async.
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const tick = () => {
          const probe = createConnection(sockPath);
          probe.once("connect", () => {
            probe.end();
            resolve();
          });
          probe.once("error", () => {
            if (Date.now() > deadline) reject(new Error("socket not ready"));
            else setTimeout(tick, 20);
          });
        };
        tick();
      });

      const res = await socketReport(sockPath, {
        cmd: "report",
        requesterId: "via-sock",
        report: { ok: true, via: "acbridge" },
      });
      expect(res.ok).toBe(true);
      expect(rawChannel(dir, "via-sock")).toBe("socket");
    } finally {
      bus.close();
      store.close();
    }
  });

  it("omit opts → channel null; get_report does not expose channel", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-channel-omit-"));
    const store = openStore(dir);
    const bus = createMessageBus(join(dir, "c.sock"), callbacksBackedByStore(store));
    try {
      await bus.handleRequest({ cmd: "report", requesterId: "c-omit", report: { ok: true } } as BusRequest);
      expect(rawChannel(dir, "c-omit")).toBeNull();

      const got = (await bus.handleRequest({ cmd: "get_report", target: "c-omit" } as BusRequest)) as Record<
        string,
        unknown
      >;
      expect(got.ok).toBe(true);
      expect(got).not.toHaveProperty("channel");
      expect(got).toHaveProperty("seq");
      expect(got).toHaveProperty("verdict");
      expect(got).toHaveProperty("role");
    } finally {
      bus.close();
      store.close();
    }
  });

  it("pre-column rows stay null after migrate (no backfill)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-report-channel-mig-"));
    const dbPath = join(dir, "agent-canvas.db");
    // Only `reports` as it was BEFORE channel — do NOT pre-create cards/
    // boards (incomplete stubs break openStore's prepared statements).
    // openStore CREATE TABLE IF NOT EXISTS for the rest; migrate ALTERs
    // reports ADD COLUMN channel (NULL for the legacy row).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE reports (
        seq INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        verdict TEXT,
        role TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare("INSERT INTO reports (seq, card_id, report_json, verdict, role, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(1, "legacy", JSON.stringify({ ok: true }), null, null, Date.now());
    raw.close();

    const store = openStore(dir);
    try {
      const row = store.getReport("legacy");
      expect(row).toBeDefined();
      expect(row!.channel).toBeNull();
      store.upsertReport({
        card_id: "fresh",
        seq: 2,
        report_json: "{}",
        channel: "http",
        updated_at: Date.now(),
      });
      expect(store.getReport("legacy")!.channel).toBeNull();
      expect(store.getReport("fresh")!.channel).toBe("http");
    } finally {
      store.close();
    }
  });
});

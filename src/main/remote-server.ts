import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import QRCode from "qrcode";

export type TerminalSummary = { id: string; label: string | null; provider: string; cwd: string };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * Phase A of DESIGN-BACKLOG.md item 2 — LAN-only mobile control. This is
 * deliberately NOT a pixel mirror: it serves a small standalone web client
 * (resources/mobile-client, plain HTML/JS/xterm.js, no React/Vite build of
 * its own) that talks to the real terminal state over a WebSocket, the same
 * way `acbridge`/message-bus already does for agents. Chosen over
 * `capturePage()`-based screen-share specifically because that path is
 * already proven broken on this machine for `WebContentsView` content (see
 * AGENTS.md) — mirroring app *state* instead of *pixels* sidesteps that
 * bug entirely for terminal/files/changes/sticky (all plain DOM upstream
 * too), at the cost of building a second, simpler front-end.
 *
 * No scrollback: a client that attaches only sees data from that moment
 * forward, same limitation as `acbridge`'s own live streams — nothing here
 * buffers history servers-side.
 *
 * Auth is a single rotating token (QR-paired, Tailscale/Syncthing-style),
 * checked on the WebSocket upgrade only — the static HTML/JS shell itself
 * is not secret (it's just code), but every state a browser can read plus
 * every the write (typing into someone's terminal) is behind the token.
 * `revoke()` drops every connected client immediately, for when the QR
 * code might have been seen by the wrong person.
 */
export function createRemoteServer(opts: {
  port: number;
  mobileClientDir: string;
  listTerminals: () => TerminalSummary[];
  onWrite: (id: string, data: string) => void;
  onResize: (id: string, cols: number, rows: number) => void;
}) {
  let token = randomBytes(16).toString("hex");
  const clients = new Set<WebSocket>();
  let httpServer: Server | null = null;
  let wss: WebSocketServer | null = null;

  async function serveStatic(pathname: string): Promise<{ body: Buffer; type: string } | null> {
    const rel = pathname === "/" ? "/index.html" : pathname;
    // No `..` traversal beyond the client dir — this directory is served
    // to anyone who can reach the LAN port, unauthenticated, by design
    // (see the auth note above), so it has to be inert on its own.
    if (rel.includes("..")) return null;
    const filePath = join(opts.mobileClientDir, rel);
    if (!filePath.startsWith(opts.mobileClientDir) || !existsSync(filePath)) return null;
    try {
      const body = await readFile(filePath);
      return { body, type: MIME[extname(filePath)] ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }

  httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    serveStatic(url.pathname).then((file) => {
      if (!file) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": file.type });
      res.end(file.body);
    });
  });

  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "", "http://internal");
    if (url.searchParams.get("token") !== token) {
      ws.close(4001, "unauthorized");
      return;
    }
    clients.add(ws);
    ws.send(JSON.stringify({ type: "cards", cards: opts.listTerminals() }));

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "pty:write" && typeof msg.id === "string" && typeof msg.data === "string") {
        opts.onWrite(msg.id, msg.data);
      } else if (
        msg.type === "pty:resize" &&
        typeof msg.id === "string" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        opts.onResize(msg.id, msg.cols, msg.rows);
      } else if (msg.type === "list") {
        ws.send(JSON.stringify({ type: "cards", cards: opts.listTerminals() }));
      }
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  httpServer.listen(opts.port, "0.0.0.0");

  function broadcast(payload: unknown) {
    const data = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  /** Real, non-loopback LAN addresses only — a phone on the same Wi-Fi
   * needs one of these, `127.0.0.1` is useless to it. Every match is
   * returned (not just the first) because a laptop can have more than one
   * live interface (Wi-Fi + wired, or a VPN) and only one may actually be
   * the LAN the phone shares. */
  function lanAddresses(): string[] {
    const addrs: string[] = [];
    for (const iface of Object.values(networkInterfaces())) {
      for (const addr of iface ?? []) {
        if (addr.family === "IPv4" && !addr.internal) addrs.push(addr.address);
      }
    }
    return addrs;
  }

  async function getPairing() {
    const addrs = lanAddresses();
    const primary = addrs[0];
    const url = primary ? `http://${primary}:${opts.port}/?token=${token}` : null;
    return {
      token,
      port: opts.port,
      addresses: addrs,
      url,
      qrDataUrl: url ? await QRCode.toDataURL(url, { margin: 1, width: 240 }) : null,
    };
  }

  function revoke() {
    token = randomBytes(16).toString("hex");
    for (const ws of clients) ws.close(4001, "revoked");
    clients.clear();
  }

  function close() {
    for (const ws of clients) ws.close();
    clients.clear();
    wss?.close();
    httpServer?.close();
  }

  return {
    broadcastPtyData: (id: string, data: string) => broadcast({ type: "pty:data", id, data }),
    broadcastPtyExit: (id: string, exitCode: number) => broadcast({ type: "pty:exit", id, exitCode }),
    broadcastCards: () => broadcast({ type: "cards", cards: opts.listTerminals() }),
    getPairing,
    revoke,
    connectionCount: () => clients.size,
    close,
  };
}

export type RemoteServer = ReturnType<typeof createRemoteServer>;

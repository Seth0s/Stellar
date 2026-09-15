import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { safeStorage } from "electron";
import { WebSocketServer, type WebSocket } from "ws";
import QRCode from "qrcode";

export type TerminalSummary = { id: string; label: string | null; provider: string; cwd: string };

/** A single paired phone (DESIGN-BACKLOG.md item 2 revisited — per-device
 * revocation). `token` never leaves `pairNewDevice`'s own return value —
 * `listDevices()` (polled by the UI) deliberately omits it, so a second
 * device's QR modal session can't read out a first device's live token. */
type Device = { id: string; token: string; label: string; pairedAt: number };
export type RemoteDevice = { id: string; label: string; pairedAt: number; connections: number };
export type RemoteDevicePairing = RemoteDevice & {
  token: string;
  port: number;
  addresses: string[];
  url: string | null;
  qrDataUrl: string | null;
};

// Pre-release audit S7 — how long a freshly-opened socket gets to send
// its `{type:"auth", token}` first message before being dropped.
const AUTH_TIMEOUT_MS = 5_000;

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
 * Auth is per-device rotating tokens (QR-paired, Tailscale/Syncthing-style),
 * checked on the WebSocket upgrade only — the static HTML/JS shell itself
 * is not secret (it's just code), but every state a browser can read plus
 * every write (typing into someone's terminal) is behind a token.
 *
 * DESIGN-BACKLOG.md item 2 revisited — was a single shared token for the
 * whole server; now each pairing (each QR scan) gets its own token and
 * its own device id, so `revokeDevice(id)` can drop exactly one phone
 * without booting every other paired device. `revokeAll()` stays as the
 * blunt "something might have leaked, nuke everything" escape hatch.
 *
 * Pre-release audit S7 — three things fixed together, same reasoning as
 * `secrets.ts`'s own posture on this exact tradeoff:
 * (1) the LAN port used to open at app boot, exposed to anyone on the
 *     network before a single phone was ever paired — now it only binds
 *     inside `pairNewDevice`, on first use;
 * (2) the WebSocket upgrade didn't check `Origin` at all — a malicious
 *     page open in a browser on the same LAN could open a WS to this
 *     server itself (the token isn't secret to that page if it can guess
 *     or brute-force it, and CSRF-style browser-mediated connection was
 *     wide open regardless). Checked against the request's own `Host`
 *     header rather than a fixed LAN-address allowlist — this still
 *     works transparently through the Phase B tunnel case (Tailscale
 *     Funnel/Cloudflare Tunnel), where the real Origin is the tunnel's own
 *     hostname, never a LAN IP the server could hardcode in advance;
 * (3) the token traveled in the WS upgrade URL — logged by any reverse
 *     proxy/tunnel sitting in front, kept in browser history. Moved to the
 *     first message sent after the socket opens instead (see
 *     `resources/mobile-client/app.js`).
 * `devices` now also survives a restart — persisted via `safeStorage`
 * (same encrypt-if-available, cleartext-fallback posture as
 * `secrets.ts`, and the same tmp+rename atomic write S9 gave that file),
 * since an in-memory-only pairing list meant every app restart silently
 * revoked every phone with zero indication why.
 */
function devicesPath(userDataDir: string): string {
  return join(userDataDir, "remote-devices.json");
}

type PersistedDevice = { value: string; encrypted: boolean };

function loadDevices(userDataDir: string): Map<string, Device> {
  const path = devicesPath(userDataDir);
  const devices = new Map<string, Device>();
  if (!existsSync(path)) return devices;
  try {
    const stored: PersistedDevice = JSON.parse(readFileSync(path, "utf-8"));
    const json = stored.encrypted ? safeStorage.decryptString(Buffer.from(stored.value, "base64")) : stored.value;
    const list: Device[] = JSON.parse(json);
    for (const d of list) devices.set(d.id, d);
  } catch {
    // Corrupt file, or encrypted under a different OS-keychain identity
    // (e.g. copied to another machine) — same defensive posture as
    // `secrets.ts`'s own `readAll`: treat as "no devices", never crash.
  }
  return devices;
}

function saveDevices(userDataDir: string, devices: Map<string, Device>) {
  const path = devicesPath(userDataDir);
  const tmpPath = `${path}.tmp`;
  const json = JSON.stringify([...devices.values()]);
  const stored: PersistedDevice = safeStorage.isEncryptionAvailable()
    ? { value: safeStorage.encryptString(json).toString("base64"), encrypted: true }
    : { value: json, encrypted: false };
  writeFileSync(tmpPath, JSON.stringify(stored), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

export function createRemoteServer(opts: {
  port: number;
  mobileClientDir: string;
  userDataDir: string;
  listTerminals: () => TerminalSummary[];
  onWrite: (id: string, data: string) => void;
  onResize: (id: string, cols: number, rows: number) => void;
}) {
  const devices = loadDevices(opts.userDataDir);
  const clients = new Set<WebSocket>();
  // Which device authenticated each open socket — needed so a per-device
  // revoke knows which sockets to drop, and so `listDevices()` can report
  // a live connection count per device (not just a global total).
  const clientDevice = new Map<WebSocket, string>();
  let httpServer: Server | null = null;
  let wss: WebSocketServer | null = null;

  function deviceByToken(candidate: string): Device | null {
    for (const device of devices.values()) {
      if (device.token === candidate) return device;
    }
    return null;
  }

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

  // Pre-release audit S7 — same-origin check against the request's OWN
  // `Host` header, not a fixed LAN-address allowlist: a real browser
  // always sends `Origin` for a WS handshake initiated from a page, and a
  // page served by THIS server has an Origin that always matches the Host
  // it was loaded from — true whether that's a bare LAN IP or a tunnel's
  // public hostname (Phase B), so this needs no advance knowledge of
  // either. Missing `Origin` (a non-browser client — `wscat`, a native
  // shell, this file's own test harness) is allowed through: the token
  // check right after is what actually gates access for those.
  function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
    if (!origin) return true;
    try {
      return new URL(origin).host === hostHeader;
    } catch {
      return false;
    }
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      ws.close(4003, "origin not allowed");
      return;
    }
    // Pre-release audit S7 — the token no longer travels in the upgrade
    // URL (logged by any proxy/tunnel in front, kept in browser history);
    // the client now sends it as the first WS message instead (see
    // `resources/mobile-client/app.js`'s own `connect()`). Everything
    // before that first, auth-carrying message is otherwise inert — no
    // `pty:write`/`list`/etc is honored, and a socket that never sends a
    // valid one within AUTH_TIMEOUT_MS is dropped rather than left open
    // forever consuming a connection slot.
    let deviceId: string | null = null;
    const authTimer = setTimeout(() => {
      if (!deviceId) ws.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!deviceId) {
        const device = msg.type === "auth" && typeof msg.token === "string" ? deviceByToken(msg.token) : null;
        if (!device) {
          clearTimeout(authTimer);
          ws.close(4001, "unauthorized");
          return;
        }
        clearTimeout(authTimer);
        deviceId = device.id;
        clients.add(ws);
        clientDevice.set(ws, device.id);
        ws.send(JSON.stringify({ type: "cards", cards: opts.listTerminals() }));
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
    ws.on("close", () => {
      clearTimeout(authTimer);
      clients.delete(ws);
      clientDevice.delete(ws);
    });
    ws.on("error", () => {
      clearTimeout(authTimer);
      clients.delete(ws);
      clientDevice.delete(ws);
    });
  });

  // Parity with mcp-server.ts's own bind guard (DESIGN-BACKLOG.md item 40)
  // — without this, a port collision (a leftover instance, a verify-harness
  // run) surfaced only via the global uncaughtException catch-all (item
  // 37): the process survived, but `remoteServer` was left as a live-looking
  // object wrapping a server that never actually bound, with no signal to
  // callers. Port stays fixed here (unlike mcp-server.ts) — pairing/QR flow
  // and any Tailscale Funnel/Cloudflare Tunnel forwarding a user has set up
  // depend on a stable, predictable port.
  //
  // Pre-release audit S7 — `listen()` itself is no longer called here: the
  // port used to open at app boot, reachable by anyone on the LAN before a
  // single phone was ever paired. `ensureListening()` below is called the
  // first time `pairNewDevice` runs instead, and is idempotent/memoized —
  // every later pairing after the first is a no-op here.
  httpServer.on("error", (err) => {
    console.error(`remote-server: failed to bind port ${opts.port}, remote pairing will be unavailable:`, err);
  });
  let listenPromise: Promise<void> | null = null;
  function ensureListening(): Promise<void> {
    if (!listenPromise) {
      listenPromise = new Promise((resolve, reject) => {
        const onListening = () => {
          httpServer!.off("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          httpServer!.off("listening", onListening);
          listenPromise = null; // a failed bind isn't cached — a later retry (e.g. the colliding process exited) should get another real attempt
          reject(err);
        };
        httpServer!.once("listening", onListening);
        httpServer!.once("error", onError);
        httpServer!.listen(opts.port, "0.0.0.0");
      });
    }
    return listenPromise;
  }

  function broadcast(payload: unknown) {
    // PERF (docs/PERF.md, 2026-09-15): sem nenhum cliente remoto (o caso
    // 99.9% — nenhum celular pareado), `JSON.stringify` de um chunk de PTY
    // de até 64 KB rodava à toa a cada flush de saída. Um card ruidoso
    // (build/teste) dispara flush a cada 16 ms, então isto era serialização
    // pura desperdiçada — CPU do processo main sob carga de saída. Saída
    // cedo, antes do stringify.
    if (clients.size === 0) return;
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

  function connectionsFor(deviceId: string): number {
    let n = 0;
    for (const id of clientDevice.values()) if (id === deviceId) n++;
    return n;
  }

  /** Pairs one new phone: fresh id + token, own QR/URL. The returned
   * token is the ONLY place it's ever exposed outside this module — the
   * modal shows it once (as the QR just scanned), `listDevices()` below
   * never echoes it back. Pre-release audit S7 — this is the ONE place
   * that ever binds the LAN port (`ensureListening()`), and the new
   * device is persisted to disk immediately, so it survives an app
   * restart instead of silently vanishing. */
  async function pairNewDevice(label?: string): Promise<RemoteDevicePairing> {
    await ensureListening();
    const id = randomBytes(4).toString("hex");
    const token = randomBytes(16).toString("hex");
    const pairedAt = Date.now();
    const device: Device = { id, token, label: label?.trim() || `Dispositivo ${devices.size + 1}`, pairedAt };
    devices.set(id, device);
    saveDevices(opts.userDataDir, devices);
    const addrs = lanAddresses();
    const primary = addrs[0];
    const url = primary ? `http://${primary}:${opts.port}/?token=${token}` : null;
    return {
      id,
      label: device.label,
      pairedAt,
      connections: 0,
      token,
      port: opts.port,
      addresses: addrs,
      url,
      qrDataUrl: url ? await QRCode.toDataURL(url, { margin: 1, width: 240 }) : null,
    };
  }

  function listDevices(): RemoteDevice[] {
    return [...devices.values()]
      .sort((a, b) => a.pairedAt - b.pairedAt)
      .map((d) => ({ id: d.id, label: d.label, pairedAt: d.pairedAt, connections: connectionsFor(d.id) }));
  }

  /** Drops exactly one paired phone — its token stops authenticating and
   * any socket it currently has open closes right away. Every other
   * paired device is untouched. */
  function revokeDevice(id: string) {
    devices.delete(id);
    saveDevices(opts.userDataDir, devices);
    for (const [ws, devId] of clientDevice) {
      if (devId !== id) continue;
      ws.close(4001, "revoked");
      clients.delete(ws);
      clientDevice.delete(ws);
    }
  }

  /** The blunt escape hatch — every paired device's token stops working
   * and every open socket closes, for when it's unclear which QR might
   * have leaked. */
  function revokeAll() {
    devices.clear();
    saveDevices(opts.userDataDir, devices);
    for (const ws of clients) ws.close(4001, "revoked");
    clients.clear();
    clientDevice.clear();
  }

  function close() {
    for (const ws of clients) ws.close();
    clients.clear();
    clientDevice.clear();
    wss?.close();
    httpServer?.close();
  }

  return {
    broadcastPtyData: (id: string, data: string) => broadcast({ type: "pty:data", id, data }),
    broadcastPtyExit: (id: string, exitCode: number) => broadcast({ type: "pty:exit", id, exitCode }),
    // `opts.listTerminals()` calls back into the store (main/index.ts) —
    // only worth paying for when someone's actually listening. Also fixes
    // a real shutdown-order crash: a PTY can exit (and fire its onExit,
    // which calls this) after `store.close()` has already run — `close()`
    // above always runs before `store.close()` in main/index.ts's cleanup,
    // so by then `clients` is already empty and this guard skips the call
    // that would otherwise throw "database connection is not open"
    // (confirmed live — see AGENTS.md).
    broadcastCards: () => {
      if (clients.size > 0) broadcast({ type: "cards", cards: opts.listTerminals() });
    },
    pairNewDevice,
    listDevices,
    revokeDevice,
    revokeAll,
    close,
  };
}

export type RemoteServer = ReturnType<typeof createRemoteServer>;

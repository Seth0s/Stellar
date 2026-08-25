import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

const OPEN_TIMEOUT_MS = 120_000;

export type CardSummary = { id: string; provider: string; cwd: string };

/**
 * A local Unix socket bridge letting a spawned provider CLI act on the
 * board via its own shell tool — none of claude/codex/cursor-agent expose
 * any channel for one session to reach another, so `acbridge` (the CLI
 * script this listens for) is the only realistic bridge: an agent can
 * always run a shell command, so giving it one that talks back to the app
 * is the one mechanism guaranteed to work across all three vendors.
 */
export function createMessageBus(
  sockPath: string,
  callbacks: {
    listCards: () => CardSummary[];
    writeToCard: (id: string, text: string) => void;
    onOpenRequest: (requestId: string, requesterId: string, url: string) => void;
  },
) {
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      // Stale socket from an unclean previous shutdown — best effort.
    }
  }

  const pendingOpens = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();

  function handleLine(socket: Socket, line: string) {
    let req: { cmd?: string; target?: string; text?: string; url?: string; requesterId?: string };
    try {
      req = JSON.parse(line);
    } catch {
      socket.end(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
      return;
    }

    if (req.cmd === "list") {
      socket.end(JSON.stringify({ ok: true, cards: callbacks.listCards() }) + "\n");
      return;
    }

    if (req.cmd === "send") {
      const cards = callbacks.listCards();
      if (!req.target || !cards.some((c) => c.id === req.target)) {
        socket.end(JSON.stringify({ ok: false, error: `no open terminal card with id "${req.target}"` }) + "\n");
        return;
      }
      callbacks.writeToCard(req.target, (req.text ?? "") + "\r");
      socket.end(JSON.stringify({ ok: true }) + "\n");
      return;
    }

    if (req.cmd === "open") {
      if (!req.url) {
        socket.end(JSON.stringify({ ok: false, error: "missing url" }) + "\n");
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pendingOpens.delete(requestId);
        socket.end(JSON.stringify({ ok: false, error: "timed out waiting for a decision" }) + "\n");
      }, OPEN_TIMEOUT_MS);
      pendingOpens.set(requestId, {
        resolve: (allowed) => {
          clearTimeout(timer);
          pendingOpens.delete(requestId);
          socket.end(JSON.stringify(allowed ? { ok: true } : { ok: false, error: "denied by user" }) + "\n");
        },
        timer,
      });
      callbacks.onOpenRequest(requestId, req.requesterId ?? "", req.url);
      return;
    }

    socket.end(JSON.stringify({ ok: false, error: `unknown cmd "${req.cmd}"` }) + "\n");
  }

  function resolveOpen(requestId: string, allowed: boolean) {
    pendingOpens.get(requestId)?.resolve(allowed);
  }

  // allowHalfOpen: true — acbridge writes its request then immediately
  // calls socket.end() (half-closing its write side) while it waits to read
  // the reply. Node's default (false) would make the server echo that FIN
  // and fully close its own side right away, killing an "open" request
  // (which deliberately holds the socket for as long as the human takes to
  // decide) before resolveOpen() ever gets to write the reply.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = "";
      handleLine(socket, line);
    });
  });
  server.listen(sockPath);

  function close() {
    for (const { timer } of pendingOpens.values()) clearTimeout(timer);
    pendingOpens.clear();
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      // Already gone — fine.
    }
  }

  return { resolveOpen, close };
}

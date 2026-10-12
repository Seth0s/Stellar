/**
 * ACCOUNT SESSIONS — which local board is which session of the account, and the
 * revision it last saw. One small JSON file in the app's data folder, keyed by
 * the local board id. It is what makes a second save an update (`If-Match`)
 * instead of a second copy, and what lets a conflict say "you started from
 * revision 3".
 *
 * Nothing secret and no path lives here: a session id, a profile id, numbers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SESSION_LINKS_FILENAME = "account-sessions.json";

export type SessionLink = {
  profileId: string;
  sessionId: string;
  /** The revision this machine last saved or opened. */
  revision: number;
  /** Epoch-ms of that save or open. */
  savedAt: number;
  /** Cards that stayed on this machine in the last save (media). */
  omitted: number;
};

type LinksFile = {
  version: 1;
  links: Record<string, SessionLink>;
  /** The id a board sent as `client_ref` in its first create, so a retry does not duplicate. */
  clientRefs: Record<string, string>;
};

function isLink(v: unknown): v is SessionLink {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.profileId === "string" &&
    typeof o.sessionId === "string" &&
    typeof o.revision === "number" &&
    typeof o.savedAt === "number" &&
    typeof o.omitted === "number"
  );
}

function readFile(path: string): LinksFile {
  const empty: LinksFile = { version: 1, links: {}, clientRefs: {} };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const links: Record<string, SessionLink> = {};
    for (const [id, link] of Object.entries((raw.links ?? {}) as Record<string, unknown>)) if (isLink(link)) links[id] = link;
    const clientRefs: Record<string, string> = {};
    for (const [id, ref] of Object.entries((raw.clientRefs ?? {}) as Record<string, unknown>)) if (typeof ref === "string") clientRefs[id] = ref;
    return { version: 1, links, clientRefs };
  } catch {
    return empty;
  }
}

export function createSessionLinks(userDataDir: string) {
  const path = join(userDataDir, SESSION_LINKS_FILENAME);
  function write(file: LinksFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, path);
  }
  return {
    get(boardId: string): SessionLink | null {
      return readFile(path).links[boardId] ?? null;
    },
    /** The board that holds a session of the account on this machine, if any. */
    boardOf(profileId: string, sessionId: string): string | null {
      const links = readFile(path).links;
      for (const [boardId, link] of Object.entries(links)) if (link.profileId === profileId && link.sessionId === sessionId) return boardId;
      return null;
    },
    set(boardId: string, link: SessionLink): void {
      const file = readFile(path);
      file.links[boardId] = link;
      write(file);
    },
    remove(boardId: string): void {
      const file = readFile(path);
      if (!(boardId in file.links) && !(boardId in file.clientRefs)) return;
      delete file.links[boardId];
      delete file.clientRefs[boardId];
      write(file);
    },
    clientRef(boardId: string, make: () => string): string {
      const file = readFile(path);
      const existing = file.clientRefs[boardId];
      if (existing) return existing;
      const ref = make();
      file.clientRefs[boardId] = ref;
      write(file);
      return ref;
    },
  };
}

export type SessionLinks = ReturnType<typeof createSessionLinks>;

/**
 * ACCOUNT SESSIONS — the IPC surface the renderer calls. Wiring only: arguments
 * are checked here, the flow lives in `cloud-sessions.ts`. The access token is
 * read in main (`ensureToken`) and never crosses to the renderer.
 */

import { ipcMain } from "electron";
import { createCloudSessions, type CloudSessions, type CloudSessionsDeps, type FolderChoice } from "./cloud-sessions";

export type CloudSessionsIpcDeps = Omit<CloudSessionsDeps, "api" | "links"> & {
  api: CloudSessionsDeps["api"];
  links: CloudSessionsDeps["links"];
};

const BAD_ARGS = { ok: false as const, failure: { state: "error" as const, code: "bad_request", message: "invalid arguments" } };

function text(v: unknown): string | null {
  return typeof v === "string" && v !== "" && v.length <= 512 ? v : null;
}

function folderOf(v: unknown): FolderChoice | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "none") return { kind: "none" };
  if (o.kind === "path") {
    const path = text(o.path);
    return path ? { kind: "path", path } : null;
  }
  return null;
}

export function registerCloudSessionsIpc(deps: CloudSessionsIpcDeps): CloudSessions {
  const sessions = createCloudSessions(deps);

  ipcMain.handle("account-sessions:list", async (_e, profileId: unknown, opts: unknown) => {
    const p = text(profileId);
    if (!p) return BAD_ARGS;
    const archived = typeof opts === "object" && opts !== null && (opts as { archived?: unknown }).archived === true;
    return sessions.list(p, { archived });
  });

  ipcMain.handle("account-sessions:preview", async (_e, boardId: unknown) => {
    const b = text(boardId);
    if (!b) return { ok: false as const };
    return sessions.preview(b);
  });

  ipcMain.handle("account-sessions:save", async (_e, boardId: unknown, profileId: unknown) => {
    const b = text(boardId);
    const p = text(profileId);
    if (!b || !p) return BAD_ARGS;
    return sessions.save(b, p);
  });

  ipcMain.handle("account-sessions:open", async (_e, profileId: unknown, sessionId: unknown, folder: unknown) => {
    const p = text(profileId);
    const s = text(sessionId);
    const f = folderOf(folder);
    if (!p || !s || f === null) return BAD_ARGS;
    return sessions.open(p, s, f);
  });

  ipcMain.handle("account-sessions:resolve", async (_e, boardId: unknown, profileId: unknown, choice: unknown, folder: unknown) => {
    const b = text(boardId);
    const p = text(profileId);
    const f = folderOf(folder);
    if (!b || !p || (choice !== "mine" && choice !== "account") || f === null) return BAD_ARGS;
    return sessions.resolveConflict(b, p, choice, f);
  });

  ipcMain.handle("account-sessions:archive", async (_e, profileId: unknown, sessionId: unknown) => {
    const p = text(profileId);
    const s = text(sessionId);
    if (!p || !s) return BAD_ARGS;
    return sessions.archive(p, s);
  });

  ipcMain.handle("account-sessions:link", (_e, boardId: unknown) => {
    const b = text(boardId);
    return b ? sessions.link(b) : null;
  });

  return sessions;
}

import { contextBridge, ipcRenderer } from "electron";

export type CardRow = {
  id: string;
  board_id: string;
  kind: string;
  provider: string;
  cwd: string;
  x: number;
  y: number;
  w: number;
  h: number;
  resume_id: string | null;
  model: string | null;
  system_prompt: string | null;
  group_id: string | null;
  label: string | null;
  updated_at: number;
};

type SpawnOpts = { resumeId?: string; continueLast?: boolean; model?: string; systemPrompt?: string };
type SpawnResult = { id: string } | { error: "binary_not_found" | "spawn_failed"; providerId: string };

const pty = {
  spawn: (
    id: string,
    providerId: string,
    cwd: string,
    cols: number,
    rows: number,
    opts?: SpawnOpts,
  ): Promise<SpawnResult> => ipcRenderer.invoke("pty:spawn", id, providerId, cwd, cols, rows, opts),
  write: (id: string, data: string): Promise<void> => ipcRenderer.invoke("pty:write", id, data),
  resize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("pty:resize", id, cols, rows),
  interrupt: (id: string): Promise<void> => ipcRenderer.invoke("pty:interrupt", id),
  kill: (id: string): Promise<void> => ipcRenderer.invoke("pty:kill", id),
  onData: (cb: (id: string, data: string) => void) => {
    const listener = (_e: unknown, id: string, data: string) => cb(id, data);
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onExit: (cb: (id: string, exitCode: number) => void) => {
    const listener = (_e: unknown, id: string, exitCode: number) => cb(id, exitCode);
    ipcRenderer.on("pty:exit", listener);
    return () => ipcRenderer.removeListener("pty:exit", listener);
  },
  onSessionFound: (cb: (id: string, sessionId: string) => void) => {
    const listener = (_e: unknown, id: string, sessionId: string) => cb(id, sessionId);
    ipcRenderer.on("pty:session-found", listener);
    return () => ipcRenderer.removeListener("pty:session-found", listener);
  },
  onUrlSeen: (cb: (id: string, url: string) => void) => {
    const listener = (_e: unknown, id: string, url: string) => cb(id, url);
    ipcRenderer.on("pty:url-seen", listener);
    return () => ipcRenderer.removeListener("pty:url-seen", listener);
  },
};

export type ConnectorRow = {
  id: string;
  board_id: string;
  from_card_id: string;
  to_card_id: string;
  updated_at: number;
};

export type BoardRow = {
  id: string;
  name: string;
  project: string;
  created_at: number;
  updated_at: number;
};

export type BoardCounts = { agents: number; active: number };

const store = {
  list: (boardId: string): Promise<CardRow[]> => ipcRenderer.invoke("store:list", boardId),
  upsert: (card: CardRow): Promise<void> => ipcRenderer.invoke("store:upsert", card),
  delete: (id: string): Promise<void> => ipcRenderer.invoke("store:delete", id),
  nextIdSeed: (): Promise<number> => ipcRenderer.invoke("store:next-id-seed"),
  connectors: {
    list: (boardId: string): Promise<ConnectorRow[]> => ipcRenderer.invoke("store:connectors:list", boardId),
    upsert: (row: ConnectorRow): Promise<void> => ipcRenderer.invoke("store:connectors:upsert", row),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("store:connectors:delete", id),
    deleteForCard: (cardId: string): Promise<void> =>
      ipcRenderer.invoke("store:connectors:delete-for-card", cardId),
  },
  boards: {
    list: (): Promise<BoardRow[]> => ipcRenderer.invoke("store:boards:list"),
    upsert: (board: BoardRow): Promise<void> => ipcRenderer.invoke("store:boards:upsert", board),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("store:boards:delete", id),
  },
  cardCounts: (): Promise<Record<string, BoardCounts>> => ipcRenderer.invoke("store:card-counts"),
};

export type DirEntry = { name: string; path: string; isDir: boolean };
export type ReadFileResult = { content: string } | { tooLarge: true };
export type ReadImageResult = { dataUrl: string } | { tooLarge: true } | { notImage: true };

const fs = {
  list: (root: string, path: string): Promise<DirEntry[]> => ipcRenderer.invoke("fs:list", root, path),
  read: (root: string, path: string): Promise<ReadFileResult> => ipcRenderer.invoke("fs:read", root, path),
  readImage: (root: string, path: string): Promise<ReadImageResult> =>
    ipcRenderer.invoke("fs:read-image", root, path),
  write: (root: string, path: string, content: string): Promise<void> =>
    ipcRenderer.invoke("fs:write", root, path, content),
};

export type GitEntry = { path: string; status: string; insertions: number; deletions: number };
export type GitStatus =
  | { repo: false }
  | { repo: true; branch: string; insertions: number; deletions: number; entries: GitEntry[] };

const git = {
  status: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke("git:status", cwd),
};

export type BrowserRect = { x: number; y: number; w: number; h: number };

const browser = {
  create: (id: string, url: string): Promise<void> => ipcRenderer.invoke("browser:create", id, url),
  navigate: (id: string, url: string): Promise<void> => ipcRenderer.invoke("browser:navigate", id, url),
  back: (id: string): Promise<void> => ipcRenderer.invoke("browser:back", id),
  forward: (id: string): Promise<void> => ipcRenderer.invoke("browser:forward", id),
  reload: (id: string): Promise<void> => ipcRenderer.invoke("browser:reload", id),
  setBounds: (id: string, rect: BrowserRect): Promise<void> => ipcRenderer.invoke("browser:set-bounds", id, rect),
  setVisible: (id: string, visible: boolean): Promise<void> => ipcRenderer.invoke("browser:set-visible", id, visible),
  raise: (id: string): Promise<void> => ipcRenderer.invoke("browser:raise", id),
  destroy: (id: string): Promise<void> => ipcRenderer.invoke("browser:destroy", id),
  resolveAsk: (requestId: string, allowed: boolean): Promise<void> =>
    ipcRenderer.invoke("browser:ask-resolve", requestId, allowed),
  onNavigate: (cb: (id: string, url: string) => void) => {
    const listener = (_e: unknown, id: string, url: string) => cb(id, url);
    ipcRenderer.on("browser:did-navigate", listener);
    return () => ipcRenderer.removeListener("browser:did-navigate", listener);
  },
  onTitle: (cb: (id: string, title: string) => void) => {
    const listener = (_e: unknown, id: string, title: string) => cb(id, title);
    ipcRenderer.on("browser:title", listener);
    return () => ipcRenderer.removeListener("browser:title", listener);
  },
  onLoading: (cb: (id: string, loading: boolean) => void) => {
    const listener = (_e: unknown, id: string, loading: boolean) => cb(id, loading);
    ipcRenderer.on("browser:loading", listener);
    return () => ipcRenderer.removeListener("browser:loading", listener);
  },
  onAskOpen: (cb: (requestId: string, requesterId: string, url: string) => void) => {
    const listener = (_e: unknown, requestId: string, requesterId: string, url: string) =>
      cb(requestId, requesterId, url);
    ipcRenderer.on("browser:ask-open", listener);
    return () => ipcRenderer.removeListener("browser:ask-open", listener);
  },
};

export type OneShotResult = { text: string } | { error: string };

const ai = {
  summarize: (providerId: string, cwd: string, prompt: string): Promise<OneShotResult> =>
    ipcRenderer.invoke("ai:summarize", providerId, cwd, prompt),
};

const winControls = {
  minimize: (): Promise<void> => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke("win:toggle-maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("win:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("win:is-maximized"),
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("win:maximized-change", listener);
    return () => ipcRenderer.removeListener("win:maximized-change", listener);
  },
  toggleFullscreen: (): Promise<void> => ipcRenderer.invoke("win:toggle-fullscreen"),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke("win:is-fullscreen"),
  onFullscreenChange: (cb: (fullscreen: boolean) => void) => {
    const listener = (_e: unknown, fullscreen: boolean) => cb(fullscreen);
    ipcRenderer.on("win:fullscreen-change", listener);
    return () => ipcRenderer.removeListener("win:fullscreen-change", listener);
  },
};

/** `acbridge snapshot` support — main asks "what's this on screen right
 * now" (only the renderer has the live pan/zoom transform), renderer
 * replies with screen pixels; main does the actual capturePage(). See
 * main/index.ts's handleSnapshotRequest for the other half. */
export type SnapshotTarget = { cardId: string } | { rect: { x: number; y: number; w: number; h: number } };
const snapshot = {
  onRectRequest: (cb: (requestId: string, target: SnapshotTarget) => void) => {
    const listener = (_e: unknown, requestId: string, target: SnapshotTarget) => cb(requestId, target);
    ipcRenderer.on("snapshot:rect-request", listener);
    return () => ipcRenderer.removeListener("snapshot:rect-request", listener);
  },
  replyRect: (requestId: string, screenRect: { x: number; y: number; width: number; height: number } | null) =>
    ipcRenderer.send("snapshot:rect-reply", requestId, screenRect),
};

export type RemoteInputEnsureResult = { granted: true } | { granted: false; error: string };

/** Human-driven control of an external OS window (DESIGN-BACKLOG.md item
 * 3, phase 1 — relative motion, see main/remote-input.ts). `ensure()` is
 * the one call that can surface a real OS consent dialog; the rest are
 * fire-and-forget input events sent while a RemoteWindowCard has control
 * active. */
const remoteInput = {
  ensure: (): Promise<RemoteInputEnsureResult> => ipcRenderer.invoke("remote-input:ensure"),
  move: (dx: number, dy: number): Promise<void> => ipcRenderer.invoke("remote-input:move", dx, dy),
  button: (button: number, pressed: boolean): Promise<void> =>
    ipcRenderer.invoke("remote-input:button", button, pressed),
  scroll: (dx: number, dy: number): Promise<void> => ipcRenderer.invoke("remote-input:scroll", dx, dy),
  keysym: (keysym: number, pressed: boolean): Promise<void> =>
    ipcRenderer.invoke("remote-input:keysym", keysym, pressed),
};

contextBridge.exposeInMainWorld("pty", pty);
contextBridge.exposeInMainWorld("store", store);
contextBridge.exposeInMainWorld("fs", fs);
contextBridge.exposeInMainWorld("git", git);
contextBridge.exposeInMainWorld("browser", browser);
contextBridge.exposeInMainWorld("ai", ai);
contextBridge.exposeInMainWorld("winControls", winControls);
contextBridge.exposeInMainWorld("snapshot", snapshot);
contextBridge.exposeInMainWorld("remoteInput", remoteInput);

export type PtyApi = typeof pty;
export type StoreApi = typeof store;
export type FsApi = typeof fs;
export type GitApi = typeof git;
export type BrowserApi = typeof browser;
export type AiApi = typeof ai;
export type WinControlsApi = typeof winControls;
export type SnapshotApi = typeof snapshot;
export type RemoteInputApi = typeof remoteInput;

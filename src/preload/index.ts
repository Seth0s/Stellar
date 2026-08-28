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
  messages_json: string | null;
  /** DESIGN-BACKLOG.md item 30 — see main/store.ts's own doc comment. */
  archived_at: number | null;
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

export type SaveClipboardImageResult = { ok: true; path: string } | { ok: false; error: string };

/** "não consigo mandar foto pelo terminal" (2026-08-27) — ver
 * main/clipboard-image.ts pro raciocínio completo. Separado de `pty`
 * (não fala com um PTY específico, só lê o clipboard do SO), mesma
 * distinção que `secrets` já mantém como um bridge próprio pequeno em
 * vez de crescer um existente. */
const clipboardImage = {
  save: (): Promise<SaveClipboardImageResult> => ipcRenderer.invoke("clipboard:save-pasted-image"),
  /** Test-only (scripts/verify) — no-op in a packaged build, see
   * main/index.ts's guard. */
  testWriteImage: (): Promise<void> => ipcRenderer.invoke("clipboard:test-write-image"),
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
  cwd: string;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
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
    /** DESIGN-BACKLOG.md item 14 — bumps `last_accessed_at` on open. */
    touch: (id: string, at: number): Promise<void> => ipcRenderer.invoke("store:boards:touch", id, at),
  },
  cardCounts: (): Promise<Record<string, BoardCounts>> => ipcRenderer.invoke("store:card-counts"),
  /** DESIGN-BACKLOG.md item 30 — sessions sidebar (every chat card, live
   * or archived, across every board) + archive/unarchive. Closing a
   * ChatCard archives instead of deleting (App.tsx's closeCard); every
   * other card kind still hard-deletes exactly as before. */
  listChatSessions: (): Promise<CardRow[]> => ipcRenderer.invoke("store:list-chat-sessions"),
  archiveCard: (id: string): Promise<void> => ipcRenderer.invoke("store:archive-card", id),
  unarchiveCard: (id: string): Promise<void> => ipcRenderer.invoke("store:unarchive-card", id),
};

export type DirEntry = { name: string; path: string; isDir: boolean };
export type ReadFileResult = { content: string } | { tooLarge: true };
export type ReadImageResult = { dataUrl: string } | { tooLarge: true } | { notImage: true };

const fs = {
  /** Native OS folder dialog — ProjectPicker.tsx's "mudar pasta raiz".
   * `null` when the user cancels. */
  pickDirectory: (defaultPath: string): Promise<string | null> =>
    ipcRenderer.invoke("fs:pick-directory", defaultPath),
  list: (root: string, path: string): Promise<DirEntry[]> => ipcRenderer.invoke("fs:list", root, path),
  read: (root: string, path: string): Promise<ReadFileResult> => ipcRenderer.invoke("fs:read", root, path),
  readImage: (root: string, path: string): Promise<ReadImageResult> =>
    ipcRenderer.invoke("fs:read-image", root, path),
  write: (root: string, path: string, content: string): Promise<void> =>
    ipcRenderer.invoke("fs:write", root, path, content),
  /** DESIGN-BACKLOG.md item 13 — FilesCard quick actions. */
  rename: (root: string, path: string, newName: string): Promise<void> =>
    ipcRenderer.invoke("fs:rename", root, path, newName),
  delete: (root: string, path: string): Promise<void> => ipcRenderer.invoke("fs:delete", root, path),
  create: (root: string, parentPath: string, name: string, kind: "file" | "folder"): Promise<void> =>
    ipcRenderer.invoke("fs:create", root, parentPath, name, kind),
};

export type GitEntry = { path: string; status: string; insertions: number; deletions: number };
export type GitStatus =
  | { repo: false }
  | { repo: true; branch: string; insertions: number; deletions: number; entries: GitEntry[] };

const git = {
  status: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke("git:status", cwd),
};

export type BrowserMouseEvent = {
  type: "mouseDown" | "mouseUp" | "mouseMove";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
};
export type BrowserWheelEvent = { x: number; y: number; deltaX: number; deltaY: number };
export type BrowserKeyEvent = {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers?: Array<"shift" | "control" | "alt" | "meta">;
};

const browser = {
  create: (id: string, url: string): Promise<void> => ipcRenderer.invoke("browser:create", id, url),
  navigate: (id: string, url: string): Promise<void> => ipcRenderer.invoke("browser:navigate", id, url),
  back: (id: string): Promise<void> => ipcRenderer.invoke("browser:back", id),
  forward: (id: string): Promise<void> => ipcRenderer.invoke("browser:forward", id),
  reload: (id: string): Promise<void> => ipcRenderer.invoke("browser:reload", id),
  resize: (id: string, w: number, h: number): Promise<void> => ipcRenderer.invoke("browser:resize", id, w, h),
  setVisible: (id: string, visible: boolean): Promise<void> => ipcRenderer.invoke("browser:set-visible", id, visible),
  destroy: (id: string): Promise<void> => ipcRenderer.invoke("browser:destroy", id),
  // Fire-and-forget (`send`, not `invoke`) — these fire on every pointer
  // move/frame-adjacent tick; waiting on a reply promise per event would
  // only add latency nothing here needs.
  sendMouse: (id: string, evt: BrowserMouseEvent) => ipcRenderer.send("browser:input-mouse", id, evt),
  sendWheel: (id: string, evt: BrowserWheelEvent) => ipcRenderer.send("browser:input-wheel", id, evt),
  sendKey: (id: string, evt: BrowserKeyEvent) => ipcRenderer.send("browser:input-key", id, evt),
  resolveAsk: (requestId: string, allowed: boolean): Promise<void> =>
    ipcRenderer.invoke("browser:ask-resolve", requestId, allowed),
  /** DESIGN-BACKLOG.md item 21, ponto 9, achado 5 — page content for an
   * agent, not just pixels (see `snapshot`). Truncated server-side
   * (browser-registry.ts) — `truncated` tells the caller whether that
   * happened. */
  getPageText: (id: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }> =>
    ipcRenderer.invoke("browser:get-page-text", id),
  /** One decoded JPEG frame from the card's offscreen `BrowserWindow` — see
   * browser-registry.ts. `buffer` arrives as a Uint8Array (structured-clone
   * of the main-process Buffer). */
  onFrame: (cb: (id: string, buffer: Uint8Array, width: number, height: number) => void) => {
    const listener = (_e: unknown, id: string, buffer: Uint8Array, width: number, height: number) =>
      cb(id, buffer, width, height);
    ipcRenderer.on("browser:frame", listener);
    return () => ipcRenderer.removeListener("browser:frame", listener);
  },
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
  onAskOpen: (cb: (requestId: string, requesterId: string, url: string, reason?: string) => void) => {
    const listener = (_e: unknown, requestId: string, requesterId: string, url: string, reason?: string) =>
      cb(requestId, requesterId, url, reason);
    ipcRenderer.on("browser:ask-open", listener);
    return () => ipcRenderer.removeListener("browser:ask-open", listener);
  },
  /** Item 26, teclado — texto composto de IME de uma vez (não caractere a
   * caractere via `sendKey`'s "char"). */
  insertText: (id: string, text: string): Promise<void> => ipcRenderer.invoke("browser:insert-text", id, text),
  /** Item 26, teclado — clipboard real do SO, um keyDown sintético de
   * Ctrl+V/C/X não basta (ver browser-registry.ts). */
  paste: (id: string): Promise<void> => ipcRenderer.invoke("browser:paste", id),
  copy: (id: string): Promise<void> => ipcRenderer.invoke("browser:copy", id),
  cut: (id: string): Promise<void> => ipcRenderer.invoke("browser:cut", id),
  /** Test-only, dev builds only — see main/index.ts. */
  testMakeEditable: (id: string): Promise<void> => ipcRenderer.invoke("browser:test-make-editable", id),
};

export type SpawnCardKind = "files" | "changes" | "sticky" | "browser" | "remote-window";
export type SpawnAgentAskParams = { provider: string; cwd?: string; resumeId?: string; depth: number; reason?: string };
export type SpawnCardAskParams = { kind: SpawnCardKind; cwd?: string; url?: string; reason?: string };
export type SpawnAgentResolveResult = { ok: true; cardId: string } | { ok: false; error: string };
export type SpawnCardResolveResult = { ok: true; cardId: string } | { ok: false; error: string };

/** DESIGN-BACKLOG.md item 21, ponto 9, achados 1 e 2 — an agent asking to
 * spawn another agent card, or a non-terminal tool card. Same
 * ask/consent/resolve shape as `browser.onAskOpen`/`resolveAsk` above,
 * generalized (AgentAskModal.tsx renders whichever is pending). Kept as
 * its own top-level bridge object rather than folded into `browser` —
 * neither capability is browser-specific. */
const spawn = {
  onAskAgent: (cb: (requestId: string, requesterId: string, params: SpawnAgentAskParams) => void) => {
    const listener = (_e: unknown, requestId: string, requesterId: string, params: SpawnAgentAskParams) =>
      cb(requestId, requesterId, params);
    ipcRenderer.on("spawn:ask-agent", listener);
    return () => ipcRenderer.removeListener("spawn:ask-agent", listener);
  },
  onAskCard: (cb: (requestId: string, requesterId: string, params: SpawnCardAskParams) => void) => {
    const listener = (_e: unknown, requestId: string, requesterId: string, params: SpawnCardAskParams) =>
      cb(requestId, requesterId, params);
    ipcRenderer.on("spawn:ask-card", listener);
    return () => ipcRenderer.removeListener("spawn:ask-card", listener);
  },
  resolveAgent: (requestId: string, result: SpawnAgentResolveResult): Promise<void> =>
    ipcRenderer.invoke("spawn:agent-resolve", requestId, result),
  resolveCard: (requestId: string, result: SpawnCardResolveResult): Promise<void> =>
    ipcRenderer.invoke("spawn:card-resolve", requestId, result),
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

/** One paired phone as listed by `remote:devices` — deliberately no
 * token here (main/remote-server.ts never echoes a device's token back
 * outside its own `pairNewDevice` response). */
export type RemoteDevice = { id: string; label: string; pairedAt: number; connections: number };

/** What `remote:pair-new-device` returns — a `RemoteDevice` plus the
 * one-time QR/URL/token for that specific new pairing. */
export type RemoteDevicePairing = RemoteDevice & {
  token: string;
  port: number;
  addresses: string[];
  url: string | null;
  qrDataUrl: string | null;
};

/** LAN-only mobile control (DESIGN-BACKLOG.md item 2) — per-device pairing
 * (item 2 revisited): each phone gets its own token/QR and can be revoked
 * on its own without booting every other paired device. See
 * main/remote-server.ts. */
const remote = {
  devices: (): Promise<RemoteDevice[]> => ipcRenderer.invoke("remote:devices"),
  pairNewDevice: (label?: string): Promise<RemoteDevicePairing> =>
    ipcRenderer.invoke("remote:pair-new-device", label),
  revokeDevice: (id: string): Promise<void> => ipcRenderer.invoke("remote:revoke-device", id),
  revokeAll: (): Promise<void> => ipcRenderer.invoke("remote:revoke-all"),
};

/** In-app updater (DESIGN-BACKLOG.md item 13 — see main/updater.ts's own
 * doc comment for the full product-behavior contract). `check()` is a
 * no-op in dev (`{checked: false}`) — never throws, safe to call
 * unconditionally at boot. `onAvailable`/`onDownloaded` only ever fire in
 * a packaged build with a real update actually found. */
const updater = {
  check: (): Promise<{ checked: boolean }> => ipcRenderer.invoke("updater:check"),
  install: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("updater:install"),
  onAvailable: (cb: (version: string, releaseNotes: string | null) => void) => {
    const listener = (_e: unknown, version: string, releaseNotes: string | null) => cb(version, releaseNotes);
    ipcRenderer.on("updater:available", listener);
    return () => ipcRenderer.removeListener("updater:available", listener);
  },
  onDownloaded: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("updater:downloaded", listener);
    return () => ipcRenderer.removeListener("updater:downloaded", listener);
  },
  /** Test-only (item 17's E2E coverage) — no-op in a packaged build, see
   * main/updater.ts's guard. Lets `scripts/verify/smoke-updater.mjs`
   * exercise the banner/changelog/dot UI without a real publish feed. */
  testEmitAvailable: (version: string, releaseNotes: string | null): Promise<void> =>
    ipcRenderer.invoke("updater:test-emit-available", version, releaseNotes),
};

// Kept in sync with main/secrets.ts's own SecretProvider by hand (preload
// can't import main-process modules) — item 28 added "gemini"/"generic".
export type SecretProvider = "anthropic" | "openai" | "gemini" | "generic";
export type SecretsResult = { ok: true } | { ok: false; error: string };

/** DESIGN-BACKLOG.md item 12, Fase B — the app's first credential of any
 * kind. See main/secrets.ts for the `safeStorage` design. */
const secrets = {
  hasKey: (provider: SecretProvider): Promise<boolean> => ipcRenderer.invoke("secrets:has", provider),
  /** `baseURL` only meaningful for `provider === "generic"` (item 28) —
   * ignored/unused by every other provider. Item 29 — typed result
   * instead of throwing across IPC, so a real write failure (disk
   * full, keychain rejection) surfaces instead of an unhandled
   * rejection. */
  setKey: (provider: SecretProvider, value: string, baseURL?: string): Promise<SecretsResult> =>
    ipcRenderer.invoke("secrets:set", provider, value, baseURL),
  clearKey: (provider: SecretProvider): Promise<SecretsResult> => ipcRenderer.invoke("secrets:clear", provider),
  isEncryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke("secrets:encryption-available"),
  getBaseURL: (provider: SecretProvider): Promise<string | null> => ipcRenderer.invoke("secrets:get-base-url", provider),
};

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatSendParams = { provider: SecretProvider; model: string; systemPrompt: string | null; messages: ChatMessage[]; cwd: string };
export type ChatSendResult = { ok: true } | { ok: false; error: string };

/** DESIGN-BACKLOG.md item 12, Fase C — the diff a `write_file` tool call
 * needs approved before anything touches disk (main/chat-tools.ts's real
 * `structuredPatch` output — this is NOT re-derived in the renderer,
 * `hunks` is the exact same data the human approves/denies). */
export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
export type WriteConsentRequest = { path: string; isNewFile: boolean; diffText: string; hunks: DiffHunk[] };
/** DESIGN-BACKLOG.md item 12, Fase D — the `bash` tool's consent request,
 * same ask/resolve shape as `WriteConsentRequest` above, just a command
 * line instead of a diff (see main/sandbox.ts). */
export type BashConsentRequest = { command: string };

/** DESIGN-BACKLOG.md item 12, Fase B/C — mirrors `pty`'s
 * spawn/write/onData/onExit shape on purpose (see main/anthropic-client.ts/
 * openai-client.ts): `send` kicks off a streamed request and resolves once
 * it either starts or fails fast (e.g. no API key configured); the actual
 * tokens arrive as `chat:token` events, terminated by exactly one of
 * `chat:done`/`chat:error`. Fase C adds tool activity (`onToolStart`/
 * `onToolResult`, transient — not part of the persisted turn, see
 * ChatCard.tsx) and the write-file consent round trip (`onAskWrite`/
 * `resolveWrite`, same ask/resolve shape `browser.onAskOpen`/`resolveAsk`
 * already established, just chat-specific — this loop doesn't go through
 * message-bus.ts at all). */
const chat = {
  send: (cardId: string, params: ChatSendParams): Promise<ChatSendResult> =>
    ipcRenderer.invoke("chat:send", cardId, params),
  cancel: (cardId: string, provider: SecretProvider): Promise<void> => ipcRenderer.invoke("chat:cancel", cardId, provider),
  onToken: (cb: (cardId: string, delta: string) => void) => {
    const listener = (_e: unknown, cardId: string, delta: string) => cb(cardId, delta);
    ipcRenderer.on("chat:token", listener);
    return () => ipcRenderer.removeListener("chat:token", listener);
  },
  onDone: (cb: (cardId: string, fullText: string) => void) => {
    const listener = (_e: unknown, cardId: string, fullText: string) => cb(cardId, fullText);
    ipcRenderer.on("chat:done", listener);
    return () => ipcRenderer.removeListener("chat:done", listener);
  },
  onError: (cb: (cardId: string, message: string) => void) => {
    const listener = (_e: unknown, cardId: string, message: string) => cb(cardId, message);
    ipcRenderer.on("chat:error", listener);
    return () => ipcRenderer.removeListener("chat:error", listener);
  },
  onToolStart: (cb: (cardId: string, name: string, input: unknown) => void) => {
    const listener = (_e: unknown, cardId: string, name: string, input: unknown) => cb(cardId, name, input);
    ipcRenderer.on("chat:tool-start", listener);
    return () => ipcRenderer.removeListener("chat:tool-start", listener);
  },
  onToolResult: (cb: (cardId: string, name: string, ok: boolean, summary: string) => void) => {
    const listener = (_e: unknown, cardId: string, name: string, ok: boolean, summary: string) => cb(cardId, name, ok, summary);
    ipcRenderer.on("chat:tool-result", listener);
    return () => ipcRenderer.removeListener("chat:tool-result", listener);
  },
  onAskWrite: (cb: (requestId: string, cardId: string, req: WriteConsentRequest) => void) => {
    const listener = (_e: unknown, requestId: string, cardId: string, req: WriteConsentRequest) => cb(requestId, cardId, req);
    ipcRenderer.on("chat:ask-write", listener);
    return () => ipcRenderer.removeListener("chat:ask-write", listener);
  },
  resolveWrite: (requestId: string, allowed: boolean): Promise<void> =>
    ipcRenderer.invoke("chat:write-resolve", requestId, allowed),
  /** DESIGN-BACKLOG.md item 12, Fase D — same ask/resolve shape as
   * onAskWrite/resolveWrite above, for the `bash` tool. */
  onAskBash: (cb: (requestId: string, cardId: string, req: BashConsentRequest) => void) => {
    const listener = (_e: unknown, requestId: string, cardId: string, req: BashConsentRequest) => cb(requestId, cardId, req);
    ipcRenderer.on("chat:ask-bash", listener);
    return () => ipcRenderer.removeListener("chat:ask-bash", listener);
  },
  resolveBash: (requestId: string, allowed: boolean): Promise<void> =>
    ipcRenderer.invoke("chat:bash-resolve", requestId, allowed),
  /** Test-only (item 12 Fase C's verify coverage) — no-op in a packaged
   * build, see main/index.ts's guard. Drives the real read_file/
   * write_file/consent/diff pipeline without needing a real paid API
   * call to get a model to request a tool. */
  testSimulateTool: (cardId: string, name: string, input: unknown, root: string): Promise<{ ok: boolean; text: string }> =>
    ipcRenderer.invoke("chat:test-simulate-tool", cardId, name, input, root),
};

contextBridge.exposeInMainWorld("pty", pty);
contextBridge.exposeInMainWorld("clipboardImage", clipboardImage);
contextBridge.exposeInMainWorld("store", store);
contextBridge.exposeInMainWorld("fs", fs);
contextBridge.exposeInMainWorld("git", git);
contextBridge.exposeInMainWorld("browser", browser);
contextBridge.exposeInMainWorld("spawn", spawn);
contextBridge.exposeInMainWorld("ai", ai);
contextBridge.exposeInMainWorld("winControls", winControls);
contextBridge.exposeInMainWorld("snapshot", snapshot);
contextBridge.exposeInMainWorld("remoteInput", remoteInput);
contextBridge.exposeInMainWorld("remote", remote);
contextBridge.exposeInMainWorld("updater", updater);
contextBridge.exposeInMainWorld("secrets", secrets);
contextBridge.exposeInMainWorld("chat", chat);

/** Test-only, dev builds only — DESIGN-BACKLOG.md item 37's crash-safety
 * net (main/index.ts's `process.on("uncaughtException", ...)`). */
const debugBridge = {
  testTriggerUncaughtException: (): Promise<void> => ipcRenderer.invoke("debug:test-trigger-uncaught-exception"),
};
contextBridge.exposeInMainWorld("debugBridge", debugBridge);

export type PtyApi = typeof pty;
export type ClipboardImageApi = typeof clipboardImage;
export type StoreApi = typeof store;
export type FsApi = typeof fs;
export type GitApi = typeof git;
export type BrowserApi = typeof browser;
export type SpawnApi = typeof spawn;
export type AiApi = typeof ai;
export type WinControlsApi = typeof winControls;
export type SnapshotApi = typeof snapshot;
export type RemoteInputApi = typeof remoteInput;
export type RemoteApi = typeof remote;
export type UpdaterApi = typeof updater;
export type SecretsApi = typeof secrets;
export type ChatApi = typeof chat;

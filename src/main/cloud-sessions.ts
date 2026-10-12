/**
 * ACCOUNT SESSIONS — save a board to the account, open one from it, and settle a
 * conflict. Manual only: nothing here runs on its own.
 *
 * The service owns the order of the steps and nothing else. What goes into a
 * snapshot, what a snapshot becomes and what a failure means live in
 * `cloud-sessions-decision.ts`; the HTTP calls in `cloud-sessions-api.ts`; the
 * database and the disk come in through `deps` so the whole flow runs against
 * fakes in the tests and against the real store in the app.
 */

import {
  buildProjectRef,
  buildSnapshot,
  decideSessionFailure,
  matchProjectRef,
  planRestore,
  summarySnapshot,
  type ProjectRef,
  type RestorePlan,
  type SessionFailure,
  type SessionSnapshot,
  type SessionSummary,
} from "./cloud-sessions-decision";
import type { CloudSessionsApi, RemoteSession, SessionsApiFailure } from "./cloud-sessions-api";
import type { SessionLink, SessionLinks } from "./cloud-sessions-links";
import type { BoardRow, CardRow, ConnectorRow, TaskCardRow, TaskRow } from "./store";

export type CloudSessionsStore = {
  getBoard(id: string): BoardRow | undefined;
  listBoards(): BoardRow[];
  listCards(boardId: string): CardRow[];
  listConnectors(boardId: string): ConnectorRow[];
  listTasksByBoard(boardId: string): TaskRow[];
  listTaskCardsForBoard(boardId: string): TaskCardRow[];
  upsertBoard(board: BoardRow): unknown;
  upsertCard(card: CardRow): unknown;
  upsertConnector(row: ConnectorRow): unknown;
  upsertTask(task: TaskRow): unknown;
  linkTaskCard(taskId: string, cardId: string, role: string): unknown;
  deleteBoard(id: string): unknown;
};

export type CloudSessionsDeps = {
  api: CloudSessionsApi;
  links: SessionLinks;
  store: CloudSessionsStore;
  ensureToken: () => Promise<string | null>;
  installId: () => string;
  now: () => number;
  newId: () => string;
  /** Where cards open when the session has no project folder here. */
  fallbackCwd: () => string;
  /** The `origin` URL of the git checkout at `root`, or null. */
  gitRemote: (root: string) => Promise<string | null>;
  /** Whether a folder exists on this machine. */
  folderExists: (path: string) => Promise<boolean>;
  /** Whether the CLI conversation a terminal card points at exists here. */
  resumeExists: (card: { provider: string; cwd: string; resumeId: string }) => boolean;
};

export type SessionView = {
  id: string;
  name: string;
  project: string;
  projectRef: ProjectRef | null;
  revision: number;
  cardCount: number;
  taskCount: number;
  updatedAt: string;
  updatedByDevice: string | null;
  /** A board on this machine that holds this session, when there is one. */
  openHereBoardId: string | null;
};

export type ListResult = { ok: true; sessions: SessionView[]; total: number } | { ok: false; failure: SessionFailure };

export type ConflictInfo = {
  /** What the account has now. */
  currentRevision: number;
  currentUpdatedAt: string | null;
  currentDevice: string | null;
  currentSummary: SessionSummary | null;
  /** What this machine would save, and the revision it started from. */
  mine: SessionSummary;
  baseRevision: number;
  /** When this machine last saved or opened the session. */
  baseAt: number;
};

export type SaveResult =
  | { ok: true; revision: number; created: boolean; summary: SessionSummary; omitted: number; overLimit: number }
  | { ok: false; conflict: ConflictInfo }
  | { ok: false; failure: SessionFailure };

export type FolderChoice = { kind: "path"; path: string } | { kind: "none" };

export type FolderCandidate = { path: string; match: "remote" | "name" };

export type OpenResult =
  | { ok: true; boardId: string; revision: number; cleanTerminals: number; cardCount: number; folder: string | null }
  | { ok: false; needsFolder: { projectRef: ProjectRef | null; candidates: FolderCandidate[] } }
  | { ok: false; failure: SessionFailure };

export type ResolveResult =
  | { ok: true; choice: "mine"; revision: number; summary: SessionSummary }
  | { ok: true; choice: "account"; boardId: string; revision: number; cleanTerminals: number }
  | { ok: false; conflict: ConflictInfo }
  | { ok: false; failure: SessionFailure };

const LOGIN: SessionFailure = { state: "login" };

function fail(f: SessionsApiFailure): { ok: false; failure: SessionFailure } {
  return { ok: false, failure: decideSessionFailure(f.error, f.retryAfterSec) };
}

export function createCloudSessions(deps: CloudSessionsDeps) {
  async function snapshotOf(board: BoardRow) {
    const cards = deps.store.listCards(board.id);
    const built = buildSnapshot({
      board,
      cards,
      connectors: deps.store.listConnectors(board.id),
      tasks: deps.store.listTasksByBoard(board.id),
      taskCards: deps.store.listTaskCardsForBoard(board.id),
      root: board.cwd,
    });
    const remote = board.cwd === "" ? null : await deps.gitRemote(board.cwd).catch(() => null);
    return { built, projectRef: buildProjectRef({ remoteUrl: remote, root: board.cwd }) };
  }

  function conflictInfo(
    c: { currentRevision: number; currentUpdatedAt: string | null; currentDevice: string | null; currentSummary: SessionSummary | null },
    mine: SessionSummary,
    link: SessionLink,
  ): ConflictInfo {
    return { ...c, mine, baseRevision: link.revision, baseAt: link.savedAt };
  }

  /** A save with the revision the account was last seen at; shared by Save and "keep mine". */
  async function put(token: string, board: BoardRow, profileId: string, link: SessionLink, revision: number, snapshot: SessionSnapshot, omitted: number, overLimit: number): Promise<SaveResult> {
    const mine = summarySnapshot(snapshot);
    const res = await deps.api.put(token, profileId, link.sessionId, { revision, snapshot, installId: deps.installId() });
    if (res.ok) {
      deps.links.set(board.id, { ...link, revision: res.value.revision, savedAt: deps.now(), omitted });
      return { ok: true, revision: res.value.revision, created: false, summary: mine, omitted, overLimit };
    }
    if ("kind" in res && res.kind === "conflict") return { ok: false, conflict: conflictInfo(res, mine, link) };
    return fail(res as SessionsApiFailure);
  }

  return {
    /** The sessions of a profile, each marked with the local board that holds it. */
    async list(profileId: string, opts: { archived?: boolean } = {}): Promise<ListResult> {
      const token = await deps.ensureToken();
      if (!token) return { ok: false, failure: LOGIN };
      const res = await deps.api.list(token, profileId, { installId: deps.installId(), archived: opts.archived, limit: 100 });
      if (!res.ok) return fail(res);
      const sessions = res.value.sessions.map((s: RemoteSession): SessionView => {
        const boardId = deps.links.boardOf(profileId, s.id);
        return {
          id: s.id,
          name: s.name,
          project: s.project,
          projectRef: s.projectRef,
          revision: s.revision,
          cardCount: s.cardCount,
          taskCount: s.taskCount,
          updatedAt: s.updatedAt,
          updatedByDevice: s.updatedByDevice,
          openHereBoardId: boardId && deps.store.getBoard(boardId) ? boardId : null,
        };
      });
      return { ok: true, sessions, total: res.value.total };
    },

    /** What a save would send, without sending: the numbers the confirmation shows. */
    async preview(boardId: string): Promise<{ ok: true; summary: SessionSummary; connectors: number; omitted: number; overLimit: number; projectRef: ProjectRef | null; link: SessionLink | null } | { ok: false }> {
      const board = deps.store.getBoard(boardId);
      if (!board) return { ok: false };
      const { built, projectRef } = await snapshotOf(board);
      return { ok: true, summary: built.summary, connectors: built.snapshot.connectors.length, omitted: built.omitted, overLimit: built.overLimit, projectRef, link: deps.links.get(boardId) };
    },

    /** Creates the session the first time, updates it after. */
    async save(boardId: string, profileId: string): Promise<SaveResult> {
      const token = await deps.ensureToken();
      if (!token) return { ok: false, failure: LOGIN };
      const board = deps.store.getBoard(boardId);
      if (!board) return { ok: false, failure: { state: "error", code: "no_board", message: "the session does not exist on this machine" } };
      if (board.account_profile_id && board.account_profile_id !== profileId) {
        return { ok: false, failure: { state: "error", code: "other_profile", message: "the session belongs to another profile" } };
      }
      const { built, projectRef } = await snapshotOf(board);
      const { snapshot, omitted, overLimit } = built;
      const stored = deps.links.get(boardId);
      const link = stored && stored.profileId === profileId ? stored : null;
      if (link) return put(token, board, profileId, link, link.revision, snapshot, omitted, overLimit);

      const clientRef = deps.links.clientRef(boardId, deps.newId);
      const created = await deps.api.create(token, profileId, {
        clientRef,
        name: snapshot.board.name,
        project: snapshot.board.project,
        projectRef,
        snapshot,
        installId: deps.installId(),
      });
      if (created.ok) {
        deps.links.set(boardId, { profileId, sessionId: created.value.id, revision: created.value.revision, savedAt: deps.now(), omitted });
        return { ok: true, revision: created.value.revision, created: true, summary: built.summary, omitted, overLimit };
      }
      if (created.kind === "exists") {
        // A retry of this same create: carry on as an update of what it made.
        const adopted: SessionLink = { profileId, sessionId: created.id, revision: created.revision, savedAt: deps.now(), omitted };
        deps.links.set(boardId, adopted);
        return put(token, board, profileId, adopted, created.revision, snapshot, omitted, overLimit);
      }
      return fail(created);
    },

    /** Brings a session of the account to this machine as a new board. */
    async open(profileId: string, sessionId: string, folder?: FolderChoice): Promise<OpenResult> {
      const token = await deps.ensureToken();
      if (!token) return { ok: false, failure: LOGIN };
      const res = await deps.api.get(token, profileId, sessionId, { installId: deps.installId() });
      if (!res.ok) return fail(res);
      const detail = res.value;
      return restore(profileId, detail.id, detail.revision, detail.snapshot, detail.projectRef, folder);
    },

    /**
     * "Keep mine" saves again over the revision the account has now; "keep the
     * account's" opens that revision as a new board and points the link at it.
     * The local board is never overwritten in place: the canvas it came from may
     * be open, and what this machine changed stays recoverable on it.
     */
    async resolveConflict(boardId: string, profileId: string, choice: "mine" | "account", folder?: FolderChoice): Promise<ResolveResult> {
      const token = await deps.ensureToken();
      if (!token) return { ok: false, failure: LOGIN };
      const link = deps.links.get(boardId);
      const board = deps.store.getBoard(boardId);
      if (!link || !board || link.profileId !== profileId) {
        return { ok: false, failure: { state: "error", code: "no_link", message: "the session is not linked to the account" } };
      }
      if (choice === "mine") {
        const { built } = await snapshotOf(board);
        const current = await deps.api.get(token, profileId, link.sessionId, { installId: deps.installId() });
        if (!current.ok) return fail(current);
        const saved = await put(token, board, profileId, link, current.value.revision, built.snapshot, built.omitted, built.overLimit);
        if (saved.ok) return { ok: true, choice: "mine", revision: saved.revision, summary: saved.summary };
        return saved;
      }
      const res = await deps.api.get(token, profileId, link.sessionId, { installId: deps.installId() });
      if (!res.ok) return fail(res);
      const opened = await restore(profileId, link.sessionId, res.value.revision, res.value.snapshot, res.value.projectRef, folder ?? { kind: "path", path: board.cwd });
      if (!opened.ok) return "failure" in opened ? opened : { ok: false, failure: { state: "error", code: "needs_folder", message: "a project folder is needed" } };
      deps.links.remove(boardId);
      return { ok: true, choice: "account", boardId: opened.boardId, revision: opened.revision, cleanTerminals: opened.cleanTerminals };
    },

    async archive(profileId: string, sessionId: string): Promise<{ ok: true } | { ok: false; failure: SessionFailure }> {
      const token = await deps.ensureToken();
      if (!token) return { ok: false, failure: LOGIN };
      const res = await deps.api.patch(token, profileId, sessionId, { archivedAt: new Date(deps.now()).toISOString() }, deps.installId());
      return res.ok ? { ok: true } : fail(res);
    },

    link(boardId: string): SessionLink | null {
      return deps.links.get(boardId);
    },
  };

  async function restore(
    profileId: string,
    sessionId: string,
    revision: number,
    snapshot: SessionSnapshot,
    projectRef: ProjectRef | null,
    folder: FolderChoice | undefined,
  ): Promise<OpenResult> {
    let root: string | null;
    if (folder?.kind === "none") root = null;
    else if (folder?.kind === "path") {
      if (!(await deps.folderExists(folder.path))) {
        return { ok: false, needsFolder: { projectRef, candidates: await candidatesFor(projectRef) } };
      }
      root = folder.path;
    } else {
      const found = await candidatesFor(projectRef);
      const sure = found.filter((c) => c.match === "remote");
      const named = found.filter((c) => c.match === "name");
      const pick = sure[0] ?? (projectRef?.kind === "folder" && named.length === 1 ? named[0] : undefined);
      if (!pick) return { ok: false, needsFolder: { projectRef, candidates: found } };
      root = pick.path;
    }
    // An account profile can only hold a session once it is brought in; the board is the profile's.
    const plan: RestorePlan = planRestore({
      snapshot,
      root,
      fallbackCwd: deps.fallbackCwd(),
      profileId,
      newId: deps.newId,
      now: deps.now(),
      resumeExists: deps.resumeExists,
    });
    try {
      deps.store.upsertBoard(plan.board);
      for (const card of plan.cards) deps.store.upsertCard(card);
      for (const connector of plan.connectors) deps.store.upsertConnector(connector);
      for (const task of plan.tasks) deps.store.upsertTask(task);
      for (const link of plan.taskCards) deps.store.linkTaskCard(link.task_id, link.card_id, link.role);
    } catch (err) {
      deps.store.deleteBoard(plan.board.id);
      return { ok: false, failure: { state: "error", code: "restore_failed", message: err instanceof Error ? err.message : String(err) } };
    }
    deps.links.set(plan.board.id, { profileId, sessionId, revision, savedAt: deps.now(), omitted: 0 });
    return { ok: true, boardId: plan.board.id, revision, cleanTerminals: plan.cleanTerminals, cardCount: plan.cards.length, folder: root };
  }

  /** Folders of the boards on this machine that look like the project the session names. */
  async function candidatesFor(projectRef: ProjectRef | null): Promise<FolderCandidate[]> {
    if (!projectRef) return [];
    const seen = new Set<string>();
    const out: FolderCandidate[] = [];
    for (const b of deps.store.listBoards()) {
      const path = b.cwd;
      if (path === "" || seen.has(path)) continue;
      seen.add(path);
      if (!(await deps.folderExists(path))) continue;
      const remoteUrl = await deps.gitRemote(path).catch(() => null);
      const match = matchProjectRef(projectRef, { path, remoteUrl });
      if (match) out.push({ path, match });
    }
    return out.sort((a, b) => (a.match === b.match ? 0 : a.match === "remote" ? -1 : 1));
  }
}

export type CloudSessions = ReturnType<typeof createCloudSessions>;

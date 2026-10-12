/**
 * ACCOUNT SESSIONS — the renderer's decisions: what the state pill says, what
 * a row of the account list shows, which screen a failure leads to and when the
 * profile in view can hold sessions at all. Pure; the components only draw it.
 */

import type {
  AccountSessionFailure,
  AccountSessionLink,
  AccountSessionProjectRef,
  AccountSessionSaveResult,
  AccountSessionView,
} from "../../preload/index";

/** Dispatched after the main process wrote a board (a session opened from the account). */
export const BOARDS_CHANGED_EVENT = "ac:boards-changed";

/**
 * A profile can hold sessions only when the server knows it: the sidebar lists
 * a team the account belongs to even before the server has a profile row for it,
 * under an id the server cannot answer to.
 */
export function profileCanHoldSessions(profileId: string | null | undefined): profileId is string {
  return typeof profileId === "string" && profileId !== "" && !profileId.startsWith("team:");
}

/** What the pill beside a session's state says. */
export type SaveState =
  | { kind: "unsaved" }
  | { kind: "saved"; revision: number }
  | { kind: "conflict" }
  | { kind: "offline" };

export type SaveStateTone = "idle" | "ok" | "warn" | "info";

export function decideSaveState(link: AccountSessionLink | null, last: SaveOutcome | null): SaveState {
  if (last?.kind === "conflict") return { kind: "conflict" };
  if (last?.kind === "offline") return { kind: "offline" };
  if (link) return { kind: "saved", revision: link.revision };
  return { kind: "unsaved" };
}

export function saveStateTone(state: SaveState): SaveStateTone {
  switch (state.kind) {
    case "saved":
      return "ok";
    case "conflict":
    case "offline":
      return "warn";
    default:
      return "idle";
  }
}

/** The result of the last save, reduced to what the pill needs. */
export type SaveOutcome = { kind: "saved" } | { kind: "conflict" } | { kind: "offline" } | { kind: "failed" };

export function outcomeOfSave(result: AccountSessionSaveResult): SaveOutcome {
  if (result.ok) return { kind: "saved" };
  if ("conflict" in result) return { kind: "conflict" };
  return result.failure.state === "offline" ? { kind: "offline" } : { kind: "failed" };
}

/** The screen a failure leads to. `plan` and `offline` have their own panels; the rest is a message. */
export type FailureScreen = "plan" | "offline" | "login" | "message";

export function failureScreen(failure: AccountSessionFailure): FailureScreen {
  switch (failure.state) {
    case "plan":
      return "plan";
    case "offline":
      return "offline";
    case "login":
      return "login";
    default:
      return "message";
  }
}

/** The i18n key that says what happened for a failure that is shown as a message. */
export function failureMessageKey(failure: AccountSessionFailure):
  | "accountSession.failure.limit"
  | "accountSession.failure.tooLarge"
  | "accountSession.failure.rateLimited"
  | "accountSession.failure.gone"
  | "accountSession.failure.invalid"
  | "accountSession.failure.error"
  | "accountSession.failure.login"
  | "accountSession.failure.expired" {
  switch (failure.state) {
    case "limit":
      return "accountSession.failure.limit";
    case "too-large":
      return "accountSession.failure.tooLarge";
    case "rate-limited":
      return "accountSession.failure.rateLimited";
    case "gone":
      return "accountSession.failure.gone";
    case "invalid":
      return "accountSession.failure.invalid";
    case "login":
      return "accountSession.failure.login";
    case "plan":
      return "accountSession.failure.expired";
    default:
      return "accountSession.failure.error";
  }
}

/** `github.com/org/repo` for a git project; the folder name (alone) otherwise. */
export function projectRefParts(ref: AccountSessionProjectRef | null): { kind: "git" | "folder" | "none"; text: string } {
  if (!ref) return { kind: "none", text: "" };
  return ref.kind === "git" ? { kind: "git", text: ref.remote } : { kind: "folder", text: ref.name };
}

/** The numbers of a row's meta line, in the order they are shown. */
export function sessionMetaParts(s: Pick<AccountSessionView, "cardCount" | "taskCount" | "updatedByDevice" | "updatedAt">, nowMs: number): {
  cards: number;
  tasks: number;
  device: string | null;
  updatedMs: number | null;
  ageMs: number | null;
} {
  const updated = Date.parse(s.updatedAt);
  const updatedMs = Number.isNaN(updated) ? null : updated;
  return {
    cards: s.cardCount,
    tasks: s.taskCount,
    device: s.updatedByDevice,
    updatedMs,
    ageMs: updatedMs === null ? null : Math.max(0, nowMs - updatedMs),
  };
}

/** Sessions of the account, the ones held on this machine first, then the most recently saved. */
export function sortAccountSessions(sessions: readonly AccountSessionView[]): AccountSessionView[] {
  return [...sessions].sort((a, b) => {
    const here = Number(b.openHereBoardId !== null) - Number(a.openHereBoardId !== null);
    if (here !== 0) return here;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });
}

/** Whether a folder candidate is as sure as it gets (same git remote) or only close (same folder name). */
export function candidateLabelKey(match: "remote" | "name"): "accountSession.folder.sameRemote" | "accountSession.folder.otherRemote" {
  return match === "remote" ? "accountSession.folder.sameRemote" : "accountSession.folder.otherRemote";
}

/** Words for how long ago, without a library: the list is read, not measured. */
export function ageBucket(ageMs: number | null): { unit: "now" | "min" | "hour" | "day"; n: number } | null {
  if (ageMs === null) return null;
  const min = Math.floor(ageMs / 60_000);
  if (min < 1) return { unit: "now", n: 0 };
  if (min < 60) return { unit: "min", n: min };
  const hours = Math.floor(min / 60);
  if (hours < 24) return { unit: "hour", n: hours };
  return { unit: "day", n: Math.floor(hours / 24) };
}

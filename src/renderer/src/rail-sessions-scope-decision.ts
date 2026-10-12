import { assignmentsFromRows, partitionBoards, type SessionAssignments, type SessionsView } from "./account-scope-decision";

/** Fired by the account code after session owners were written to the database. */
export const ACCOUNT_SESSIONS_CHANGED_EVENT = "ac:account-sessions-changed";

/**
 * The view the open board belongs to: the owner of the board in view decides.
 * A board no account profile owns is local; an owned one shows its owner's
 * sessions. The two never mix, so the list never offers a session from the
 * other side.
 */
export function viewOfBoard(assignments: SessionAssignments, activeBoardId: string | null): SessionsView {
  const owner = activeBoardId ? assignments[activeBoardId] : undefined;
  return owner === undefined ? { scope: "local" } : { scope: "account", accountProfileId: owner };
}

/** Sessions of the open board's scope, in the order given; all of them until the owners are read. */
export function sessionsInScope<T extends { id: string }>(
  boards: readonly T[],
  rows: readonly { id: string; account_profile_id?: string | null }[] | null,
  activeBoardId: string | null,
): T[] {
  if (rows === null) return [...boards];
  const assignments = assignmentsFromRows(rows);
  return partitionBoards(boards, assignments, viewOfBoard(assignments, activeBoardId));
}

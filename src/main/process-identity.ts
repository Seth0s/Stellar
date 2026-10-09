import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export type ProcessIdentity = {
  cardId: string;
  boardId: string | null;
};

export type CardProcessRoot = ProcessIdentity & {
  pid: number;
  startTime: bigint;
};

export type LinuxProcessStat = {
  pid: number;
  parentPid: number;
  startTime: bigint;
};

export function parseLinuxProcessStat(line: string): LinuxProcessStat | null {
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  const open = line.indexOf("(");
  if (open <= 0 || open > close) return null;
  const pid = Number(line.slice(0, open).trim());
  const fields = line.slice(close + 1).trim().split(/\s+/);
  if (!Number.isSafeInteger(pid) || pid <= 0 || fields.length < 20) return null;
  const parentPid = Number(fields[1]);
  let startTime: bigint;
  try {
    startTime = BigInt(fields[19]);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || startTime < 0n) return null;
  return { pid, parentPid, startTime };
}

export function readLinuxProcessStat(pid: number): LinuxProcessStat | null {
  try {
    const parsed = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    return parsed?.pid === pid ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveProcessCardIdentity(
  peerPid: number,
  roots: readonly CardProcessRoot[],
  readStat: (pid: number) => LinuxProcessStat | null = readLinuxProcessStat,
): ProcessIdentity | null {
  if (!Number.isSafeInteger(peerPid) || peerPid <= 0) return null;
  const rootByPid = new Map(roots.map((root) => [root.pid, root]));
  const visited = new Set<number>();
  let pid = peerPid;
  let childStartTime: bigint | null = null;

  for (let depth = 0; depth < 128; depth += 1) {
    if (visited.has(pid)) return null;
    visited.add(pid);
    const stat = readStat(pid);
    if (!stat || stat.pid !== pid) return null;
    if (childStartTime !== null && stat.startTime > childStartTime) return null;

    const root = rootByPid.get(pid);
    if (root) {
      if (root.startTime !== stat.startTime) return null;
      return { cardId: root.cardId, boardId: root.boardId };
    }
    if (stat.parentPid <= 0 || stat.parentPid === pid) return null;
    childStartTime = stat.startTime;
    pid = stat.parentPid;
  }
  return null;
}

export type CardIdentityRecord = ProcessIdentity & { pid: number; startTime: bigint | null; authToken: string };

export function createProcessIdentityAuthority(
  readStat: (pid: number) => LinuxProcessStat | null = readLinuxProcessStat,
) {
  const cards = new Map<string, CardIdentityRecord>();

  function issueToken(): string {
    return randomBytes(32).toString("base64url");
  }

  function register(input: {
    cardId: string;
    boardId: string | null;
    pid: number;
    startTime: bigint | null;
    authToken: string;
  }): void {
    // Heal a null startTime immediately: a card registered without it is
    // invisible to resolvePeer (filtered out), so a legitimate Unix-relay
    // client is refused — worse than the pre-identity world. Re-read /proc
    // (or the Darwin addon) once more at register time before freezing null.
    let startTime = input.startTime;
    if (startTime === null) {
      startTime = readStat(input.pid)?.startTime ?? null;
    }
    cards.set(input.cardId, {
      cardId: input.cardId,
      boardId: input.boardId,
      pid: input.pid,
      startTime,
      authToken: input.authToken,
    });
  }

  /** Patch boardId after register when the store upsert races past pty:spawn. */
  function bindBoard(cardId: string, boardId: string): void {
    const record = cards.get(cardId);
    if (!record || !boardId) return;
    record.boardId = boardId;
  }

  function remove(cardId: string): void {
    cards.delete(cardId);
  }

  function healStartTimes(): void {
    for (const record of cards.values()) {
      if (record.startTime !== null) continue;
      const info = readStat(record.pid);
      if (info && info.pid === record.pid) record.startTime = info.startTime;
    }
  }

  function resolvePeer(peerPid: number): ProcessIdentity | null {
    healStartTimes();
    return resolveProcessCardIdentity(
      peerPid,
      [...cards.values()].filter((record): record is CardIdentityRecord & { startTime: bigint } => record.startTime !== null),
      readStat,
    );
  }

  function resolveToken(token: string): ProcessIdentity | null {
    if (!token) return null;
    const supplied = Buffer.from(token);
    for (const record of cards.values()) {
      const expected = Buffer.from(record.authToken);
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
        return { cardId: record.cardId, boardId: record.boardId };
      }
    }
    return null;
  }

  function tokenForCard(cardId: string): string | null {
    return cards.get(cardId)?.authToken ?? null;
  }

  function identityForCard(cardId: string): ProcessIdentity | null {
    const record = cards.get(cardId);
    return record ? { cardId: record.cardId, boardId: record.boardId } : null;
  }

  function secrets(): string[] {
    return [...cards.values()].map((record) => record.authToken);
  }

  return { issueToken, register, bindBoard, remove, resolvePeer, resolveToken, identityForCard, tokenForCard, secrets };
}

export type ProcessIdentityAuthority = ReturnType<typeof createProcessIdentityAuthority>;

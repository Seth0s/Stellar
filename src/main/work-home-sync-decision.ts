/**
 * WORK HOME — the sync DECISION, no I/O (BACKEND_V1.md §5.4).
 *
 * A push sends the WHOLE manifest to the server, so the problem is a
 * three-way merge per PATH between LOCAL (what the machine has now),
 * REMOTE (the server's latest revision) and BASE (the last revision
 * synced here):
 *
 *   base    local        remote       outcome
 *   —       present      absent       enter (new local)
 *   —       absent       present      keep remote (created by another device)
 *   A       ==base       !=base       keep REMOTE (only remote changed)
 *   A       !=base       ==base       LOCAL wins (only local changed)
 *   A       !=base       !=base       CONFLICT (both changed)
 *   A       absent       ==base       REMOVAL (deleted locally, remote intact)
 *   A       absent       !=base       CONFLICT (deleted locally, remote changed)
 *   A       absent       absent       REMOVAL (already gone from both sides)
 *
 * A `409` is the SAME problem: the server returns the current manifest and
 * `planPush` runs again against it — files that only remote changed come in
 * on their own; files both sides changed become CONFLICTs for the UI to
 * choose (keep local / remote / both). Different revisions never conflict.
 *
 * Pure: no fs, no network. The I/O shell is `work-home-sync.ts`.
 */

import {
  buildManifest,
  manifestByPath,
  type WorkHomeManifest,
  type WorkHomeManifestEntry,
} from "./work-home-manifest";

export type PushConflict = {
  path: string;
  baseSha: string | null;
  localSha: string;
  remoteSha: string;
};

export type PushPlan = {
  /** Manifest to send, with remote already preserved where it won. Conflicts
   *  keep the LOCAL version by default (the caller resolves or asks). */
  manifest: WorkHomeManifest;
  conflicts: PushConflict[];
  /** Shas of the (non-deleted) files the send references — for check/upload. */
  shas: string[];
};

/** Three-way merge per path → the manifest to send + the real conflicts. */
export function planPush(
  local: WorkHomeManifest,
  remote: WorkHomeManifest | null,
  base: WorkHomeManifest | null,
): PushPlan {
  const localMap = manifestByPath(local);
  const remoteMap = manifestByPath(remote);
  const baseMap = manifestByPath(base);

  const entries: WorkHomeManifestEntry[] = [];
  const removals: string[] = [];
  const conflicts: PushConflict[] = [];

  const paths = new Set<string>([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()]);
  for (const path of paths) {
    const L = localMap.get(path);
    const R = remoteMap.get(path);
    const B = baseMap.get(path);

    if (L && R) {
      if (L.sha256 === R.sha256) {
        entries.push(L);
        continue;
      }
      const localChanged = !B || B.sha256 !== L.sha256;
      const remoteChanged = !B || B.sha256 !== R.sha256;
      if (localChanged && remoteChanged) {
        conflicts.push({ path, baseSha: B?.sha256 ?? null, localSha: L.sha256, remoteSha: R.sha256 });
        entries.push(L);
      } else if (localChanged) {
        entries.push(L);
      } else {
        entries.push(R);
      }
      continue;
    }

    if (L && !R) {
      entries.push(L);
      continue;
    }

    if (!L && R) {
      if (B && B.sha256 === R.sha256) {
        removals.push(path);
      } else if (B && B.sha256 !== R.sha256) {
        conflicts.push({ path, baseSha: B.sha256, localSha: "", remoteSha: R.sha256 });
      } else {
        entries.push(R);
      }
      continue;
    }

    // base only: gone from both sides.
    if (B) removals.push(path);
  }

  const manifest = buildManifest(entries, removals);
  const shas = [...new Set(manifest.entries.map((entry) => entry.sha256))];
  return { manifest, conflicts, shas };
}

/**
 * Applies the UI's choices over the push conflicts. `remote` is the remote
 * manifest that produced the conflict (to find the remote version). A missing
 * choice keeps the LOCAL version (the `planPush` default). `both` on push is
 * resolved on ARRIVAL (two files) — here it acts as "keep local" in the
 * manifest, and the UI handles the suffix when applying the remote.
 */
export function resolvePushConflicts(input: {
  manifest: WorkHomeManifest;
  conflicts: readonly PushConflict[];
  remote: WorkHomeManifest | null;
  choices: Readonly<Record<string, "local" | "remote" | "both">>;
}): WorkHomeManifest {
  const remoteMap = manifestByPath(input.remote);
  const chosenRemote = new Set<string>();
  const chosenRemoval = new Set<string>();
  for (const conflict of input.conflicts) {
    const choice = input.choices[conflict.path];
    if (choice === "remote") {
      if (conflict.remoteSha === "") chosenRemoval.add(conflict.path);
      else chosenRemote.add(conflict.path);
    }
  }
  const entries: WorkHomeManifestEntry[] = [];
  for (const entry of input.manifest.entries) {
    if (chosenRemoval.has(entry.path)) continue;
    if (chosenRemote.has(entry.path)) {
      const r = remoteMap.get(entry.path);
      if (r) {
        entries.push(r);
        continue;
      }
    }
    entries.push(entry);
  }
  const removals = input.manifest.removals.filter((p) => !chosenRemote.has(p));
  for (const path of chosenRemoval) if (!removals.includes(path)) removals.push(path);
  return buildManifest(entries, removals);
}

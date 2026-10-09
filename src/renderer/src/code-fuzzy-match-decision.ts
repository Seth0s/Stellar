/**
 * Rank file paths for the Ctrl+P go-to palette. Prefer substring hits,
 * then subsequence (fuzzy) matches; never invent paths — callers pass
 * candidates from the real tree / git index.
 */

export type FuzzyCandidate = { path: string; name: string };

export type FuzzyHit = FuzzyCandidate & { score: number };

function subsequenceScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t.includes(q)) {
    // Prefer shorter paths and earlier matches.
    const at = t.indexOf(q);
    return 1000 - at - Math.min(200, t.length);
  }
  let ti = 0;
  let gaps = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  return 400 - gaps - Math.min(100, t.length);
}

/** Rank candidates for `query`; empty query → empty list (palette waits). */
export function decideFuzzyFileHits(
  query: string,
  candidates: readonly FuzzyCandidate[],
  limit = 40,
): FuzzyHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: FuzzyHit[] = [];
  for (const c of candidates) {
    const byName = subsequenceScore(q, c.name);
    const byPath = subsequenceScore(q, c.path);
    const score =
      byName === null && byPath === null
        ? null
        : Math.max(byName ?? -Infinity, (byPath ?? -Infinity) - 50);
    if (score === null) continue;
    hits.push({ ...c, score });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}

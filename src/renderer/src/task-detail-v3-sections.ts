/**
 * Pure helpers that pull Resumo sections from a task prompt / gate facts
 * without inventing copy the app did not store.
 */

/** Bullet lines under an "O aceite" / "ACEITE" heading in the briefing. */
export function extractAcceptanceBullets(prompt: string | null | undefined): string[] {
  if (!prompt) return [];
  const lines = prompt.split(/\r?\n/);
  const bullets: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(o\s+aceite|aceite)\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^(fazer|regras|gates|território|territorio|o\s+que\b|##|#{1,3}\s)/i.test(line) && !/^[-*•]/.test(line)) {
        break;
      }
      const m = line.match(/^[-*•]\s+(.+)$/);
      if (m?.[1]) bullets.push(m[1].trim());
      else if (line.length === 0 && bullets.length > 0) break;
    }
  }
  return bullets;
}

/** First prose block under a "what is" heading, or leading paragraphs before structured sections. */
export function extractWhatIsBlurb(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const lines = prompt.split(/\r?\n/);
  const out: string[] = [];
  let started = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^o\s+que\s+é\b/i.test(line)) {
      started = true;
      continue;
    }
    if (!started && out.length === 0 && line.length > 0 && !/^(fazer|aceite|regras|gates|#{1,3}\s)/i.test(line)) {
      // Leading prose without an explicit heading is the summary blurb.
      out.push(line);
      continue;
    }
    if (started) {
      if (/^(o\s+aceite|aceite|fazer|o\s+que\s+foi|##|#{1,3}\s)/i.test(line)) break;
      if (line) out.push(line);
      else if (out.length > 0) break;
    } else if (out.length > 0 && (line.length === 0 || /^(fazer|aceite|o\s+aceite|##)/i.test(line))) {
      break;
    }
  }
  const text = out.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

export type MeasuredGateRow = {
  cmd: string;
  ok: boolean;
  detail: string | null;
};

/** Gate chips for Resumo from a measured gateRun (never invents commands). */
export function measuredGateRows(gateRun: {
  ok: boolean;
  passed?: number;
  total?: number;
  failedCommand: string | null;
  isolation?: { undeclaredInTerritory: string[] } | null;
} | null): MeasuredGateRow[] {
  if (!gateRun) return [];
  const outside = gateRun.isolation?.undeclaredInTerritory.length ?? 0;
  if (gateRun.failedCommand) {
    return [
      {
        cmd: gateRun.failedCommand,
        ok: false,
        detail: outside > 0 ? `${outside} arquivos fora do território` : null,
      },
    ];
  }
  if (gateRun.ok) {
    const n = gateRun.total != null ? `${gateRun.passed ?? gateRun.total}/${gateRun.total}` : null;
    return [{ cmd: "gates", ok: true, detail: n }];
  }
  return [];
}

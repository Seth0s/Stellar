/**
 * Pure helpers for editing board-context rules / gateToolPaths from Settings.
 * Persistence stays in board-context.ts; this file only shapes text ↔ entries.
 */
import type { BoardContext, BoardContextEntry } from "./board-context";

/** One rule per non-empty line; leading list markers are stripped. */
export function rulesTextFromEntries(rules: readonly BoardContextEntry[]): string {
  return rules.map((r) => r.text).join("\n");
}

export function entriesFromRulesText(text: string, at = Date.now(), addedBy = "human"): BoardContextEntry[] {
  const out: BoardContextEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*[-*•]\s*/, "").trim();
    if (line === "") continue;
    const key = line.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: line, at, addedBy });
  }
  return out;
}

export function applyRulesText(ctx: BoardContext, text: string, at = Date.now()): BoardContext {
  return { ...ctx, rules: entriesFromRulesText(text, at, "human") };
}

export function applyGateToolPaths(ctx: BoardContext, paths: readonly string[]): BoardContext {
  const cleaned: string[] = [];
  for (const p of paths) {
    const t = p.trim();
    if (t === "" || cleaned.includes(t)) continue;
    cleaned.push(t);
  }
  if (cleaned.length === 0) {
    const { gateToolPaths: _drop, ...rest } = ctx;
    return rest;
  }
  return { ...ctx, gateToolPaths: cleaned };
}

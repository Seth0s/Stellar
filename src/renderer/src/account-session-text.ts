/**
 * ACCOUNT SESSIONS — small helpers the components share: count words, text with
 * nodes woven in, and the link of each board to the account.
 */

import { Fragment, createElement, useCallback, useEffect, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n";
import type { AccountSessionLink } from "../../preload/index";

/** Puts nodes where a translated text has their tokens (the catalog stays plain text). */
export function weave(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const keys = Object.keys(nodes);
  if (keys.length === 0) return text;
  const parts = text.split(new RegExp(`(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`));
  return parts.map((part, i) => (part in nodes ? createElement(Fragment, { key: i }, nodes[part]) : part));
}

/** "7 cards", "1 card" — the count words are catalog text, not plural rules in code. */
export function countText(kind: "cards" | "tasks" | "connections", n: number): string {
  const key = `accountSession.${kind}.${n === 1 ? "one" : "many"}` as const;
  return t(key, { n });
}

/**
 * The link of each board to the account (revision last seen), read from main.
 * `reload` reads again after a save or an open.
 */
export function useSessionLinks(boardIds: readonly string[]): { links: Record<string, AccountSessionLink | null>; reload: () => void } {
  const [links, setLinks] = useState<Record<string, AccountSessionLink | null>>({});
  const [tick, setTick] = useState(0);
  const key = boardIds.join(",");
  useEffect(() => {
    let alive = true;
    void Promise.all(boardIds.map(async (id) => [id, await window.accountSessions.link(id).catch(() => null)] as const)).then((pairs) => {
      if (alive) setLinks(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
    // `key` stands for the ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { links, reload };
}


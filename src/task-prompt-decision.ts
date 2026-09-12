/**
 * Task prompt writes — append by default, replace only with explicit intent.
 *
 * The original statement stays in place: it is why the task exists. Later
 * text is concatenated with a visible marker so `get_task` / "read your
 * task" shows what arrived after create. The Fila edit modal parses the
 * same string (`parseTaskPrompt`) instead of a second column.
 *
 * Marker text is AGENT-facing (English, not i18n). `kind: "prompt"` in
 * `task_transitions` is the audit trail; this module only shapes the
 * stored `tasks.prompt` value.
 */

export type TaskPromptWriteMode = "append" | "replace";

export type TaskPromptAddition = { at: number; text: string };

export type ParsedTaskPrompt = {
  original: string;
  additions: TaskPromptAddition[];
};

/** Visible, parseable section header. Do not translate. */
export const TASK_PROMPT_ADDITION_MARKER = "[stellar:added ";

const ADDITION_SPLIT = /\n\n---\n\[stellar:added ([^\]]+)\]\n/;

export function formatTaskPromptAddition(existing: string, addition: string, at: number): string {
  const iso = new Date(at).toISOString();
  return `${existing}\n\n---\n${TASK_PROMPT_ADDITION_MARKER}${iso}]\n${addition}`;
}

export function parseTaskPrompt(prompt: string | null | undefined): ParsedTaskPrompt {
  if (!prompt) return { original: "", additions: [] };
  const parts = prompt.split(ADDITION_SPLIT);
  const original = parts[0] ?? "";
  const additions: TaskPromptAddition[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const iso = parts[i] ?? "";
    const text = parts[i + 1] ?? "";
    const parsed = Date.parse(iso);
    additions.push({ at: Number.isNaN(parsed) ? 0 : parsed, text });
  }
  return { original, additions };
}

export function applyTaskPromptWrite(opts: {
  existing: string | null | undefined;
  incoming: string;
  mode: TaskPromptWriteMode;
  at: number;
}): { ok: true; prompt: string; changed: boolean } | { ok: false; error: string } {
  const incoming = opts.incoming.trim();
  if (!incoming) return { ok: false, error: "empty prompt" };
  const previous = opts.existing ?? null;
  if (opts.mode === "replace") {
    return { ok: true, prompt: incoming, changed: incoming !== previous };
  }
  const existing = previous ?? "";
  if (!existing.trim()) {
    return { ok: true, prompt: incoming, changed: incoming !== previous };
  }
  return { ok: true, prompt: formatTaskPromptAddition(existing, incoming, opts.at), changed: true };
}

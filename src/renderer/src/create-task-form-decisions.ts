/**
 * Create-task modal (app-v3 screen 7) — pure form → create_task contract.
 * Reuses the same field shapes as MCP create_task; no second validation.
 */

import type { TaskPurpose } from "../../task-purpose";
import { TASK_PURPOSES } from "../../task-purpose";
import { territoriesOverlap } from "./team-board-decisions";

export type CreateWhen = "deps" | "now" | "reserve";

export type CreateTerritoryTag = {
  path: string;
  shared: boolean;
  sharedNote: string;
};

export type CreateGateDraft = { cmd: string; exclusiveMachine: boolean };

export type CreateTaskFormState = {
  title: string;
  purpose: TaskPurpose;
  briefing: string;
  territory: CreateTerritoryTag[];
  gates: CreateGateDraft[];
  reportSchema: string[];
  allowCommit: boolean;
  reviewWanted: boolean;
  provider: string;
  model: string;
  effort: string;
  sprintLabel: string;
  deps: { id: string; title: string; statusLabel: string }[];
  when: CreateWhen;
  maxRetries: number;
  fallbackProviders: string;
  cwd: string;
  spawnProfile: string;
  suggestedPriority: "alta" | "normal";
  advancedOpen: boolean;
};

export const PURPOSE_META: Record<TaskPurpose, { label: string; hint: string }> = {
  investigate: { label: "Investigar", hint: "O que sai é conhecimento, não mudança no código." },
  implement: { label: "Implementar", hint: "Construir algo novo." },
  measure: { label: "Medir", hint: "Juntar números sobre o estado atual." },
  fix: { label: "Corrigir", hint: "Consertar um defeito no que já existe." },
  integrate: { label: "Integrar", hint: "Convergência verificada de um lote de tasks." },
};

export const DEFAULT_REPORT_SCHEMA = [
  "filesChanged",
  "decisaoTomada",
  "evidenciaMedida",
  "oQueNaoFiz",
  "gatesOutput",
] as const;

export function emptyCreateTaskForm(seed?: Partial<CreateTaskFormState>): CreateTaskFormState {
  return {
    title: "",
    purpose: "fix",
    briefing: "",
    territory: [],
    gates: [{ cmd: "", exclusiveMachine: false }],
    reportSchema: [...DEFAULT_REPORT_SCHEMA],
    allowCommit: false,
    reviewWanted: true,
    provider: "claude",
    model: "",
    effort: "alto",
    sprintLabel: "",
    deps: [],
    when: "deps",
    maxRetries: 2,
    fallbackProviders: "",
    cwd: "",
    spawnProfile: "",
    suggestedPriority: "normal",
    advancedOpen: false,
    ...seed,
  };
}

export function purposeFromQuickKind(kind: string): TaskPurpose {
  switch (kind) {
    case "investigar":
      return "investigate";
    case "implementar":
      return "implement";
    case "medir":
      return "measure";
    case "integrar":
      return "integrate";
    default:
      return "fix";
  }
}

/** Running board tasks that overlap the draft territory (path globs). */
export type ActiveTerritoryTask = {
  id: string;
  title: string;
  territory: readonly string[];
  phase: string;
};

export function territoryConflictsForCreate(
  tags: readonly CreateTerritoryTag[],
  active: readonly ActiveTerritoryTask[],
): ActiveTerritoryTask[] {
  const wanted = tags.map((t) => t.path.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  return active.filter(
    (task) =>
      (task.phase === "running" || task.phase === "awaiting_review" || task.phase === "changes_requested") &&
      task.territory.some((owned) => wanted.some((w) => territoriesOverlap(owned, w))),
  );
}

export function primaryCtaLabel(when: CreateWhen): string {
  if (when === "now") return "Criar e despachar";
  if (when === "reserve") return "Criar e reservar";
  return "Criar";
}

export function whereColumn(when: CreateWhen): string {
  if (when === "now") return "Rodando";
  if (when === "reserve") return "Pronta";
  return "Esperando";
}

export function whereCardLine(form: CreateTaskFormState): string {
  if (form.when === "now") return `Abre um card ${form.provider} ao criar`;
  if (form.when === "reserve") return "Na fila do card reservado, depois da task atual";
  const dep = form.deps[0];
  if (dep) return `Começa sozinha quando #${dep.id.slice(0, 6)} concluir`;
  return "Começa sozinha quando as dependências concluírem";
}

export type CreateChecklistItem = { ok: boolean; warn: boolean; text: string };

export function beforeCreateChecklist(
  form: CreateTaskFormState,
  conflicts: readonly ActiveTerritoryTask[],
): CreateChecklistItem[] {
  const items: CreateChecklistItem[] = [];
  const hasTitle = form.title.trim().length > 0 && form.briefing.trim().length > 0;
  items.push({ ok: hasTitle, warn: false, text: "título e briefing" });
  const hasGates = form.gates.some((g) => g.cmd.trim().length > 0);
  items.push({ ok: hasGates, warn: false, text: "gates declarados" });
  if (conflicts.length > 0) {
    const id = conflicts[0]!.id.slice(0, 6);
    items.push({ ok: false, warn: true, text: `território compartilhado com #${id}` });
  }
  return items;
}

/** Agent preview block — same facts the MCP create_task contract carries. */
export function agentReceivesPreview(form: CreateTaskFormState): string {
  const title = form.title.trim() || "—";
  const brief = form.briefing.trim().split(/\n/).slice(0, 2).join("\n") || "";
  const terr = form.territory
    .map((t) => {
      const base = t.path.split("/").pop() || t.path;
      return t.shared ? `${base} (compartilhado: ${t.sharedNote || "…"})` : base;
    })
    .join(", ");
  const gates = form.gates
    .filter((g) => g.cmd.trim())
    .map((g) => g.cmd.trim())
    .join(" · ");
  const report = form.reportSchema.join(", ");
  const commit = form.allowCommit ? "sim" : "não";
  const rev = form.reviewWanted ? "exigida" : "não exigida";
  const lines = [
    `[task #novo · ${PURPOSE_META[form.purpose].label.toLowerCase()}]`,
    title,
  ];
  if (brief) lines.push(brief);
  lines.push("—");
  if (terr) lines.push(`território: ${terr}`);
  if (gates) lines.push(`gates: ${gates}`);
  if (report) lines.push(`report: ${report}`);
  lines.push(`commit: ${commit} · revisão: ${rev}`);
  return lines.join("\n");
}

export type CreateTaskContract = {
  prompt: string;
  purpose: TaskPurpose;
  territory: string[];
  gates: Array<string | { cmd: string; exclusive: "machine" }>;
  reportSchema: string[];
  allowCommit: boolean;
  review: "wanted" | null;
  provider: string | null;
  deps: string[];
  maxRetries: number;
  fallbackProviders: string[];
  cwd: string | null;
  suggestedOrder: number | null;
};

/** Map form → MCP create_task fields (parseTaskContractInput shapes). */
export function formToCreateContract(form: CreateTaskFormState): CreateTaskContract {
  const title = form.title.trim();
  const briefing = form.briefing.trim();
  const prompt = briefing ? `${title}\n\n${briefing}` : title;
  const territory = form.territory.map((t) => {
    const path = t.path.trim();
    if (!t.shared) return path;
    const note = t.sharedNote.trim() || "shared";
    return `shared:${path} (${note})`;
  });
  const gates = form.gates
    .filter((g) => g.cmd.trim())
    .map((g) =>
      g.exclusiveMachine ? ({ cmd: g.cmd.trim(), exclusive: "machine" as const }) : g.cmd.trim(),
    );
  const fallback = form.fallbackProviders
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    prompt,
    purpose: form.purpose,
    territory,
    gates,
    reportSchema: form.reportSchema.filter((s) => s.trim()),
    allowCommit: form.allowCommit,
    review: form.reviewWanted ? "wanted" : null,
    provider: form.provider.trim() || null,
    deps: form.deps.map((d) => d.id),
    maxRetries: Math.max(0, Math.floor(form.maxRetries)),
    fallbackProviders: fallback,
    cwd: form.cwd.trim() || null,
    suggestedOrder: form.suggestedPriority === "alta" ? 0 : null,
  };
}

export function canSubmitCreate(form: CreateTaskFormState): boolean {
  return form.title.trim().length > 0;
}

export function isKnownPurpose(value: string): value is TaskPurpose {
  return (TASK_PURPOSES as readonly string[]).includes(value);
}

/** Seed from the quick-create dialog (board destination). */
export function seedFromQuick(input: {
  title: string;
  kind: string;
  contract: string;
  territory: readonly string[];
}): Partial<CreateTaskFormState> {
  return {
    title: input.title,
    purpose: purposeFromQuickKind(input.kind),
    briefing: input.contract,
    territory: input.territory.map((path) => ({ path, shared: false, sharedNote: "" })),
  };
}

/** Mock data from CriarTask.dc.html — used by visual smoke / parity. */
export function prototypeFilledSeed(): Partial<CreateTaskFormState> {
  return {
    title: "Terminal: scroll e desenho travam depois de sair da sessão e voltar",
    purpose: "fix",
    briefing:
      "FEEDBACK DO DONO: ao sair da sessão e voltar, o scroll do terminal não funciona…\n\nFAZER\n1. Reproduza numa instância isolada…\n2. Ache a causa com evidência e corrija na raiz.\n\nACEITE\n- Repro antes (falha) e depois (passa)…",
    territory: [
      { path: "src/renderer/src/useTerminal.ts", shared: false, sharedNote: "" },
      { path: "src/renderer/src/terminal-render*.ts", shared: false, sharedNote: "" },
      {
        path: "src/renderer/src/App.tsx",
        shared: true,
        sharedNote: "só o handler de visibilidade; releia antes de editar",
      },
    ],
    gates: [
      { cmd: "npm run check:types", exclusiveMachine: false },
      { cmd: "npx vitest run", exclusiveMachine: false },
    ],
    reportSchema: [...DEFAULT_REPORT_SCHEMA],
    allowCommit: false,
    reviewWanted: true,
    provider: "claude",
    model: "Sonnet 5.5",
    effort: "alto",
    sprintLabel: "Ciclo 2 (atual)",
    deps: [
      {
        id: "ad6787aa-0000-0000-0000-000000000001",
        title: "Investigação do terminal",
        statusLabel: "rodando",
      },
    ],
    when: "deps",
    maxRetries: 2,
    fallbackProviders: "antigravity",
    cwd: "Stellar",
    suggestedPriority: "alta",
    advancedOpen: false,
  };
}

export function prototypeConflictTasks(): ActiveTerritoryTask[] {
  return [
    {
      id: "511abc00-0000-0000-0000-000000000001",
      title: "other",
      territory: ["src/renderer/src/App.tsx"],
      phase: "running",
    },
  ];
}

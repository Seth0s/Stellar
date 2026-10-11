/**
 * Import wizard UI decisions — pure helpers for mapping, preview selection and
 * role gates (mirrors main/import-decision.ts without crossing the preload wall).
 */

export type ImportSourceId = "slack" | "linear" | "jira" | "github" | "csv";

export type ImportSourceOption = {
  id: ImportSourceId;
  letter: string;
  labelKey: string;
  tone: "slack" | "linear" | "jira" | "github" | "csv";
};

export const IMPORT_SOURCES: readonly ImportSourceOption[] = [
  { id: "slack", letter: "S", labelKey: "teamImport.source.slack", tone: "slack" },
  { id: "linear", letter: "L", labelKey: "teamImport.source.linear", tone: "linear" },
  { id: "jira", letter: "J", labelKey: "teamImport.source.jira", tone: "jira" },
  { id: "github", letter: "G", labelKey: "teamImport.source.github", tone: "github" },
  { id: "csv", letter: "csv", labelKey: "teamImport.source.csv", tone: "csv" },
];

export type ImportPreviewRow = {
  title: string;
  externalId: string;
  duplicate: boolean;
  existingRef: string | null;
  meta: string | null;
  selected: boolean;
};

export function canManageImport(role: "owner" | "admin" | "member" | null): boolean {
  return role === "owner" || role === "admin";
}

export function duplicateLabel(row: ImportPreviewRow): string | null {
  if (!row.duplicate) return null;
  if (row.existingRef) {
    const ref = row.existingRef.startsWith("#") ? row.existingRef : `#${row.existingRef}`;
    return `já importada como ${ref}`;
  }
  return "já importada";
}

export function selectedImportCount(rows: readonly ImportPreviewRow[]): number {
  return rows.filter((r) => r.selected && !r.duplicate).length;
}

export function togglePreviewSelection(rows: readonly ImportPreviewRow[], externalId: string): ImportPreviewRow[] {
  return rows.map((r) => (r.externalId === externalId && !r.duplicate ? { ...r, selected: !r.selected } : r));
}

export type MappingTarget =
  | "title"
  | "contract"
  | "assignee"
  | "archived"
  | "territory"
  | "kind_infer"
  | "kind"
  | "priority"
  | "external_id"
  | "ignore";

export type MappingRow = { sourceKey: string; sourceLabel: string; target: MappingTarget };

export function defaultSlackMapping(): MappingRow[] {
  return [
    { sourceKey: "first_line", sourceLabel: "Primeira linha", target: "title" },
    { sourceKey: "message_thread", sourceLabel: "Mensagem + thread", target: "contract" },
    { sourceKey: "reactor", sourceLabel: "Quem marcou :ticket:", target: "assignee" },
    { sourceKey: "checkmark", sourceLabel: "Reação :white_check_mark:", target: "archived" },
    { sourceKey: "file_links", sourceLabel: "Links de arquivo (src/…)", target: "territory" },
    { sourceKey: "work_kind", sourceLabel: "Tipo de trabalho", target: "kind_infer" },
  ];
}

export function updateMappingTarget(rows: readonly MappingRow[], sourceKey: string, target: MappingTarget): MappingRow[] {
  return rows.map((r) => (r.sourceKey === sourceKey ? { ...r, target } : r));
}

/** API mapping object for CSV/JSON; Slack uses fixed server-side drafts. */
export function apiMappingFromRows(rows: readonly MappingRow[]): Record<string, string> {
  const find = (t: MappingTarget, fallback: string) => rows.find((r) => r.target === t)?.sourceKey ?? fallback;
  return {
    title: find("title", "title"),
    kind: find("kind", "kind"),
    priority: find("priority", "priority"),
    contract: find("contract", "contract"),
    external_id: find("external_id", "external_id"),
  };
}

export function wizardStepState(current: 1 | 2 | 3 | 4, step: 1 | 2 | 3 | 4): "done" | "active" | "todo" {
  if (step < current) return "done";
  if (step === current) return "active";
  return "todo";
}

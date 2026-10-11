/**
 * Team import jobs — pure parse/decision layer for B9a/B9b import wizard.
 */

import { isOpaqueId } from "./local-identity-decision";

export type ImportSourceKind = "slack" | "linear" | "jira" | "github" | "csv" | "json";

export type ImportJobView = {
  id: string;
  kind: ImportSourceKind | string;
  status: string;
  rule: Record<string, unknown>;
  mapping: Record<string, unknown>;
  continueImport: boolean;
  cursor: string;
  createdCount: number;
  skippedCount: number;
  error: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ImportPreviewItem = {
  title: string;
  externalId: string;
  duplicate: boolean;
  /** Optional short ref when the server (or smoke fake) knows the existing task. */
  existingRef: string | null;
  meta: string | null;
  selected: boolean;
};

export type ImportPreview = {
  kind: string;
  items: ImportPreviewItem[];
  total: number;
  duplicates: number;
};

export type ImportFieldMappingRow = {
  sourceKey: string;
  sourceLabel: string;
  target: string;
};

export type ImportWizardStep = 1 | 2 | 3 | 4;

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw) as unknown) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
}

export function parseImportJob(raw: unknown): ImportJobView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const kind = asString(rec.kind);
  if (!id || !isOpaqueId(id) || !kind) return null;
  return {
    id,
    kind,
    status: asString(rec.status) ?? "pending",
    rule: parseJsonObject(rec.rule),
    mapping: parseJsonObject(rec.mapping),
    continueImport: rec.continue_import === true,
    cursor: typeof rec.cursor === "string" ? rec.cursor : "",
    createdCount: typeof rec.created_count === "number" ? rec.created_count : 0,
    skippedCount: typeof rec.skipped_count === "number" ? rec.skipped_count : 0,
    error: typeof rec.error === "string" ? rec.error : "",
    createdAt: asString(rec.created_at),
    updatedAt: asString(rec.updated_at),
  };
}

export function parseImportJobList(raw: unknown): ImportJobView[] {
  const rec = asRecord(raw);
  const list = Array.isArray(raw) ? raw : rec && Array.isArray(rec.imports) ? rec.imports : [];
  const out: ImportJobView[] = [];
  for (const item of list) {
    const parsed = parseImportJob(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseImportPreview(raw: unknown): ImportPreview | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const kind = asString(rec.kind) ?? "";
  const itemsRaw = Array.isArray(rec.items) ? rec.items : [];
  const items: ImportPreviewItem[] = [];
  for (const item of itemsRaw) {
    const row = asRecord(item);
    if (!row) continue;
    const title = typeof row.title === "string" ? row.title : "";
    const externalId = typeof row.external_id === "string" ? row.external_id : "";
    const duplicate = row.duplicate === true;
    items.push({
      title,
      externalId,
      duplicate,
      existingRef: asString(row.existing_ref) ?? asString(row.existingRef),
      meta: asString(row.meta),
      selected: !duplicate,
    });
  }
  return {
    kind,
    items,
    total: typeof rec.total === "number" ? rec.total : items.length,
    duplicates: typeof rec.duplicates === "number" ? rec.duplicates : items.filter((i) => i.duplicate).length,
  };
}

/** Owner/admin may preview and run imports; members cannot. */
export function canRunImport(role: "owner" | "admin" | "member" | null): boolean {
  return role === "owner" || role === "admin";
}

export function importWizardStepLabel(step: ImportWizardStep): "source" | "connect" | "map" | "review" {
  return step === 1 ? "source" : step === 2 ? "connect" : step === 3 ? "map" : "review";
}

/** Default Slack field mapping rows shown on step 3 of the prototype. */
export function defaultSlackMappingRows(): ImportFieldMappingRow[] {
  return [
    { sourceKey: "first_line", sourceLabel: "Primeira linha", target: "title" },
    { sourceKey: "message_thread", sourceLabel: "Mensagem + thread", target: "contract" },
    { sourceKey: "reactor", sourceLabel: "Quem marcou :ticket:", target: "assignee" },
    { sourceKey: "checkmark", sourceLabel: "Reação :white_check_mark:", target: "archived" },
    { sourceKey: "file_links", sourceLabel: "Links de arquivo (src/…)", target: "territory" },
    { sourceKey: "work_kind", sourceLabel: "Tipo de trabalho", target: "kind_infer" },
  ];
}

export function defaultCsvMappingRows(columns: readonly string[]): ImportFieldMappingRow[] {
  const pick = (candidates: string[], fallback: string) => {
    const lower = columns.map((c) => c.toLowerCase());
    for (const c of candidates) {
      const idx = lower.indexOf(c);
      if (idx >= 0) return columns[idx]!;
    }
    return fallback;
  };
  return [
    { sourceKey: pick(["title", "titulo", "name"], columns[0] ?? "title"), sourceLabel: pick(["title", "titulo", "name"], "title"), target: "title" },
    { sourceKey: pick(["kind", "tipo"], "kind"), sourceLabel: pick(["kind", "tipo"], "kind"), target: "kind" },
    { sourceKey: pick(["priority", "prioridade"], "priority"), sourceLabel: pick(["priority", "prioridade"], "priority"), target: "priority" },
    { sourceKey: pick(["contract", "contrato", "body", "description"], "contract"), sourceLabel: pick(["contract", "contrato", "body"], "contract"), target: "contract" },
    { sourceKey: pick(["id", "external_id", "external id"], "id"), sourceLabel: pick(["id", "external_id"], "id"), target: "external_id" },
  ];
}

/** Build the HTTP body the B9a/B9b import endpoints accept. */
export function buildImportRequestBody(input: {
  kind: ImportSourceKind;
  channel?: string;
  reaction?: string;
  limit?: number;
  mapping?: { title?: string; kind?: string; priority?: string; contract?: string; external_id?: string };
  data?: string;
  continueImport?: boolean;
}): Record<string, unknown> {
  return {
    kind: input.kind === "github" ? "github" : input.kind,
    rule: {
      channel: input.channel ?? "",
      reaction: input.reaction ?? (input.kind === "slack" ? "ticket" : ""),
      limit: input.limit ?? 200,
    },
    mapping: {
      title: input.mapping?.title ?? "title",
      kind: input.mapping?.kind ?? "kind",
      priority: input.mapping?.priority ?? "priority",
      contract: input.mapping?.contract ?? "contract",
      external_id: input.mapping?.external_id ?? "external_id",
    },
    data: input.data ?? "",
    continue: input.continueImport === true,
  };
}

/** Preview helpers: count selected (non-duplicate) rows and format duplicate hint. */
export function previewSelectableCount(items: readonly ImportPreviewItem[]): number {
  return items.filter((i) => i.selected && !i.duplicate).length;
}

export function duplicateHint(item: ImportPreviewItem): string | null {
  if (!item.duplicate) return null;
  if (item.existingRef) return `já importada como ${item.existingRef.startsWith("#") ? item.existingRef : `#${item.existingRef}`}`;
  return "já importada";
}

export function isImportJobTerminal(status: string): boolean {
  return status === "done" || status === "failed";
}

/** Apply UI mapping row targets into the API mapping object for file imports. */
export function mappingFromRows(rows: readonly ImportFieldMappingRow[]): {
  title: string;
  kind: string;
  priority: string;
  contract: string;
  external_id: string;
} {
  const byTarget = (target: string, fallback: string) => rows.find((r) => r.target === target)?.sourceKey ?? fallback;
  return {
    title: byTarget("title", "title"),
    kind: byTarget("kind", "kind"),
    priority: byTarget("priority", "priority"),
    contract: byTarget("contract", "contract"),
    external_id: byTarget("external_id", "external_id"),
  };
}

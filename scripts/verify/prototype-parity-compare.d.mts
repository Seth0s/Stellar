/** Ambient types for prototype-parity-compare.mjs — surface used by unit tests. */

export type CssColor = { r: number; g: number; b: number; a: number };

export type StyleTolerances = {
  lengthPx?: number;
  colorDeltaE?: number;
  fontWeight?: number;
};

export type StyleDiff = {
  prop: string;
  proto: string;
  impl: string;
  delta?: number | null;
  kind?: string;
  pairId?: string;
};

/** Signed allowlist row (owner sign-off). Callers may also pass incomplete
 * objects; isApprovedDiff rejects those at runtime. */
export type ApprovedDiff = {
  pairId?: string;
  prop?: string;
  approvedBy?: string;
  date?: string;
  proto?: string;
  impl?: string;
  reason?: string;
};

export function parseCssPx(value: unknown): number | null;
export function parseCssColor(value: unknown): CssColor | null;
export function colorDeltaE(
  a: string | CssColor | null | undefined,
  b: string | CssColor | null | undefined,
): number | null;

export function compareStyleProp(
  prop: string,
  protoValue: unknown,
  implValue: unknown,
  tolerances?: StyleTolerances,
): StyleDiff | null;

export function comparePairStyles(
  pairId: string,
  protoStyles: Record<string, string> | null | undefined,
  implStyles: Record<string, string> | null | undefined,
  props?: readonly string[],
  tolerances?: StyleTolerances,
): { pairId: string; diffs: StyleDiff[] };

export function isApprovedDiff(diff: StyleDiff, allowlist?: ApprovedDiff[]): boolean;

export function applyAllowlist(
  diffs: StyleDiff[],
  allowlist?: ApprovedDiff[],
): { failing: StyleDiff[]; approved: StyleDiff[] };

export function formatDiffTable(diffs: StyleDiff[]): string;
export function validateParitySpec(spec: unknown): true;

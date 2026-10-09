/**
 * Ambient types for `.mjs` scripts imported by unit tests.
 * Wildcard prefixes match the relative import paths used in tests
 * (Bundler resolution does not bind relative `declare module` names).
 */

declare module "*preflight-staged.mjs" {
  export type Finding = {
    path: string;
    rule: string;
    line?: number;
    excerpt?: string;
  };
  export function classifyAddition(line: string): string | null;
  export function formatFindings(findings: Finding[]): string;
  export function isScannedPath(path: string): boolean;
  export function scanStagedDiff(diff: string): Finding[];
}

declare module "*check-design-tokens.mjs" {
  export type SdRule = {
    id: string;
    description: string;
    propRe: RegExp;
    raw: (value: string) => string[];
    tokenFamily: string;
    noun: string;
  };

  export type SourceHit = {
    line: number;
    property: string;
    values?: string[];
    reason?: string;
  };

  export type SourceScan = {
    violations: SourceHit[];
    escapes: Array<{ line: number; property: string; reason: string }>;
  };

  export type RuleScan = {
    perFile: Record<string, number>;
    escapesByFile: Record<string, Array<{ line: number; property: string; reason: string }>>;
  };

  export type BaselineFailure = { message: string; [key: string]: unknown };

  export const SD_RULES: readonly SdRule[];

  export function checkAgainstBaseline(
    perFile: Record<string, number>,
    frozenSection: Record<string, number>,
    rule?: SdRule,
  ): BaselineFailure[];

  export function scanDesignTokens(root?: string): {
    catalog: Set<string>;
    locals: Set<string>;
    used: Map<string, string[]>;
    missing: Array<{ name: string; files: string[] }>;
    known: Array<{ name: string; files: string[]; note: string }>;
  };

  export function scanRuleSource(src: string, rule: SdRule): SourceScan;
  export function scanSpacingSource(src: string): SourceScan;
  export function scanTypographySource(src: string): SourceScan;
  export function scanRadiusSource(src: string): SourceScan;
  export function scanMotionSource(src: string): SourceScan;
  export function scanColorSource(src: string): SourceScan;

  export function scanRule(root?: string, rule?: SdRule): RuleScan;
  export function scanSpacingRule(root?: string): RuleScan;
  export function scanTypographyRule(root?: string): RuleScan;
  export function scanRadiusRule(root?: string): RuleScan;
  export function scanMotionRule(root?: string): RuleScan;
  export function scanColorRule(root?: string): RuleScan;

  export function updateBaseline(root?: string): unknown;
}

declare module "*cdp-client.mjs" {
  export function sweepStaleUserData(root: string, nowMs?: number): string[];
}

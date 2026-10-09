/**
 * Parse project-checker stdout (tsc --pretty false, eslint unix). Shared
 * so main can run the subprocess without importing renderer code.
 */

export type RawCheckerDiagnostic = {
  file: string;
  line: number;
  message: string;
  category: "error" | "warning" | "suggestion" | "message" | string;
};

/**
 * Parse `tsc --pretty false` lines:
 *   path/file.ts(12,4): error TS2322: Type 'X' is not assignable…
 * Also accepts eslint unix: path/file.ts:12:4: message [Error/…]
 */
export function decideParseCheckerOutput(stdout: string, stderr = ""): RawCheckerDiagnostic[] {
  const text = `${stdout}\n${stderr}`;
  const out: RawCheckerDiagnostic[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const tsc = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS\d+:\s*(.+)$/i);
    if (tsc) {
      const file = tsc[1]!.replace(/\\/g, "/");
      const category = tsc[4]!.toLowerCase() === "warning" ? "warning" : "error";
      const message = tsc[5]!.trim();
      const key = `${file}:${tsc[2]}:${category}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, line: Number(tsc[2]), message, category });
      continue;
    }
    const eslint = line.match(/^(.+?):(\d+):(\d+):\s*(.+?)\s*\[(Error|Warning|error|warning)/);
    if (eslint) {
      const file = eslint[1]!.replace(/\\/g, "/");
      const category = eslint[5]!.toLowerCase().startsWith("warn") ? "warning" : "error";
      const message = eslint[4]!.trim();
      const key = `${file}:${eslint[2]}:${category}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, line: Number(eslint[2]), message, category });
    }
  }
  return out;
}

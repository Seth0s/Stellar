#!/usr/bin/env node
/**
 * Preflight for the orchestrator's staged slice (`git diff --cached -U0`).
 *
 * Scans ADDITION lines only. Catches debug that historically slipped into a
 * filtered commit (tracked `src/` files — the untracked-artifact detector
 * in message-bus cannot see those). Exit 0 when clean; non-zero when any
 * finding remains. Per-line escape: `// preflight:allow <reason>` (reason
 * required).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** @typedef {{ path: string, hunk: string, line: string, rule: string }} Finding */

const ALLOW_RE = /preflight:allow\s+\S/;

/** Production app sources — tests/ and scripts/ stay out on purpose. */
export function isScannedPath(filePath) {
  const norm = filePath.replace(/\\/g, "/");
  if (!norm.startsWith("src/")) return false;
  if (/(^|\/)tests?\//.test(norm)) return false;
  if (/\.(test|spec)\.[^/]+$/.test(norm)) return false;
  return true;
}

/**
 * Per-line walk: string/template and comment spans become spaces in `code`
 * so pattern checks ignore prose. Comment bodies are collected so marker
 * rules (`// DEBUG`, `TODO remove`) still apply to real comments only.
 * Inside a template literal, `${…}` is scanned as code (brace-balanced,
 * with nested quotes/comments handled).
 *
 * @param {string} line
 * @returns {{ code: string, comments: string[] }}
 */
export function partitionAdditionLine(line) {
  /** @type {string[]} */
  const comments = [];
  const chars = line.split("");
  /** @type {("code" | "mask")[]} */
  const kind = Array.from({ length: line.length }, () => "code");

  let i = 0;

  function maskRange(from, to) {
    for (let k = from; k < to && k < kind.length; k++) kind[k] = "mask";
  }

  function skipString(quote) {
    maskRange(i, i + 1); // opening quote
    i++;
    while (i < chars.length) {
      if (chars[i] === "\\") {
        maskRange(i, Math.min(i + 2, chars.length));
        i += 2;
        continue;
      }
      if (quote === "`" && chars[i] === "$" && chars[i + 1] === "{") {
        // `${` delimiters are not code; the interior is.
        maskRange(i, i + 2);
        i += 2;
        let depth = 1;
        while (i < chars.length && depth > 0) {
          if (chars[i] === "'" || chars[i] === '"' || chars[i] === "`") {
            skipString(chars[i]);
            continue;
          }
          if (chars[i] === "/" && chars[i + 1] === "/") {
            comments.push(line.slice(i + 2));
            maskRange(i, chars.length);
            i = chars.length;
            depth = 0;
            break;
          }
          if (chars[i] === "/" && chars[i + 1] === "*") {
            const bodyStart = i + 2;
            let j = bodyStart;
            while (j + 1 < chars.length && !(chars[j] === "*" && chars[j + 1] === "/")) j++;
            const end = j + 1 < chars.length ? j + 2 : chars.length;
            comments.push(line.slice(bodyStart, j));
            maskRange(i, end);
            i = end;
            continue;
          }
          if (chars[i] === "{") depth++;
          else if (chars[i] === "}") {
            depth--;
            if (depth === 0) {
              maskRange(i, i + 1); // closing `}` of `${…}`
              i++;
              break;
            }
          }
          i++; // code inside ${…} stays "code"
        }
        continue;
      }
      if (chars[i] === quote) {
        maskRange(i, i + 1);
        i++;
        break;
      }
      maskRange(i, i + 1); // string body
      i++;
    }
  }

  while (i < chars.length) {
    if (chars[i] === "/" && chars[i + 1] === "/") {
      comments.push(line.slice(i + 2));
      maskRange(i, chars.length);
      break;
    }
    if (chars[i] === "/" && chars[i + 1] === "*") {
      const bodyStart = i + 2;
      let j = bodyStart;
      while (j + 1 < chars.length && !(chars[j] === "*" && chars[j + 1] === "/")) j++;
      const end = j + 1 < chars.length ? j + 2 : chars.length;
      comments.push(line.slice(bodyStart, j));
      maskRange(i, end);
      i = end;
      continue;
    }
    if (chars[i] === "'" || chars[i] === '"' || chars[i] === "`") {
      skipString(chars[i]);
      continue;
    }
    i++;
  }

  let code = "";
  for (let k = 0; k < chars.length; k++) {
    code += kind[k] === "mask" ? " " : chars[k];
  }
  return { code, comments };
}

/**
 * @param {string} additionLine content after the leading '+'
 * @returns {string | null} rule id, or null if clean / allowlisted
 */
export function classifyAddition(additionLine) {
  if (ALLOW_RE.test(additionLine)) return null;

  const { code, comments } = partitionAdditionLine(additionLine);

  for (const body of comments) {
    // `// DEBUG …` / `/* DEBUG …` — DEBUG is the first token of the comment.
    if (/^\s*DEBUG\b/i.test(body)) return "// DEBUG";
    if (/\bTODO\s+remove\b/i.test(body)) return "TODO remove";
  }

  if (/\bdebugger\b/.test(code)) return "debugger";

  // `window.__foo` and the TS cast form `(window as …).__foo` on one line.
  if (/\bwindow\b.{0,120}\.__[A-Za-z_$]/.test(code)) return "window.__*";

  if (/\bconsole\.(log|debug)\s*\(/.test(code)) return "console.log/debug";

  return null;
}

/**
 * Parse a unified diff (typically `git diff --cached -U0` / `git show -U0`)
 * and return findings for addition lines in scanned paths.
 *
 * @param {string} diffText
 * @returns {Finding[]}
 */
export function scanStagedDiff(diffText) {
  /** @type {Finding[]} */
  const findings = [];
  let path = "";
  let hunk = "";

  for (const raw of diffText.split(/\n/)) {
    if (raw.startsWith("diff --git ")) {
      path = "";
      hunk = "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const rest = raw.slice(4).trim();
      // `+++ b/path` or `+++ /dev/null`
      if (rest === "/dev/null") {
        path = "";
      } else {
        path = rest.replace(/^b\//, "");
      }
      continue;
    }
    if (raw.startsWith("@@ ")) {
      hunk = raw.trim();
      continue;
    }
    if (!path || !isScannedPath(path)) continue;
    // Addition line (not file header `+++`).
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const content = raw.slice(1);
    const rule = classifyAddition(content);
    if (!rule) continue;
    findings.push({ path, hunk: hunk || "(no hunk)", line: content, rule });
  }

  return findings;
}

/**
 * @param {Finding[]} findings
 * @returns {string}
 */
export function formatFindings(findings) {
  if (findings.length === 0) return "preflight:staged: clean\n";
  const lines = findings.map((f) => {
    const trimmed = f.line.length > 120 ? `${f.line.slice(0, 117)}...` : f.line;
    return `${f.path} ${f.hunk}\n  [${f.rule}] +${trimmed}`;
  });
  return `preflight:staged: ${findings.length} finding(s)\n${lines.join("\n")}\n`;
}

/**
 * @param {{ cwd?: string, diffText?: string }} [opts]
 * @returns {{ findings: Finding[], output: string, exitCode: number }}
 */
export function runPreflightStaged(opts = {}) {
  const diffText =
    opts.diffText ??
    execFileSync("git", ["diff", "--cached", "-U0", "--no-ext-diff"], {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  const findings = scanStagedDiff(diffText);
  return {
    findings,
    output: formatFindings(findings),
    exitCode: findings.length === 0 ? 0 : 1,
  };
}

function main() {
  try {
    const result = runPreflightStaged();
    process.stdout.write(result.output);
    process.exit(result.exitCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`preflight:staged: failed to read staged diff: ${msg}\n`);
    process.exit(2);
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

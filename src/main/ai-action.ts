import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerById, which } from "./providers";

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * A plain promisify(execFile) leaves the child's stdin open (Node always
 * pipes it, never closes it) — codex's `exec` subcommand explicitly reads
 * from stdin when it's piped ("stdin is appended as a <stdin> block") and
 * blocks waiting for EOF that never arrives, hanging until TIMEOUT_MS kills
 * it with no output at all. Closing stdin right after spawn is the fix;
 * applied unconditionally since it can't hurt claude/cursor-agent either.
 */
function execFileNoStdin(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...options, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

export type OneShotResult = { text: string } | { error: string };

/**
 * claude/cursor-agent's `-p --output-format json` prints a JSON object with
 * the final text under some field (commonly "result"); gemini's own
 * `-p --output-format json` (verified against docs/cli/headless.md, not
 * installed on this machine to test live) uses "response" instead —
 * checks both, falls back to the raw stdout if neither shape holds, so a
 * vendor format change degrades to plain text instead of breaking.
 */
function extractJsonResult(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.response === "string") return parsed.response;
  } catch {
    // Not JSON, or not the expected shape — use the raw text below.
  }
  return stdout.trim();
}

/**
 * One-shot, non-interactive spawn — no node-pty, no board card, no
 * persistence. Separate from pty-registry.ts on purpose: that module's
 * whole design (coalescing, resize, kill) is for a long-lived interactive
 * PTY, which this deliberately isn't.
 */
export async function runOneShotSummary(providerId: string, cwd: string, prompt: string): Promise<OneShotResult> {
  const provider = providerById(providerId);
  if (!provider || provider.id === "bash") return { error: "provider inválido para ação de IA" };
  const binary = which(provider.binaryNames);
  if (!binary) return { error: `"${providerId}" não encontrado no PATH` };

  try {
    if (provider.id === "codex") {
      // codex exec -o writes ONLY the agent's final message to that file —
      // simplest reliable path, no JSONL event parsing needed.
      const dir = await mkdtemp(join(tmpdir(), "agent-canvas-ai-"));
      const outFile = join(dir, "result.txt");
      try {
        await execFileNoStdin(binary, ["exec", prompt, "-o", outFile], { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
        const text = await readFile(outFile, "utf8");
        return { text: text.trim() };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // claude, cursor-agent, and gemini all share the same -p/--output-format
    // flags (verified against docs for gemini — see extractJsonResult).
    const { stdout } = await execFileNoStdin(binary, ["-p", prompt, "--output-format", "json"], {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { text: extractJsonResult(stdout) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

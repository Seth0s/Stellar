import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "../shared/i18n";
import { providerById, which, type OneShotCapability } from "./providers";
import { effectivePath } from "./user-env";

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
    // PATH efetivo explícito (2026-09-08): estas CLIs são scripts com
    // shebang `#!/usr/bin/env node`, então achar o binário não basta —
    // sem `node` alcançável o SO falha com "env: node: No such file or
    // directory". Ver user-env.ts.
    const env = { ...process.env, PATH: effectivePath() };
    const child = execFile(file, args, { ...options, env, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

export type OneShotResult = { text: string } | { error: string };

/**
 * claude/cursor-agent's `-p --output-format json` prints a JSON object with
 * the final text under some field (commonly "result"); `antigravity`/`agy`
 * uses "response" instead (confirmed live, 2026-08-31: `agy -p "..."
 * --output-format json` → `{"response": "...", ...}`) — checks both, falls
 * back to the raw stdout if neither shape holds, so a future vendor format
 * change degrades to plain text instead of breaking.
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
 * O argv do one-shot, MONTADO da declaração — nunca de uma tabela por `id`
 * (task efc5b6fd). `null` = este provider não declara a ação, e quem chamou
 * não deveria ter oferecido: a UI lê o MESMO fato (`projectOneShot`) antes de
 * mostrar o botão.
 *
 * Os dois placeholders são os que a declaração pode usar: `{prompt}` (o
 * pedido do usuário, obrigatório) e `{outFile}` (o arquivo onde CLIs como o
 * codex escrevem o texto final).
 */
export function buildOneShotArgv(
  spec: { capacity: { oneShot?: OneShotCapability } },
  prompt: string,
  outFile: string,
): string[] | null {
  const oneShot = spec.capacity.oneShot;
  if (oneShot === undefined || oneShot.mechanism !== "argv") return null;
  return oneShot.args.map((arg) => arg.replaceAll("{prompt}", prompt).replaceAll("{outFile}", outFile));
}

/**
 * One-shot, non-interactive spawn — no node-pty, no board card, no
 * persistence. Separate from pty-registry.ts on purpose: that module's
 * whole design (coalescing, resize, kill) is for a long-lived interactive
 * PTY, which this deliberately isn't.
 *
 * A EXECUÇÃO agora é genérica (task efc5b6fd): o argv e o modo de leitura da
 * saída vêm de `capacity.oneShot`, e a ausência da declaração é RECUSA — não
 * existe mais o "cai no caminho do claude e manda `-p --output-format`", que
 * era o que fazia cline e commandcode falharem depois de o botão já ter sido
 * oferecido.
 */
export async function runOneShotSummary(providerId: string, cwd: string, prompt: string): Promise<OneShotResult> {
  const provider = providerById(providerId);
  if (!provider || provider.id === "bash") return { error: t("error.invalidAiProvider") };
  const oneShot = provider.capacity.oneShot;
  if (oneShot === undefined || oneShot.mechanism !== "argv") {
    return { error: t("error.oneShotUnsupported", { provider: providerId }) };
  }
  const binary = which(provider.binaryNames);
  if (!binary) return { error: t("error.providerNotInPath", { provider: providerId }) };

  // O diretório temporário só existe quando a declaração diz que o texto final
  // vem de arquivo (`result: "out-file"`) — o caso do codex.
  const needsOutFile = oneShot.result === "out-file";
  const dir = needsOutFile ? await mkdtemp(join(tmpdir(), "agent-canvas-ai-")) : null;
  const outFile = dir === null ? "" : join(dir, "result.txt");

  try {
    const args = buildOneShotArgv(provider, prompt, outFile) ?? [];
    const { stdout } = await execFileNoStdin(binary, args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (oneShot.result === "out-file") return { text: (await readFile(outFile, "utf8")).trim() };
    if (oneShot.result === "stdout-json") return { text: extractJsonResult(stdout) };
    return { text: stdout.trim() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
  }
}

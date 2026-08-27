import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

/**
 * DESIGN-BACKLOG.md item 12, Fase D — real OS-level confinement for the
 * chat's `bash` tool, via `bubblewrap` (`bwrap`). This was the explicit,
 * user-confirmed blocker before bash could exist as a chat tool at all
 * (see item 21 ponto 9 achado 6): a per-action consent gate alone doesn't
 * stop an ALLOWED command from doing something the human didn't picture —
 * `rm -rf /`, reading `~/.ssh`, etc. Scope, also user-confirmed:
 * filesystem-write + process/namespace isolation, NOT network egress
 * control (network stays shared — `npm install`/`curl`/`git` need it, and
 * the human is already consenting per-command, same trust level as
 * `write_file`).
 *
 * Flag choices, verified live with a real `bwrap` invocation (not just
 * read from `--help`) before wiring this into the app:
 * - `--ro-bind / /` then `--bind <root> <root>`: the whole host filesystem
 *   is visible (a sandboxed command still needs to read system libs, the
 *   project's node_modules, etc. — same visibility a human's own shell
 *   has), but writable ONLY inside the chat's own project root. Confirmed:
 *   a write inside root succeeds, a write to /etc fails with "Sistema de
 *   arquivos somente para leitura".
 * - `--tmpfs /tmp`: scratch space, thrown away when the sandbox exits.
 * - `--unshare-pid/-ipc/-uts/-cgroup-try`: process isolation — confirmed
 *   live, `ps aux` inside the sandbox shows only bwrap itself + the
 *   command, none of the host's real processes.
 * - No `--unshare-net` (deliberate): confirmed live, `curl` inside the
 *   sandbox reached a real external host.
 * - `--die-with-parent`: a killed/crashed main process can't leave an
 *   orphaned sandboxed command running.
 */

const BWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap"];
const BASH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

export function isSandboxAvailable(): boolean {
  return BWRAP_PATHS.some((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export type SandboxResult = { ok: boolean; text: string };

/** Runs `command` under bwrap, confined to write inside `root`. Never
 * throws — a spawn failure (bwrap missing/misbehaving) resolves to
 * `ok:false` like any other tool error, same as the rest of chat-tools.ts. */
export function runSandboxedBash(root: string, command: string): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const args = [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      root,
      root,
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--die-with-parent",
      "--new-session",
      "--chdir",
      root,
      "--",
      "bash",
      "-lc",
      command,
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("bwrap", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, text: `falha iniciando o sandbox: ${String(err)}` });
      return;
    }

    let out = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BASH_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, text: `erro executando o sandbox: ${String(err)}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const truncated = out.length > MAX_OUTPUT_CHARS;
      const body = truncated ? out.slice(0, MAX_OUTPUT_CHARS) + "\n…[truncado]" : out;
      const tail = timedOut ? `\n[comando interrompido — limite de ${BASH_TIMEOUT_MS / 1000}s]` : `\n[exit code: ${code}]`;
      resolve({ ok: !timedOut && code === 0, text: body + tail });
    });
  });
}

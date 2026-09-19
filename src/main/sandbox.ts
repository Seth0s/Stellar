import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";

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

/**
 * Pre-release audit S6 — this used to answer a plain `true`/`false` after
 * probing `BWRAP_PATHS` by absolute path, while `runSandboxedBash` below
 * spawned a bare `"bwrap"` and let the OS resolve it through `PATH`. Two
 * different lookups answering one question: the binary this function
 * proved is executable was not necessarily the binary that would actually
 * run, and anything earlier in `PATH` (a shim, a wrapper, a stale
 * user-local build) would silently take over the confinement that is the
 * ONLY thing standing between the chat's `bash` tool and the real
 * filesystem. Returning the path that was actually probed — and spawning
 * exactly that — collapses the two lookups into one.
 */
export function findSandboxBinary(): string | null {
  for (const p of BWRAP_PATHS) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here — try the next one
    }
  }
  return null;
}

/** Kept as the boolean-shaped question chat-tools.ts asks before offering
 * the tool at all; `findSandboxBinary` is the same probe when the caller
 * needs the path itself. */
export function isSandboxAvailable(): boolean {
  return findSandboxBinary() !== null;
}

export type SandboxResult = { ok: boolean; text: string };

/**
 * The EXACT bwrap argv (everything after the `bwrap` binary) that confines
 * `command` to write inside `root`. Extracted so any caller that needs a
 * confinement identical to the chat `bash` tool — today `gate-runner.ts`,
 * which must keep stdout/stderr separated and its own timeout — can spawn
 * `bwrap` itself with this argv instead of forking a second, drifting copy
 * of these flags. Pure: same input, same array, no I/O.
 */
export function buildSandboxedBashArgs(root: string, command: string): string[] {
  const home = homedir();
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    // Pre-release audit S5 — `--ro-bind / /` above makes the WHOLE host
    // filesystem readable inside the sandbox, `$HOME` included: `~/.ssh`,
    // `secrets.json` (this app's own API keys), any other dotfile. The
    // `--bind root root` below only ever intended to grant WRITE access
    // to the project root, never READ access to the rest of `$HOME` —
    // that was collateral, not a decision. `--tmpfs $HOME` occludes it
    // with empty scratch space before the root bind below re-mounts the
    // real project directory back (writable) when `root` lives under
    // `$HOME`, which is the common case for this app's projects.
    "--tmpfs",
    home,
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
}

/** Runs `command` under bwrap, confined to write inside `root`. Never
 * throws — a spawn failure (bwrap missing/misbehaving) resolves to
 * `ok:false` like any other tool error, same as the rest of chat-tools.ts. */
export function runSandboxedBash(root: string, command: string): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const args = buildSandboxedBashArgs(root, command);

    // Audit S6 — the absolute path that was actually probed as executable,
    // never a bare name resolved through PATH. Re-probed per call rather
    // than cached: bwrap can be uninstalled while the app is running, and
    // this is one `access()` against a 60s-budget subprocess.
    const bwrap = findSandboxBinary();
    if (!bwrap) {
      resolve({ ok: false, text: "sandbox indisponível (bubblewrap não encontrado neste sistema)" });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bwrap, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, text: `falha iniciando o sandbox: ${String(err)}` });
      return;
    }

    let out = "";
    // Pre-release audit B4 — this used to append every chunk unbounded
    // and only slice at `close`, so a command printing tens of MB made
    // main's own heap grow proportionally for the entire 60s budget
    // before the truncation even applied. Capping `out` as data arrives
    // (and ignoring every chunk after) bounds main's memory to
    // `MAX_OUTPUT_CHARS` regardless of how much the sandboxed command
    // actually produces.
    let truncated = false;
    function appendChunk(d: Buffer) {
      if (truncated) return;
      out += d.toString();
      if (out.length > MAX_OUTPUT_CHARS) {
        out = out.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      }
    }
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BASH_TIMEOUT_MS);

    child.stdout?.on("data", appendChunk);
    child.stderr?.on("data", appendChunk);
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
      const body = truncated ? out + "\n…[truncado]" : out;
      const tail = timedOut ? `\n[comando interrompido — limite de ${BASH_TIMEOUT_MS / 1000}s]` : `\n[exit code: ${code}]`;
      resolve({ ok: !timedOut && code === 0, text: body + tail });
    });
  });
}

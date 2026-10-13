// Switching the machine profile relaunches the app: after `profiles:switch` the
// old process must exit and a new one must come up on the other profile — the
// window the person was looking at may close for a moment, but the app must
// not stay closed. Isolated instance (own user data, own ports).
// STELLAR_BIN=/path/to/packaged/stellar runs the PACKAGED binary instead of the
// dev Electron (the relaunch is different there: no script argument, the real
// execPath, the installed single-instance lock).
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { assertAppDocument, bootIntoFreshSession, connectPage, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = mkdtempSync(join(tmpdir(), "stellar-profile-switch-"));
const cdpPort = await pickFreePort();
async function launchPackaged(bin) {
  const proc = spawn("prlimit", ["--core=0", "--", bin, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, AGENT_CANVAS_REMOTE_PORT: String(cdpPort + 30000), AGENT_CANVAS_MCP_PORT: String(cdpPort + 40000) },
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${cdpPort}/json`)).ok) return { proc, cdpPort, userDataDir: userData, preserveUserData: true, stderr: () => stderr };
    } catch {
      /* not up yet */
    }
    await delay(250);
  }
  proc.kill("SIGKILL");
  throw new Error(`packaged app did not come up:\n${stderr}`);
}
const app = process.env.STELLAR_BIN ? await launchPackaged(process.env.STELLAR_BIN) : await startApp({ cdpPort, userDataDir: userData });

function processesOf(dir) {
  try {
    return execFileSync("pgrep", ["-af", dir], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.trim() && !l.includes("pgrep"));
  } catch {
    return [];
  }
}

/** Children of the app's processes that are not the app itself: the PTY shells and agents. */
function ptyChildrenOf(dir) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  const appPids = new Set(rows.filter((r) => r.args.includes(dir)).map((r) => r.pid));
  return rows
    .filter((r) => appPids.has(r.ppid) && !r.args.includes(dir) && /(^|\/|-)(bash|zsh|sh|fish)(\s|$)/.test(r.args))
    .map((r) => r.pid);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    return res.ok;
  } catch {
    return false;
  }
}

try {
  // A live session, as the person has it: a board with a running terminal, so
  // quitting has real work to do (this is what makes the relaunch race visible).
  const page = await connectPage(cdpPort);
  await bootIntoFreshSession(page);
  await delay(800);
  const before = JSON.parse(await page.evalJs(`window.profiles.list().then((s) => JSON.stringify(s))`));
  const created = JSON.parse(
    await page.evalJs(`window.profiles.create({ name: "Empresa", kind: "team", homeMode: "isolated" }).then((r) => JSON.stringify(r))`),
  );
  check("a second profile is created", created.ok, true);
  const target = created.state.profiles.find((p) => p.name === "Empresa");
  const startPids = processesOf(userData).length;
  const shells = ptyChildrenOf(userData);
  console.log("PTY shells before the switch:", shells.length);
  check("a live shell exists to leave behind", shells.length > 0, true);
  console.log("processes before:", startPids, "active before:", before.profiles.find((p) => p.isActive)?.name);

  // Fire and forget: the page dies with the process, so the call never answers.
  await page.evalJs(`setTimeout(() => window.profiles.switch(${JSON.stringify(target.id)}), 0); 1`);

  // The old process goes away; a new one must appear on the same port.
  const t0 = Date.now();
  let downAt = 0;
  let upAt = 0;
  let sawDown = false;
  let backUp = false;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const up = await portUp();
    if (!up && !sawDown) {
      sawDown = true;
      downAt = Date.now() - t0;
    }
    if (sawDown && up) {
      upAt = Date.now() - t0;
      backUp = true;
      break;
    }
    await delay(250);
  }
  const procs = processesOf(userData);
  console.log(`window gone after ${downAt} ms, back after ${upAt} ms (gap ${upAt - downAt} ms)`);
  console.log("went down:", sawDown, "back up:", backUp, "processes now:", procs.length);
  for (const l of procs.slice(0, 4)) console.log("  ", l.slice(0, 200));
  check("the app comes back after the switch (not just closed)", backUp, true);
  // Leaving the profile must close what it was running, like closing the app does:
  // no shell or agent of the old profile survives as an orphan.
  await delay(500);
  const orphans = shells.filter((pid) => alive(pid));
  check("the old profile's shells and agents are gone (nothing orphaned)", orphans.length, 0);
  if (backUp) {
    const p2 = await connectPage(cdpPort);
    const after = JSON.parse(await p2.evalJs(`window.profiles.list().then((s) => JSON.stringify(s))`));
    check("it opened on the chosen profile", after.profiles.find((p) => p.isActive)?.name, "Empresa");
    // The trace says how far the new process got: switching → booted → window.
    const tracePath = join(userData, "relaunch-trace.log");
    const steps = existsSync(tracePath)
      ? readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l).step)
      : [];
    check("the switch leaves a trace: switching, then booted, then window", steps, (v) => v.join(",") === "switching,booted,window");
    p2.close();
  }
} finally {
  await stopApp(app);
  // The relaunched instance is not our child: end it too.
  try {
    execFileSync("pkill", ["-f", userData]);
  } catch {
    /* none left */
  }
  // The relaunched instance may still be writing for a moment: let it die before the folder goes.
  await delay(600);
  rmSync(userData, { recursive: true, force: true });
}
finish();

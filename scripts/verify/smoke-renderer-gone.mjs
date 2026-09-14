// Live proof: renderer death is recorded + reacted to (reload), and the
// retry ceiling stops a death loop with a clean quit. Isolated Electron
// only — never the owner's live app.
//
// Kill path (measured 2026-09-14):
// - forcefullyCrashRenderer via IPC: "Crashing because hung" + browser
//   SIGTRAP under Wayland — app died before reload.
// - SIGKILL of `--type=renderer`: logged correctly but aborted the browser
//   process (SIGTRAP).
// - CDP `Page.crash` + `--ozone-platform=x11 --disable-gpu`: renderer
//   dies (reason=crashed), main survives, deferred reload brings the page
//   back. That is the path this smoke uses.
//
// startApp wraps with `prlimit --core=0` (cdp-client.mjs) so deaths do not
// fill the disk with Electron coredumps (PSI full avg60≈32% measured when
// dumps were allowed). One death at a time — 2s pause between kills.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-renderer-gone-${CDP_PORT}`, import.meta.url).pathname;

const { check, finish } = makeChecker();
process.env.VERIFY_KEEP_USERDATA = "1";
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  timeoutMs: 30_000,
  extraArgs: ["--ozone-platform=x11", "--disable-gpu"],
});

function coreLimitSoft(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/limits`, "utf8");
    return text.split("\n").find((l) => l.startsWith("Max core file size")) ?? "(missing)";
  } catch (err) {
    return `unreadable: ${err}`;
  }
}

function findElectronMainPid(userDataDir) {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (
        cmdline.includes(userDataDir) &&
        cmdline.includes("out/main/index.js") &&
        !cmdline.includes("--type=")
      ) {
        return Number(name);
      }
    } catch {
      /* raced */
    }
  }
  return null;
}

async function waitForLogLines(logPath, minLines, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, "utf8").trim();
      const lines = text ? text.split("\n") : [];
      if (lines.length >= minLines) return lines.map((l) => JSON.parse(l));
    }
    await delay(100);
  }
  throw new Error(`renderer-gone.log did not reach ${minLines} lines within ${timeoutMs}ms at ${logPath}`);
}

async function waitForPageBack(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.proc.exitCode !== null || app.proc.signalCode !== null) {
      return { quit: true };
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const target =
        list.find((t) => t.type === "page" && String(t.url).endsWith("renderer/index.html")) ??
        list.find((t) => t.type === "page");
      if (target?.webSocketDebuggerUrl) {
        await delay(500);
        const page = await connectPage(CDP_PORT);
        const ready = await page.evalJs(`document.readyState`);
        const hasBridge = await page.evalJs(`typeof window.debugBridge?.rendererGoneLogPath`);
        page.close();
        if ((ready === "complete" || ready === "interactive") && hasBridge === "function") {
          return { quit: false };
        }
      }
    } catch {
      /* still coming up */
    }
    await delay(200);
  }
  throw new Error("page did not come back after renderer death");
}

async function crashPageOnce() {
  const page = await connectPage(CDP_PORT);
  page.send("Page.crash").catch(() => {});
  await delay(50);
  try {
    page.close();
  } catch {
    /* ws already dead */
  }
}

try {
  let page = await connectPage(CDP_PORT);
  await delay(800);
  await bootIntoFreshSession(page, "Renderer Gone", { spawnTerminal: false });

  const logPath = await page.evalJs(`(async () => await window.debugBridge.rendererGoneLogPath())()`);
  check("debugBridge exposes renderer-gone log path", typeof logPath === "string" && logPath.length > 0, true);
  console.log("logPath:", logPath);

  const electronMainPid = findElectronMainPid(USER_DATA_DIR);
  check("found electron main under userDataDir", electronMainPid !== null, true);
  const mainCore = coreLimitSoft(electronMainPid);
  console.log("electron main core limit:", mainCore);
  check("RLIMIT_CORE soft is 0 on electron main", /\s0\s+0\s/.test(mainCore), true);
  try {
    page.close();
  } catch {
    /* */
  }

  console.log("--- death 1 ---");
  await crashPageOnce();
  let back = await waitForPageBack();
  check("death-1 did not quit the app", back.quit, false);
  const lines1 = await waitForLogLines(logPath, 1);
  check("log exists after first death", existsSync(logPath), true);
  check("first log reason is crashed (or killed)", ["crashed", "killed"].includes(lines1[0].reason), true);
  check("first action is reload", lines1[0].action, "reload");
  console.log("line1:", JSON.stringify(lines1[0]));
  await delay(2000);

  console.log("--- death 2 ---");
  await crashPageOnce();
  back = await waitForPageBack();
  check("death-2 did not quit the app", back.quit, false);
  const lines2 = await waitForLogLines(logPath, 2);
  check("second action is reload", lines2[1].action, "reload");
  console.log("line2:", JSON.stringify(lines2[1]));
  await delay(2000);

  console.log("--- death 3 (expect quit) ---");
  await crashPageOnce();
  const lines3 = await waitForLogLines(logPath, 3);
  check("third action is quit", lines3[2].action, "quit");
  check("third why is retry-limit", lines3[2].why, "retry-limit");
  console.log("line3:", JSON.stringify(lines3[2]));

  const quitDeadline = Date.now() + 15_000;
  while (app.proc.exitCode === null && app.proc.signalCode === null && Date.now() < quitDeadline) {
    await delay(100);
  }
  const exited = app.proc.exitCode !== null || app.proc.signalCode !== null;
  check("app process exited after retry-limit", exited, true);

  const disposedHits = (app.stderr().match(/Render frame was disposed/gi) ?? []).length;
  check("stderr has fewer than 10 frame-disposed lines (was hundreds)", disposedHits < 10, true);
  check("stderr mentions [renderer-gone]", /\[renderer-gone\]/.test(app.stderr()), true);

  console.log("renderer-gone.log:");
  for (const line of lines3) console.log(" ", JSON.stringify(line));
} finally {
  if (app.proc.exitCode === null && app.proc.signalCode === null) {
    await stopApp(app);
  }
}

finish();

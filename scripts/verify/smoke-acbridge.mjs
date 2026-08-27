// DESIGN-BACKLOG.md item 21, ponto 9 — acbridge stays as the CLI fallback
// for providers that don't speak MCP (message-bus.ts's `handleRequest` is
// the SAME dispatcher smoke-mcp.mjs already exercises thoroughly — this
// test is deliberately thinner, just confirming the CLI WRAPPER itself
// (resources/bin/acbridge: argv parsing, env vars, socket framing, exit
// codes) correctly round-trips real child processes, not re-testing the
// consent/spawn logic underneath).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const execFileAsync = promisify(execFile);
const CDP_PORT = 9431;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-acbridge", import.meta.url).pathname;
const ACBRIDGE_BIN = new URL("../../resources/bin/acbridge", import.meta.url).pathname;

async function runAcbridge(sockPath, cardId, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [ACBRIDGE_BIN, ...args], {
      env: { ...process.env, AGENT_CANVAS_SOCK: sockPath, AGENT_CANVAS_CARD_ID: cardId },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return { ok: false, stderr: (err.stderr ?? "").trim(), code: err.code };
  }
}

async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "acbridge Teste");
  await new Promise((r) => setTimeout(r, 500));

  const sockPath = `${USER_DATA_DIR}/agent-canvas.sock`;

  const listResult = await runAcbridge(sockPath, "0", ["list"]);
  check("acbridge list succeeds as a real child process", listResult.ok, true);
  const bashLine = listResult.stdout.split("\n").find((l) => l.includes("bash"));
  check("acbridge list shows the seeded bash card (id\\tprovider\\tcwd)", !!bashLine, true);
  const bashCardId = bashLine?.split("\t")[0];

  const sendResult = await runAcbridge(sockPath, "0", ["send", bashCardId, "echo", "acbridge-smoke"]);
  check("acbridge send succeeds against a real card", sendResult.ok, true);

  const badResult = await runAcbridge(sockPath, "0", ["snapshot", "does-not-exist"]);
  check("acbridge exits non-zero on a real backend error", badResult.ok, false);
  check("...and prints the actual error to stderr, not a crash trace", badResult.stderr.includes("acbridge:"), true);

  // spawn-agent — the CLI wrapper's own consent round-trip: the child
  // process blocks on the socket, a real AgentAskModal appears, allow it
  // via CDP, confirm the CLI process then exits 0 with the new cardId.
  const spawnPromise = runAcbridge(sockPath, bashCardId, ["spawn-agent", "bash"]);
  await new Promise((r) => setTimeout(r, 500));
  check("acbridge spawn-agent shows the real consent modal", await page.evalJs(`document.querySelector('.modal h3')?.textContent`), "Permissão: spawnar agente");
  await clickModalButton(page, "Permitir");
  const spawnResult = await spawnPromise;
  check("acbridge spawn-agent succeeds after Permitir and prints the new cardId", spawnResult.ok && spawnResult.stdout.length > 0, true);
  await new Promise((r) => setTimeout(r, 500));
  check("a second real terminal card exists after acbridge spawn-agent", await page.evalJs(`document.querySelectorAll('.terminal-card').length`), 2);

  // page-text — needs a real browser card first (spawn-card, allowed).
  const spawnCardPromise = runAcbridge(sockPath, bashCardId, ["spawn-card", "browser", "https://example.com"]);
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnCardResult = await spawnCardPromise;
  check("acbridge spawn-card browser succeeds and prints the new cardId", spawnCardResult.ok && spawnCardResult.stdout.length > 0, true);
  await new Promise((r) => setTimeout(r, 2000));

  const pageTextResult = await runAcbridge(sockPath, bashCardId, ["page-text", spawnCardResult.stdout]);
  check("acbridge page-text returns the real navigated page's text", pageTextResult.ok && pageTextResult.stdout.includes("Example Domain"), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();

// DESIGN-BACKLOG.md §0 — capacity contract: providers without a
// system-prompt flag must get AGENT_SCROLLBACK_DISCOVERY_TIP at spawn
// (derived, not ad hoc), so a cursor card learns `acbridge report`
// without anyone teaching it in the briefing.
//
// Measured 2026-09-12: headless `agent` DOES read ~/.cursor/mcp.json, but
// MCP alone was not enough (live cards still said "sem tools Stellar").
// This smoke proves the derived scrollback path lands in the real PTY
// stream — the same channel the agent reads.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";

// Prefix of AGENT_SCROLLBACK_DISCOVERY_TIP (bash-discovery-decision.ts).
// Reworded 2026-09-13 into the single rule (catalog has `report` → tool,
// else `acbridge report` with `verdict`); the prefix is what identifies it.
const TIP =
  "[stellar] This provider has no system-prompt injection. When you finish a task";
const BASH_TIP = "[stellar] Bash card: `acbridge` is on PATH";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(
  `../../.verify-tmp/smoke-provider-capacity-discovery-${CDP_PORT}`,
  import.meta.url,
).pathname;
const FAKE_HOME = new URL(
  `../../.verify-tmp/smoke-provider-capacity-discovery-home-${CDP_PORT}`,
  import.meta.url,
).pathname;

function which(names) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_REGISTRATION_HOME: FAKE_HOME },
});

try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 800));
  await bootIntoFreshSession(page, "Capacity discovery");
  await new Promise((r) => setTimeout(r, 500));

  await page.evalJs(`window.__capChunks = Object.create(null);
    window.pty.onData((id, data) => {
      window.__capChunks[id] = (window.__capChunks[id] || "") + data;
    });`);

  // --- cursor: must get agent scrollback tip (no system-prompt flag) ---
  const cursorBin = which(["agent", "cursor-agent"]);
  check("binário agent/cursor-agent existe (senão o spawn falha antes do tip)", !!cursorBin, true);

  const cursorSpawn = JSON.parse(
    await page.evalJs(
      `window.pty.spawn("cap-cursor", "cursor", ${JSON.stringify(process.cwd())}, 80, 24).then(r => JSON.stringify(r))`,
    ),
  );
  check("spawn cursor ok", "id" in cursorSpawn, true);
  await new Promise((r) => setTimeout(r, 1500));

  const cursorChunks = await page.evalJs(`window.__capChunks["cap-cursor"] || ""`);
  check("cursor scrollback contains capacity-derived tip", cursorChunks.includes(TIP), true);
  check("cursor tip teaches acbridge report", cursorChunks.includes("acbridge report"), true);
  check("cursor tip has no http URL (pty URL sighting)", !/https?:\/\//.test(cursorChunks.match(/\[stellar\][^\r\n]*/)?.[0] ?? ""), true);

  // --- claude: system-prompt path — must NOT duplicate tip in scrollback ---
  const claudeBin = which(["claude"]);
  if (claudeBin) {
    const claudeSpawn = JSON.parse(
      await page.evalJs(
        `window.pty.spawn("cap-claude", "claude", ${JSON.stringify(process.cwd())}, 80, 24).then(r => JSON.stringify(r))`,
      ),
    );
    check("spawn claude ok", "id" in claudeSpawn, true);
    await new Promise((r) => setTimeout(r, 1200));
    const claudeChunks = await page.evalJs(`window.__capChunks["cap-claude"] || ""`);
    check("claude does NOT get scrollback tip (system_prompt delivery)", !claudeChunks.includes(TIP), true);
  } else {
    check("claude ausente — skip da asserção de ausência de tip", true, true);
  }

  // --- bash: nested-agent human tip, not the agent report tip ---
  const bashSpawn = JSON.parse(
    await page.evalJs(
      `window.pty.spawn("cap-bash", "bash", ${JSON.stringify(process.cwd())}, 80, 24).then(r => JSON.stringify(r))`,
    ),
  );
  check("spawn bash ok", "id" in bashSpawn, true);
  await new Promise((r) => setTimeout(r, 800));
  const bashChunks = await page.evalJs(`window.__capChunks["cap-bash"] || ""`);
  check("bash gets nested-agent tip", bashChunks.includes(BASH_TIP), true);
  check("bash does NOT get agent report tip", !bashChunks.includes("This provider has no system-prompt"), true);
} finally {
  await stopApp(app);
}

finish();

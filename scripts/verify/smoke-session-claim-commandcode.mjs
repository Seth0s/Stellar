// Isolated smoke: three `commandcode` watchers against a fixture store, no
// Electron and no owner data. Proves the two defects fixed together:
//   1. the project-directory encoding is kebab-case, so a camelCase cwd
//      (`StellarCloud` -> `stellar-cloud`) is found at all;
//   2. three cards spawned in the same instant still each get a DISTINCT id
//      (deterministic pairing), instead of all-null.
// A fourth case checks the no-silence notice (`onStuck`) still fires when the
// counts do not match (more files than cards) — never a guessed id.
import { register } from "node:module";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

register(new URL("./ts-relative-import-loader.mjs", import.meta.url));

const REAL_HOME = process.env.HOME;
const HOME = "/tmp/stellar-cc-claim-smoke-home";
const CWD = "/tmp/Fixture/StellarCloud";
// The directory name is HARDCODED from the measured encoding — never computed
// with the function under test (that would be circular). `StellarCloud` splits
// at its case boundary: `stellar-cloud`.
const CC_DIR = `${HOME}/.commandcode/projects/tmp-fixture-stellar-cloud`;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${ok ? "" : ` (got ${JSON.stringify(actual)})`}`);
  if (!ok) failed += 1;
}

function write(path, content, mtimeMs) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}
function sessionFile(id, mtimeMs, prompt) {
  write(join(CC_DIR, `${id}.meta.json`), JSON.stringify({ traceIds: [], title: id }), mtimeMs);
  write(join(CC_DIR, `${id}.jsonl`), "x".repeat(200), mtimeMs);
  if (prompt !== undefined) {
    write(join(CC_DIR, `${id}.checkpoints.jsonl`), JSON.stringify({ prompt, turnNumber: 1 }), mtimeMs);
  }
}

const BASE = Date.now();
const SPAWN = [BASE, BASE + 5, BASE + 9]; // same instant, ~ms apart

const { watchForSession, spawnWatchReservation } = await import("../../src/main/session-watch.ts");
const { loadDynamicProviders } = await import("../../src/main/providers-dynamic.ts");

function watchOnce(providerId, cwd, ownerId, spawnAtMs, brief) {
  return new Promise((resolve) => {
    let low = false;
    const stop = watchForSession(
      providerId,
      cwd,
      spawnAtMs,
      (id) => {
        stop();
        resolve({ id, low });
      },
      undefined,
      {
        ...(spawnWatchReservation(providerId, ownerId, spawnAtMs, brief) ?? {}),
        onLowConfidence: () => {
          low = true;
        },
      },
    );
    setTimeout(() => {
      stop();
      resolve({ id: null, low });
    }, 8_000);
  });
}

try {
  rmSync(HOME, { recursive: true, force: true });
  process.env.HOME = HOME;
  loadDynamicProviders("/tmp/stellar-cc-claim-smoke-userdata");

  // --- camelCase cwd + three simultaneous spawns, files created OUT of order,
  // different briefs: exact ownership by CONTENT ---
  rmSync(CC_DIR, { recursive: true, force: true });
  const late = SPAWN[2] + 300;
  sessionFile("cc-b", late, "Brief for task B");
  sessionFile("cc-a", late, "Brief for task A");
  sessionFile("cc-c", late, "Brief for task C");

  const found = await Promise.all([
    watchOnce("commandcode", CWD, "card-a", SPAWN[0], "Brief for task A"),
    watchOnce("commandcode", CWD, "card-b", SPAWN[1], "Brief for task B"),
    watchOnce("commandcode", CWD, "card-c", SPAWN[2], "Brief for task C"),
  ]);
  check("os 3 cards commandcode (cwd camelCase) acham sessão", found.every((f) => f.id !== null), true);
  check("...cada um com o SEU id (posse por conteúdo, arquivos fora de ordem)", found.map((f) => f.id), ["cc-a", "cc-b", "cc-c"]);
  check("...e sem confiança baixa (foi conteúdo, não ordem)", found.every((f) => f.low === false), true);

  // --- identical briefs: order pairing, declared LOW confidence ---
  rmSync(CC_DIR, { recursive: true, force: true });
  const late2 = SPAWN[1] + 300;
  sessionFile("cc-1", late2, "Same brief");
  sessionFile("cc-2", late2, "Same brief");
  const same = await Promise.all([
    watchOnce("commandcode", CWD, "card-1", SPAWN[0], "Same brief"),
    watchOnce("commandcode", CWD, "card-2", SPAWN[1], "Same brief"),
  ]);
  check("briefs idênticos: ids DISTINTOS", new Set(same.map((f) => f.id)).size, 2);
  check("...e a confiança baixa é declarada", same.some((f) => f.low), true);

  // --- more files than cards: refuse, and the no-silence notice fires ---
  rmSync(CC_DIR, { recursive: true, force: true });
  const late3 = SPAWN[0] + 300;
  sessionFile("cc-x", late3, "brief x");
  sessionFile("cc-y", late3, "brief y");
  sessionFile("cc-z", late3, "brief z");
  const stuck = [];
  const lone = await new Promise((resolve) => {
    const stop = watchForSession(
      "commandcode",
      CWD,
      SPAWN[0],
      (id) => {
        stop();
        resolve(id);
      },
      undefined,
      { ...(spawnWatchReservation("commandcode", "card-a", SPAWN[0], "brief a") ?? {}), onStuck: (reason) => stuck.push(reason) },
    );
    setTimeout(() => {
      stop();
      resolve(null);
    }, 8_000);
  });
  check("um card contra 3 arquivos: recusa (nunca chute)", lone, null);
  check("...e o aviso de não-silêncio (onStuck) dispara", stuck.length > 0, true);
} finally {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
}

console.log(failed === 0 ? "\nall checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

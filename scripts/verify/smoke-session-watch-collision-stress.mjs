// Achado ao vivo (2026-09-06) — dois cards reais (181 e 201) com o MESMO
// cwd persistiram o mesmo `resume_id` no `agent-canvas.db` ao vivo
// (`SELECT resume_id, count(*) ... GROUP BY resume_id HAVING count(*) > 1`
// confirmou o par). `smoke-session-watch-collision.mjs` já cobre o bug
// original (item 57.5, staggered watchers) mas escalona os starts e mtimes
// o bastante pra NUNCA exercitar a race residual que o próprio comentário
// do código admitia: dois watchers cujo `readdir`/`stat` (I/O real,
// assíncrono) interleavam, ambos computando o mesmo "best" candidato antes
// de QUALQUER um dos dois chamar `claimedSessionIds.add()`.
//
// Este teste reproduz essa race de propósito: N watchers reais
// (`watchForSession`, sem mock) nascem no MESMO tick síncrono, com o MESMO
// `spawnedAtMs`, contra UM ÚNICO arquivo de sessão já existente — a
// condição exata que maximiza a chance de dois `setInterval`s baterem
// perto o bastante um do outro pra interleavar seus próprios I/Os. Sem o
// fix (`runExclusive`, session-watch.ts), rodar isso repetidas vezes
// reproduz consistentemente MAIS DE UM watcher "achando" o mesmo id (uma
// contagem de reivindicações > 1 pro mesmo id) — com o fix, no máximo um
// jamais deveria conseguir, e nenhum outro id nunca é oferecido, então a
// contagem de "achados" nunca deveria passar de 1 no total, rodada após
// rodada.
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { watchForSession } from "../../src/main/session-watch.ts";
import { makeChecker } from "./cdp-client.mjs";

const { check, finish } = makeChecker();

const FAKE_CWD = "/tmp/stellar-session-watch-stress";
const sessionsDir = join(homedir(), ".claude", "projects", "-tmp-stellar-session-watch-stress");

function writeSessionFile(id, mtimeMs) {
  const path = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(path, '{"type":"user","message":"hi"}\n');
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

const WATCHERS_PER_TRIAL = 8;
const TRIALS = 4;
const TIMEOUT_MS = 4000;

let totalClaims = 0;
let anyTrialSawMultipleClaims = false;

for (let trial = 0; trial < TRIALS; trial++) {
  rmSync(sessionsDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });

  const spawnedAtMs = Date.now() - 10;
  // Já existente, mais novo que spawnedAtMs — candidato válido pra
  // QUALQUER watcher deste trial assim que o primeiro poll tick rodar.
  writeSessionFile(`session-${trial}`, spawnedAtMs + 50);

  const stops = [];
  const results = await Promise.all(
    Array.from({ length: WATCHERS_PER_TRIAL }, () => {
      return new Promise((resolve) => {
        const stop = watchForSession("claude", FAKE_CWD, spawnedAtMs, resolve);
        stops.push(stop);
        setTimeout(() => resolve(null), TIMEOUT_MS);
      });
    }),
  );
  for (const stop of stops) stop();

  const claims = results.filter((r) => r !== null);
  totalClaims += claims.length;
  if (claims.length > 1) anyTrialSawMultipleClaims = true;
  check(`trial ${trial}: no mais de 1 watcher de ${WATCHERS_PER_TRIAL} reivindicou o candidato (achados: ${claims.length})`, claims.length <= 1, true);
}

check(`nenhum trial (de ${TRIALS}) viu mais de um watcher reivindicar o mesmo candidato`, anyTrialSawMultipleClaims, false);

rmSync(sessionsDir, { recursive: true, force: true });
finish();

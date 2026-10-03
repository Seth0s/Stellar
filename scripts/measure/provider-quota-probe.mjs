#!/usr/bin/env node
/**
 * SONDA DE COTA % REAL (task 36034ff2).
 *
 * O ÚNICO percentual de cota obtível hoje é o do Command Code, por HTTP: o
 * próprio CLI bate em `GET /alpha/billing/credits` com o `apiKey` de
 * `~/.commandcode/auth.json` (base/path/header extraídos do bundle em
 * 2026-10-03). A resposta traz `windowLimits.fiveHour{used,cap,resetAt}` e
 * `windowLimits.weekly{used,cap,resetAt}` — NUMERADOR E DENOMINADOR, que é o
 * que autoriza uma barra. Esta sonda imprime os percentuais e MEDE o custo.
 *
 * Uso:
 *   node scripts/measure/provider-quota-probe.mjs [--runs 3]
 *
 * Não imprime o apiKey. Não spawna processo nenhum (é uma chamada HTTP).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_CREDITS = "https://api.commandcode.ai/alpha/billing/credits";
const AUTH_PATH = join(homedir(), ".commandcode", "auth.json");

const runsIdx = process.argv.indexOf("--runs");
const RUNS = runsIdx === -1 ? 3 : Math.max(1, Number(process.argv[runsIdx + 1] ?? 3));

function percent(win) {
  const used = Number(win?.used);
  const cap = Number(win?.cap);
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  return Math.round((used / cap) * 1000) / 10;
}

let apiKey = "";
try {
  apiKey = JSON.parse(readFileSync(AUTH_PATH, "utf8"))?.apiKey ?? "";
} catch {
  /* handled below */
}
if (!apiKey) {
  console.error(`probe: sem apiKey em ${AUTH_PATH} — sem credencial não há leitura (declarado, não inventado)`);
  process.exit(2);
}

for (let i = 0; i < RUNS; i += 1) {
  const t0 = performance.now();
  const res = await fetch(URL_CREDITS, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const text = await res.text();
  const ms = performance.now() - t0;

  if (!res.ok) {
    console.log(`run ${i + 1}: http=${res.status} time=${ms.toFixed(0)}ms (sem leitura)`);
    continue;
  }
  const json = JSON.parse(text);
  const w = json.windowLimits ?? {};
  const five = percent(w.fiveHour);
  const week = percent(w.weekly);
  console.log(
    `run ${i + 1}: http=${res.status} time=${ms.toFixed(0)}ms bytes=${text.length} ` +
      `session=${five === null ? "n/d" : five + "%"} (used=${w.fiveHour?.used ?? "?"}/cap=${w.fiveHour?.cap ?? "?"}) ` +
      `week=${week === null ? "n/d" : week + "%"} (used=${w.weekly?.used ?? "?"}/cap=${w.weekly?.cap ?? "?"}) ` +
      `reset5h=${w.fiveHour?.resetAt ?? "?"} reset7d=${w.weekly?.resetAt ?? "?"}`,
  );
}

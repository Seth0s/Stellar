// O MASCARADOR (task 71128571) — `npm run verify:smoke` era
// `for f in scripts/verify/smoke-*.mjs; do node "$f" || exit 1; done`: PARA
// no primeiro vermelho. Foi por isso que cinco defeitos independentes
// viveram escondidos atrás de UMA falha (a do seletor de provider), e por
// isso que consertar o primeiro revelava um segundo, e um terceiro. O que
// este arquivo troca: roda TODOS, guarda a saída de cada um, e reporta o
// CONJUNTO — a suíte passa a dizer "estes N falharam" em vez de "o primeiro
// que falhou".
//
// Códigos de saída (mesmo contrato do `makeChecker` de cdp-client.mjs):
//   0 = tudo medido e verde
//   1 = pelo menos uma falha de verdade (FAIL, timeout, erro de processo)
//   2 = nenhuma falha, mas alguma coisa ficou SEM MEDIR (SKIP declarado)
// É a distinção que impede o skip de virar verde: um smoke que não pôde
// medir (CLI real bloqueada por confiança/autenticação, por exemplo) sai
// com 2, nunca com 0.
//
// Uso:
//   node scripts/verify/run-smokes.mjs                 # tudo, sequencial
//   node scripts/verify/run-smokes.mjs terminal mcp    # só os que casam
//   node scripts/verify/run-smokes.mjs --timeout=600
//   node scripts/verify/run-smokes.mjs --list
//
// A saída COMPLETA de cada smoke fica em `.verify-tmp/run-<timestamp>/`, um
// arquivo por smoke (o console só mostra as linhas de FAIL/SKIP/erro). O
// caminho do diretório é impresso no fim: uma rodada que falha em cinco
// lugares precisa dos cinco logs, não de um resumo filtrado.
//
// CUSTO MEDIDO (2026-09-22, esta máquina): os seis smokes deste relatório
// levaram 6min05s no total (12:50:40 → 12:56:45), ~60s de média, com dois
// deles dependendo de turno REAL de CLI (o maior: 2min23s). Sequencial de
// propósito: cada smoke sobe um Electron inteiro com renderer por software,
// e a suíte já divide a máquina com o board do usuário.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const VERIFY_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const loud = (s) => process.stdout.write(s);

if (args.includes("--list")) {
  const all = listSmokes();
  console.log(`${all.length} smokes:`);
  for (const f of all) console.log(`  ${f}`);
  process.exit(0);
}

const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const TIMEOUT_S = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 300;
const filters = args.filter((a) => !a.startsWith("--"));

function listSmokes() {
  return readdirSync(VERIFY_DIR)
    .filter((f) => f.startsWith("smoke-") && f.endsWith(".mjs"))
    .sort();
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = [];
    const proc = spawn(process.execPath, [join(VERIFY_DIR, file)], {
      cwd: join(VERIFY_DIR, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      out.push(`\n[run-smokes] TIMEOUT depois de ${TIMEOUT_S}s — SIGKILL\n`);
    }, TIMEOUT_S * 1000);
    proc.stdout.on("data", (d) => out.push(d.toString()));
    proc.stderr.on("data", (d) => out.push(d.toString()));
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ file, code, signal, ms: Date.now() - started, output: out.join("") });
    });
  });
}

const selected = listSmokes().filter((f) => filters.length === 0 || filters.some((p) => f.includes(p)));
if (selected.length === 0) {
  console.error(`nenhum smoke casa com ${JSON.stringify(filters)}`);
  process.exit(1);
}

const RUN_DIR = join(PROJECT_ROOT, ".verify-tmp", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(RUN_DIR, { recursive: true });
console.log(`rodando ${selected.length} smoke(s), um por vez, timeout ${TIMEOUT_S}s cada`);
console.log(`saída completa de cada um em ${RUN_DIR}\n`);
const results = [];
for (const file of selected) {
  loud(`▶ ${file} ... `);
  const r = await runOne(file);
  const kind = r.signal ? "TIMEOUT" : r.code === 0 ? "PASS" : r.code === 1 ? "FAIL" : r.code === 2 ? "SKIP" : "ERROR";
  results.push({ ...r, kind });
  // O run inteiro de logs pode ser apagado POR FORA no meio da rodada (medido
  // 2026-09-22: um `rm -rf .verify-tmp/` de outro processo derruba a suíte
  // inteira com ENOENT nesta escrita, no smoke 177 de 181). Um diretório de
  // EVIDÊNCIA não pode ser o que mata a medição: recria e segue.
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(join(RUN_DIR, `${kind}-${file}.log`), `exit=${r.code} signal=${r.signal ?? "-"} ms=${r.ms}\n${r.output}`, "utf8");
  } catch (err) {
    console.log(`  [run-smokes] não consegui gravar o log de ${file}: ${String(err)}`);
  }
  loud(`${kind} (${Math.round(r.ms / 1000)}s)\n`);
  if (kind !== "PASS") {
    console.log("  ── saída ──────────────────────────────────────────────");
    for (const line of r.output.split("\n")) {
      if (/FAIL|SKIP|Error|error:|TypeError|failed/.test(line)) console.log(`  ${line}`);
    }
    console.log("  ───────────────────────────────────────────────────────");
  }
}

const failed = results.filter((r) => r.kind !== "PASS" && r.kind !== "SKIP");
const skipped = results.filter((r) => r.kind === "SKIP");
console.log(`\n=== CONJUNTO === ${results.length} rodados: ${results.length - failed.length - skipped.length} PASS, ${failed.length} com falha, ${skipped.length} sem medir`);
for (const r of failed) console.log(`  ${r.kind.padEnd(7)} ${r.file} (${Math.round(r.ms / 1000)}s)`);
for (const r of skipped) console.log(`  ${r.kind.padEnd(7)} ${r.file} (${Math.round(r.ms / 1000)}s)`);
const totalMix = results.reduce((m, r) => (r.ms > m.ms ? r : m), results[0]);
console.log(`  mais demorado: ${totalMix.file} (${Math.round(totalMix.ms / 1000)}s)`);

process.exit(failed.length > 0 ? 1 : skipped.length > 0 ? 2 : 0);

// MEDIÇÃO (task b928f5f3) — o gate DECLARADO em task nunca roda onde não há
// bubblewrap. Este script NÃO implementa o conserto: ele levanta os números da
// decisão. Duas partes, as duas read-only:
//
//   1. O BANCO — quantas tasks declaram `gates`, quantas têm `gateRun` com
//      evidência real do app, e quantas têm a RECUSA por sandbox. O número diz
//      se o problema é de um board ou de um padrão (a pergunta do dono).
//   2. A PLATAFORMA — o que existe nesta máquina (`bwrap`? `sandbox-exec`?) e,
//      por leitura de `src/main/sandbox.ts`, os flags exatos que o confinamento
//      de hoje usa. É contra ESSA lista que qualquer equivalente por
//      plataforma tem de ser comparado, inclusive para dizer onde ele é MAIS
//      FRACO.
//
// Uso:
//   node scripts/verify/investigate-task-gates-platform.mjs
//   node scripts/verify/investigate-task-gates-platform.mjs --db=/caminho/agent-canvas.db
//
// O banco de macOS/Windows é outro arquivo, noutra máquina: rode isto LÁ para
// o número que decide a prioridade.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function defaultDbPath() {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "stellar", "agent-canvas.db");
  if (process.platform === "win32") return join(process.env.APPDATA ?? home, "stellar", "agent-canvas.db");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "stellar", "agent-canvas.db");
}

const dbArg = process.argv.find((a) => a.startsWith("--db="));
const dbPath = dbArg ? dbArg.slice("--db=".length) : defaultDbPath();

console.log(`plataforma: ${process.platform}`);
console.log(`db: ${dbPath}`);
if (!existsSync(dbPath)) {
  console.log("  (banco não encontrado — rode na máquina onde o app tem dados)");
}

if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = (sql) => db.prepare(sql).get().n;
  const declared = count("select count(*) as n from tasks where gates_json is not null and gates_json not in ('','[]','null')");
  const total = count("select count(*) as n from tasks");
  const rows = db.prepare("select id, status, gates_json, result_json from tasks where result_json like '%gateRun%'").all();
  let withEvidence = 0;
  let refusedSandbox = 0;
  let refusedOther = 0;
  let forged = 0;
  for (const row of rows) {
    let result = null;
    try {
      result = JSON.parse(row.result_json);
    } catch {
      continue;
    }
    const run = result?.gateRun;
    if (run === undefined || run === null) continue;
    if (run === "forged" || run?.forged === true) {
      forged += 1;
      continue;
    }
    const blob = JSON.stringify(run);
    if (blob.includes("sandbox") && blob.includes("indisponível")) refusedSandbox += 1;
    else if (blob.includes("NÃO executado")) refusedOther += 1;
    else withEvidence += 1;
  }
  const declaredWithoutRun = db.prepare(
    "select count(*) as n from tasks where gates_json is not null and gates_json not in ('','[]','null') and (result_json is null or result_json not like '%gateRun%')",
  ).get().n;
  console.log("\n=== BANCO ===");
  console.log(`  tasks no total ......................... ${total}`);
  console.log(`  declaram gates ........................ ${declared}`);
  console.log(`  com gateRun + evidência do app ........ ${withEvidence}`);
  console.log(`  com gateRun + RECUSA por sandbox ...... ${refusedSandbox}`);
  console.log(`  com gateRun + outra recusa ............ ${refusedOther}`);
  console.log(`  gateRun marcado como forjado .......... ${forged}`);
  console.log(`  declaram gates e NÃO têm gateRun ...... ${declaredWithoutRun}`);
  console.log("  (declarar gates e não ter gateRun costuma ser task sem report aceito — outra causa, não a sandbox)");
  db.close();
}

console.log("\n=== O QUE ESTA MÁQUINA TEM ===");
for (const bin of ["bwrap", "sandbox-exec"]) {
  try {
    const where = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    console.log(`  ${bin}: ${where}`);
  } catch {
    console.log(`  ${bin}: não encontrado no PATH`);
  }
}

// Os flags do confinamento de HOJE, lidos do próprio arquivo — não copiados,
// para não divergirem do que o app usa.
const sandboxSrc = readFileSync(join(PROJECT_ROOT, "src", "main", "sandbox.ts"), "utf8");
const fnBody = sandboxSrc.slice(sandboxSrc.indexOf("export function buildSandboxedBashArgs"));
const flags = [...fnBody.slice(0, fnBody.indexOf("\n}")).matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]);
console.log("\n=== CONFINAMENTO DE HOJE (src/main/sandbox.ts, bwrap) ===");
console.log(`  ${flags.join(" ")}`);
console.log("  o que isso garante: host LEGÍVEL (ro-bind / /), /tmp e $HOME OCULTADOS");
console.log("  (tmpfs: sem ~/.ssh, sem secrets.json), SÓ a raiz do projeto GRAVÁVEL,");
console.log("  namespaces pid/ipc/uts/cgroup, morte junto do pai, sessão nova.");
console.log("  E O QUE NÃO GARANTE: rede (não há --unshare-net) — o gate roda com a rede do host.");
console.log("\n  comparar qualquer equivalente POR ESTA LISTA é o ponto: mais fraco tem de ser dito como mais fraco.");

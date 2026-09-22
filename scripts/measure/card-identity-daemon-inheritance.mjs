#!/usr/bin/env node
/**
 * A IDENTIDADE DO CARD QUE O SHIM CARREGA É DE QUEM? — medição, não teoria.
 *
 * Reproduz, em um comando, a medição que abriu a task 34e27f66 (2026-09-22):
 * quatro (depois cinco) cards de provider `cline` reportando TODOS como o
 * mesmo id, e esse id sem linha em `cards`.
 *
 * O que ele lê, por processo, em /proc (Linux; é a plataforma onde o
 * defeito foi medido):
 *   - `environ`     → `AGENT_CANVAS_CARD_ID` de cada processo
 *   - `status`      → `PPid` (quem criou quem)
 *   - `cmdline`     → para separar o processo do CARD do processo do SHIM
 *   - `cwd`         → o terceiro canal que poderia distinguir a sessão
 * e imprime duas tabelas: os processos `stellar-mcp` (o shim, cujo ambiente
 * é o que a identidade do Stellar acaba lendo) e os processos de CLI que
 * hospedam os cards.
 *
 * O QUE A SAÍDA MOSTRA, quando o provider compartilha um daemon (medido no
 * cline): os processos dos CARDS têm cada um o seu id CORRETO, e os shims
 * têm TODOS o MESMO id, porque o pai deles é um único processo daemon cujo
 * ambiente congelou no primeiro card que o subiu. É por isso que o conserto
 * não pode ser "reescrever o env por card" — o processo é um só.
 *
 * Sem dependência nenhuma, read-only: não escreve, não mata, não toca no
 * banco. Uso: `node scripts/measure/card-identity-daemon-inheritance.mjs`.
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function envOf(pid) {
  const raw = read(`/proc/${pid}/environ`);
  const out = {};
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function ppidOf(pid) {
  const m = /^PPid:\s*(\d+)/m.exec(read(`/proc/${pid}/status`));
  return m ? Number(m[1]) : null;
}

function cmdlineOf(pid) {
  return read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ").slice(0, 96);
}

function isAlive(pid) {
  try {
    readdirSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

function allPids() {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

const pids = allPids().filter(isAlive);
const rows = pids.map((pid) => {
  const env = envOf(pid);
  return {
    pid,
    ppid: ppidOf(pid),
    cardId: env.AGENT_CANVAS_CARD_ID ?? "",
    cwd: (() => {
      try {
        return readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return "";
      }
    })(),
    cmd: cmdlineOf(pid),
  };
});

const shims = rows.filter((r) => /stellar-mcp/.test(r.cmd));
const hosts = rows.filter((r) => r.cardId && !/stellar-mcp/.test(r.cmd));

function table(title, list) {
  console.log(`\n=== ${title} (${list.length}) ===`);
  if (list.length === 0) console.log("(nenhum)");
  for (const r of list) {
    console.log(`pid=${r.pid} ppid=${r.ppid} CARD_ID=${r.cardId || "—"} cwd=${r.cwd}`);
  }
}

table("processos do SHIM stellar-mcp (a identidade que o Stellar lê)", shims);
table("processos que hospedam cards (AGENT_CANVAS_CARD_ID no ambiente)", hosts);

const shimCards = [...new Set(shims.map((r) => r.cardId))];
const shimParents = [...new Set(shims.map((r) => r.ppid))];
const distinct = new Set(shims.map((r) => JSON.stringify({ cardId: r.cardId, cwd: r.cwd })));

console.log("\n=== leitura ===");
console.log(`shims: ${shims.length} | ids distintos entre eles: ${shimCards.length} → ${shimCards.join(", ") || "—"}`);
console.log(`pais distintos dos shims: ${shimParents.length} → ${shimParents.join(", ") || "—"}`);
console.log(
  distinct.size === 1 && shims.length > 1
    ? "VEREDITO: os shims são processos DISTINTOS com ambiente e cwd IDÊNTICOS — o transporte cria\n" +
        "          uma sessão por card, mas não carrega nenhum byte que distinga as sessões. A identidade\n" +
        "          chegou por HERANÇA do processo pai, que é um só."
    : "VEREDITO: os shims NÃO compartilham ambiente/cwd — a herança não é o caminho da identidade\n" +
        "          aqui (provider com processo próprio por card, como o claude).",
);

const parentIds = shimParents.filter((p) => p !== null);
for (const parent of parentIds) {
  const row = rows.find((r) => r.pid === parent);
  if (row) {
    console.log(
      `\npai compartilhado pid=${row.pid} CARD_ID=${row.cardId || "—"} — ${row.cmd}\n` +
        `   (é este processo que congela o ambiente; medido também: /proc/${row.pid}/environ)`,
    );
  }
}

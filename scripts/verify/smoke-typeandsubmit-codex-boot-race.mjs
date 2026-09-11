// DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
// caixa sem submeter" — verificação REAL contra um `codex` de verdade
// (nunca só `bash`), mesma lição do bug da máscara de imagem que passava
// em `bash` e falhava contra `claude` de verdade. Roda a REAL
// `createPtyRegistry` (src/main/pty-registry.ts) e as REAIS decisões puras
// de `type-and-submit-decision.ts` — nada reimplementado aqui, só
// orquestrado.
//
// cwd tem que ser um diretório que `codex` já marca como `trust_level =
// "trusted"` em ~/.codex/config.toml — um diretório novo dispara o diálogo
// "Do you trust the contents of this directory?", uma interação A MAIS que
// não é o bug sendo testado aqui (mesma classe de ressalva que o precedente
// `smoke-pty-resume-trigger-rearm.mjs` já documentou pro diálogo de trust
// do `claude`). Roda dentro de `.verify-tmp/` (sub-diretório do próprio
// projeto, que já é confiado).
//
// Por que a prova NÃO é "digite cedo demais e veja falhar, ao vivo, de
// ponta a ponta": tentado durante a construção deste script — a corrida é
// sensível o bastante a timing/carga da máquina que às vezes o `codex`
// ainda consegue engolir os 4 `\r` automáticos e submeter mesmo sem portão
// nenhum, o que provaria só "às vezes dá sorte", não a causa raiz. As 2
// provas abaixo são timing-independentes:
//   1. O boot do `codex` genuinamente ultrapassa a janela de retry antiga
//      (~1.3s) — medido contra o processo real, repetidas vezes. Isto é a
//      PRECONDIÇÃO do bug (backlog achado 1), e é isto que resolve — o
//      portão de prontidão espera esse tempo real, não um número mágico.
//   2. Contra um SCREEN SNAPSHOT real (capturado do mesmo boot, não
//      fabricado), a lógica antiga (só o texto ausente da tela = "enviado")
//      e a nova (`decideSubmitCheck`, que também exige atividade nova desde
//      a escrita) DISCORDAM exatamente como o backlog descreve — a antiga
//      diz "enviado" olhando pra uma tela onde nada foi de fato escrito
//      ainda; a nova diz "não sei ainda".
// Cenário 3 roda o fluxo NOVO de ponta a ponta (portão real + laço de
// confirmação real) e confirma a submissão genuína via `~/.codex/history.jsonl`
// — sinal do próprio `codex`, não parsing de tela, pra fechar sem depender
// de heurística de ANSI neste script.
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const verifyTmp = fileURLToPath(new URL("../../.verify-tmp", import.meta.url));
const entryPath = `${verifyTmp}/typeandsubmit-codex-boot-race.entry.ts`;
const bundlePath = `${verifyTmp}/typeandsubmit-codex-boot-race.bundle.mjs`;
mkdirSync(verifyTmp, { recursive: true });
writeFileSync(
  entryPath,
  `export { createPtyRegistry } from "../src/main/pty-registry";\n` +
    `export { decideWriteReadiness, decideSubmitCheck } from "../src/main/type-and-submit-decision";\n`,
);
execFileSync(
  "./node_modules/.bin/esbuild",
  [entryPath, "--bundle", "--platform=node", "--format=esm", "--external:node-pty", "--external:better-sqlite3", "--external:node:*", `--outfile=${bundlePath}`],
  { cwd: repoRoot, stdio: "inherit" },
);
const { createPtyRegistry, decideWriteReadiness, decideSubmitCheck } = await import(bundlePath);

let failed = false;
function check(name, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const TASK_TEXT = `explique em uma frase o que este repositorio faz (verify-${Date.now()})`;
const SENT_PREFIX = TASK_TEXT.trim().replace(/\s+/g, " ").slice(0, 24);

// Mesmo helper interno de `decideSubmitCheck` (type-and-submit-decision.ts),
// reproduzido aqui só pra poder chamar a checagem de "ainda parece não
// enviado" isoladamente contra o snapshot real do Cenário 2 — não
// exportado de lá de propósito (é implementação interna da decisão, não
// parte da API pública do módulo).
function looksUnsentText(screenText, sentPrefix) {
  if (/pasted text/i.test(screenText)) return true;
  if (sentPrefix.length < 8) return false;
  return screenText.replace(/\s+/g, " ").includes(sentPrefix);
}

function stripAnsi(s) {
  const ANSI_PATTERN = new RegExp(
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)" +
      "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
    "g",
  );
  return s.replace(ANSI_PATTERN, "");
}

function makeRegistry(id, tag) {
  let text = "";
  const registry = createPtyRegistry({
    onData: (cardId, data) => {
      text += data;
    },
    onExit: () => {},
    onSessionFound: () => {},
    onResumeInvalid: () => {},
    onUrlSeen: () => {},
    sockPath: `${verifyTmp}/${tag}.sock`,
    binDir: `${repoRoot}resources/bin`,
    mcpUrl: "", // sem servidor MCP real — não é o que este teste exercita
  });
  return {
    registry,
    // Snapshot pra leitura pontual (Cenários 1 e 2): últimos N bytes crus,
    // ANSI stripado — suficiente pra achar/não achar um prefixo de texto
    // numa checagem ISOLADA. Não tenta reconstruir a tela renderizada de
    // verdade (isso é trabalho do xterm.js real, do lado do renderer) —
    // só o bastante pra reproduzir fielmente o que `looksUnsentLegacy`/
    // `decideSubmitCheck` recebiam como `checkText` na app de verdade
    // (as últimas linhas lidas por `readCardText`, não o histórico
    // inteiro).
    rawTail: (n = 4000) => stripAnsi(text.slice(-n)),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHistoryEntriesSince(sinceEpochSec) {
  const historyPath = `${homedir()}/.codex/history.jsonl`;
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && row.ts >= sinceEpochSec && row.text === TASK_TEXT);
}

const CWD = `${verifyTmp}/codex-boot-race`;
mkdirSync(CWD, { recursive: true });

// --- Cenário 1: mede o boot real, sem digitar nada — prova a precondição do backlog ---
console.log("\n=== Cenário 1: medindo o boot real do codex (sem digitar nada) ===");
let midBootSnapshot = "";
{
  const id = "measure";
  const { registry, rawTail } = makeRegistry(id, "measure");
  const spawnResult = registry.spawn(id, "codex", CWD, 100, 30, {});
  check("spawn do codex funcionou", "id" in spawnResult, JSON.stringify(spawnResult));
  const spawnedAtMs = Date.now();

  // Mesmo instante em que o código ANTIGO faria sua ÚNICA checagem se só
  // desse 1 tentativa de Enter (SEND_ENTER_DELAY_MS + SEND_ENTER_CONFIRM_DELAY_MS
  // = 80+250 = 330ms) — capturado aqui, contra um boot onde NADA foi
  // digitado, pra alimentar o Cenário 2 com um snapshot genuinamente real.
  await delay(330);
  midBootSnapshot = rawTail();

  await delay(2700); // completa ~3s totais, tempo de sobra pro boot quietar
  const snap = registry.getWriteReadiness(id);
  const bootActivityMs = snap.lastActivityAtMs - spawnedAtMs;
  console.log(`    hasReceivedData=${snap.hasReceivedData} atividade-desde-spawn=${bootActivityMs}ms`);
  const OLD_RETRY_WINDOW_MS = 80 + 250 * 4; // SEND_ENTER_DELAY_MS + 4x SEND_ENTER_CONFIRM_DELAY_MS, pior caso
  check(
    "boot do codex genuinamente ultrapassa a janela de retry antiga (~1.3s) — prova a precondição do backlog, não só repete a afirmação",
    bootActivityMs > OLD_RETRY_WINDOW_MS,
    `atividade seguiu até ${bootActivityMs}ms depois do spawn, janela antiga era ${OLD_RETRY_WINDOW_MS}ms`,
  );
  registry.kill(id, { immediate: true });
  await delay(300);
}

// --- Cenário 2: contra um snapshot REAL de tela em pleno boot, antiga vs nova discordam ---
console.log("\n=== Cenário 2: antiga vs nova contra um snapshot real de tela em boot (achado 2) ===");
{
  console.log(`    snapshot (últimos 200 chars, ANSI removido): ${JSON.stringify(midBootSnapshot.slice(-200))}`);
  // Nada foi digitado nesta sessão (Cenário 1 nunca escreveu) — logo o
  // prefixo do texto genuinamente NUNCA esteve na tela, e "ausente" aqui
  // não significa "enviado", significa "nunca foi nem tentado". A lógica
  // ANTIGA (só isso importava) concluiria "enviado" mesmo assim.
  const legacyLooksUnsent = looksUnsentText(midBootSnapshot, SENT_PREFIX);
  const legacyConclusion = legacyLooksUnsent ? "unsent" : "sent";
  check(
    "REPRODUZIDO: a lógica ANTIGA (só ausência de prefixo) conclui 'sent' contra uma tela onde nada foi realmente escrito ainda",
    legacyConclusion === "sent",
    `looksUnsent=${legacyLooksUnsent} → lógica antiga teria concluído "${legacyConclusion}"`,
  );

  // A mesma checagem, mas com a decisão NOVA — com `hasNewActivitySinceWrite:
  // false` (o valor REAL: nada mudou por causa de uma escrita que nunca
  // aconteceu nesta sessão de medição).
  const newResult = decideSubmitCheck({
    screenText: midBootSnapshot,
    sentPrefix: SENT_PREFIX,
    hasNewActivitySinceWrite: false,
  });
  check(
    "CORRIGIDO: a lógica NOVA recusa concluir 'sent' contra a MESMA tela — 'unknown', não confunde silêncio com sucesso",
    newResult === "unknown",
    `decideSubmitCheck devolveu "${newResult}"`,
  );
}

// --- Cenário 3: fluxo NOVO de ponta a ponta — portão real + confirmação real ---
console.log("\n=== Cenário 3: fluxo NOVO de ponta a ponta contra o codex real ===");
{
  const id = "fixed";
  const { registry, rawTail } = makeRegistry(id, "fixed");
  const beforeSpawnEpochSec = Math.floor(Date.now() / 1000) - 1; // -1s de folga p/ arredondamento
  registry.spawn(id, "codex", CWD, 100, 30, {});

  // Portão de prontidão — mesmo laço que message-bus.ts's `waitForWriteReadiness`,
  // usando a função pura REAL do fix.
  const gateStart = Date.now();
  for (;;) {
    const snap = registry.getWriteReadiness(id);
    const now = Date.now();
    const decision = decideWriteReadiness({
      hasReceivedData: snap.hasReceivedData,
      msSinceLastActivity: now - snap.lastActivityAtMs,
      msSinceSpawn: now - snap.spawnedAtMs,
    });
    if (decision.action === "proceed") {
      console.log(`    portão liberou depois de ${now - gateStart}ms de espera (motivo: ${decision.reason})`);
      break;
    }
    await delay(40);
  }

  const activityAtWrite = registry.getLastActivityAt(id);
  registry.write(id, TASK_TEXT);
  let result = "unsent";
  for (let attempt = 0; attempt < 4; attempt++) {
    await delay(80);
    registry.write(id, "\r");
    await delay(250);
    const currentActivity = registry.getLastActivityAt(id);
    result = decideSubmitCheck({
      screenText: rawTail(),
      sentPrefix: SENT_PREFIX,
      hasNewActivitySinceWrite: typeof activityAtWrite !== "number" || typeof currentActivity !== "number" || currentActivity > activityAtWrite,
    });
    console.log(`    [fixed] attempt=${attempt} result=${result}`);
    if (result === "sent") break;
  }
  console.log(`    decideSubmitCheck concluiu: ${result}`);

  // Fecho independente de parsing de tela: o PRÓPRIO `codex` só grava uma
  // entrada em `~/.codex/history.jsonl` quando um prompt é genuinamente
  // processado como turno — sinal do processo real, não uma heurística
  // deste script. Espera um pouco mais que o laço de confirmação pra dar
  // tempo do arquivo ser escrito, sem depender de acertar o instante exato.
  await delay(500);
  const submitted = readHistoryEntriesSince(beforeSpawnEpochSec);
  check(
    "CONFIRMADO: o codex real registrou o prompt como um turno genuíno em history.jsonl (não só 'parece enviado' na tela)",
    submitted.length > 0,
    submitted.length > 0 ? `session_id=${submitted[0].session_id}` : "nenhuma entrada nova encontrada",
  );
  check("decideSubmitCheck também concluiu 'sent' (concorda com o sinal independente)", result === "sent");

  registry.kill(id, { immediate: true });
  await delay(300);
}

rmSync(verifyTmp, { recursive: true, force: true });
console.log(failed ? "\nFALHOU" : "\nTUDO OK");
process.exit(failed ? 1 : 0);

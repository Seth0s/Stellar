/**
 * A TROCA DA ATUALIZAÇÃO NO MAC, FEITA POR NÓS (task d0fef4e7).
 *
 * POR QUE ESTE MÓDULO EXISTE — medido, não suposto: no darwin o
 * `electron-updater` NÃO instala. O `MacUpdater` sobe um servidor local com o
 * zip, aponta o `electron.autoUpdater` para ele e chama
 * `nativeUpdater.quitAndInstall()` (`out/MacUpdater.js:211-233`) — quem aplica é
 * o Squirrel.Mac/ShipIt, que exige bundle ASSINADO. O build desta casa sai sem
 * assinatura (`release.yml`: `CSC_IDENTITY_AUTO_DISCOVERY=false`), então o
 * caminho da lib recusa. A decisão pura dizia `canInstall: true` para darwin
 * sem medição nenhuma — um botão que provavelmente falha.
 *
 * O QUE FAZEMOS NO LUGAR: o app baixa o `.zip` (é o arquivo que o
 * `latest-mac.yml` declara; a lib o escolhe em `findFile(files, "zip", …)`),
 * CONFERIMOS o sha512 declarado antes de usar, extraímos com `ditto -x -k`
 * (preserva o bundle) e armamos um script DESTACADO — porque o processo que
 * substitui o bundle não pode ser o que está rodando DENTRO dele. O script
 * espera o PID sair, troca de forma ATÔMICA (renomeia o velho, move o novo, só
 * então apaga o velho; se o move falhar, DESFAZ), tira o
 * `com.apple.quarantine` do bundle novo e reabre.
 *
 * FALHA EM QUALQUER PASSO = APP VELHO INTACTO. Enquanto o script não chega no
 * `mv` do novo, nada foi tocado; e se o `mv` do novo falhar, o velho volta do
 * nome `.old` para o lugar. O banner mostra o erro E o link da release.
 *
 * ELEVAÇÃO: só quando o destino não é gravável pelo usuário, e pelo diálogo
 * NATIVO do macOS (`osascript … with administrator privileges`) — nunca um campo
 * de senha nosso.
 *
 * NÃO TEMOS MAC nesta máquina: por isso o script é TEXTO (testado por conteúdo,
 * que é o que roda lá) e toda a I/O está atrás de uma costura injetável, para a
 * orquestração ser testada sem darwin. O caminho do log é dito na UI para o
 * testador mandar.
 */
import { accessSync, constants, createReadStream, writeFileSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";

/** O nome do arquivo de log da troca, dentro do userData. */
export const MAC_SWAP_LOG_FILENAME = "update-swap.log";

/**
 * O bundle `.app` a partir do executável em execução — `app.getPath("exe")` na
 * prática. Devolve `null` quando o caminho não está dentro de um bundle: a troca
 * NUNCA presume `/Applications`, e sem destino real ela não acontece.
 */
export function bundlePathFromExe(exePath: string): string | null {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath);
  return match === null ? null : match[1];
}

/** sha512 em base64, como o electron-updater declara no `latest-*.yml`. */
export function sha512Base64(data: Buffer): string {
  return createHash("sha512").update(data).digest("base64");
}

/** O pacote só é usado se bater com o feed. Comparação de strings — o valor
 *  declarado é base64 e não há segredo nenhum nele. */
export function verifySha512(data: Buffer, expectedBase64: string): boolean {
  const expected = expectedBase64.trim();
  if (expected === "") return false;
  return sha512Base64(data) === expected;
}

/**
 * O sha512 do ZIP entre os arquivos que o feed declarou — mesma escolha do
 * `MacUpdater` (`findFile(files, "zip", ["pkg", "dmg"])`, `out/MacUpdater.js:81`).
 * Um feed sem zip, ou com sha512 vazio, devolve `null`: sem esse valor a troca
 * não tem como conferir o pacote antes de usar, e ela NÃO acontece.
 */
export function pickMacZipSha512(
  files: readonly { url?: string; sha512?: string }[],
): string | null {
  const zip = files.find((f) => typeof f.url === "string" && f.url.endsWith(".zip"));
  return typeof zip?.sha512 === "string" && zip.sha512 !== "" ? zip.sha512 : null;
}

/** A costura de I/O: o que o módulo precisa do sistema, injetável para teste. */
export type MacSwapIo = {
  /** sha512 base64 do arquivo baixado. */
  sha512OfFile(path: string): Promise<string>;
  /** `ditto -x -k <zip> <destino>` — preserva o bundle. */
  extractZip(zipPath: string, destDir: string): Promise<void>;
  /** O diretório do bundle atual aceita escrita pelo usuário? */
  pathIsWritable(path: string): Promise<boolean>;
  writeScript(path: string, content: string): Promise<void>;
  /** `/bin/sh <script>`, destacado e desacoplado (sobrevive ao quit). */
  spawnDetached(scriptPath: string): void;
};

export type MacSwapStep = "verify-checksum" | "extract" | "arm-script";

export type MacSwapResult =
  | {
      ok: true;
      steps: MacSwapStep[];
      needsElevation: boolean;
      scriptPath: string;
      newBundle: string;
    }
  | { ok: false; failedStep: MacSwapStep; error: string; rolledBack: true };

/**
 * O SCRIPT que roda no Mac. Função pura: é o artefato que o testador executa, e
 * ele é conferido por conteúdo porque aqui não há darwin para exercitá-lo.
 *
 * Ordem (e o teste trava cada uma): espera o PID sair → renomeia o ATUAL para
 * `.old` → move o NOVO para o lugar → apaga o `.old` → tira o quarantine →
 * reabre. O undo existe para o passo que pode falhar no meio.
 */
export function renderMacSwapScript(input: {
  currentBundle: string;
  newBundle: string;
  pid: number;
  logPath: string;
  needsElevation: boolean;
  /** Para QUAL versão se está trocando — o log que o testador manda diz isso. */
  newVersion: string;
}): string {
  // Os passos que trocam o bundle, escritos UMA vez e usados nos dois caminhos.
  // Elevado, quem executa é o root: aí eles não escrevem no arquivo de log,
  // IMPRIMEM — e o processo pai (que roda como o usuário) anexa o que veio.
  // Assim o log continua sendo um arquivo do usuário, e não um arquivo de root
  // que ele não consegue nem apagar.
  const swapSteps = (asRoot: boolean): string[] => {
    const say = (msg: string): string => (asRoot ? `echo '${msg}'` : `log "${msg}"`);
    return [
      'if [ ! -d "$CURRENT" ]; then',
      `${say("falhou: o bundle atual nao existe")}`,
      "  exit 1",
      "fi",
      'if [ ! -d "$NEW" ]; then',
      `${say("falhou: o bundle novo nao foi extraido")}`,
      "  exit 1",
      "fi",
      'mv "$CURRENT" "$CURRENT.old" || {',
      `${say("falhou ao renomear o bundle atual")}`,
      "  exit 1",
      "}",
      'if mv "$NEW" "$CURRENT"; then',
      '  rm -rf "$CURRENT.old"',
      `${say("trocado")}`,
      "else",
      '  mv "$CURRENT.old" "$CURRENT"',
      `${say("MOVE falhou, desfeito: o app velho esta no lugar")}`,
      "  exit 1",
      "fi",
      'xattr -dr com.apple.quarantine "$CURRENT" 2>/dev/null || true',
      `${say("quarantine removido")}`,
    ];
  };
  // O CAMINHO DA SENHA só existe quando o destino não é gravável pelo usuário:
  // um script que não precisa de elevação não tem, no texto, por onde pedir
  // senha nenhuma (mais forte que um `if` de runtime que está sempre lá).
  const elevationPrologue: string[] = input.needsElevation
    ? [
        "# JEITO ELEVADO: o script se RE-EXECUTA com --elevated, pelo dialogo NATIVO",
        "# do macOS. Só os passos de troca entram aqui - nada de senha em campo nosso.",
        'if [ "$1" = "--elevated" ]; then',
        ...swapSteps(true),
        "  exit 0",
        "fi",
        "",
      ]
    : [];
  const swapBlocks: string[] = input.needsElevation
    ? [
        "# O diálogo nativo pergunta a senha; `quoted form of` é do AppleScript e cita",
        "# SÓ o caminho do script — citar a linha inteira faria o shell procurar um",
        "# comando chamado \"/bin/sh <script> --elevated\".",
        'log "pedindo elevacao pelo dialogo nativo do macOS"',
        'osascript -e "do shell script (\\"/bin/sh \\" & quoted form of \\"$0\\" & \\" --elevated\\") with administrator privileges" >> "$LOG" 2>&1 || {',
        '  log "elevacao recusada ou troca falhou - o app velho esta no lugar"',
        "  exit 1",
        "}",
      ]
    : [...swapSteps(false)];
  return [
    "#!/bin/sh",
    "# A troca do bundle (task d0fef4e7). O log diz cada passo e o resultado;",
    "# nenhuma credencial passa por aqui.",
    `LOG=${shellQuote(input.logPath)}`,
    `CURRENT=${shellQuote(input.currentBundle)}`,
    `NEW=${shellQuote(input.newBundle)}`,
    `PID=${input.pid}`,
    'log() { printf \'%s swap: %s\\n\' "$(date -u +%FT%TZ)" "$1" >> "$LOG"; }',
    "",
    ...elevationPrologue,
    `log "start (pid $PID, novo ${input.newVersion})"`,
    "# 1. O app PRECISA ter saido: trocar o bundle de dentro dele quebraria a troca.",
    "i=0",
    'while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done',
    'if kill -0 "$PID" 2>/dev/null; then log "o app nao saiu em 60s - nao toquei em nada"; exit 1; fi',
    'log "app saiu"',
    ...swapBlocks,
    "# A troca esta feita. Reabrir e do USUARIO, nunca do root.",
    'open "$CURRENT"',
    'log "fim"',
    "",
  ].join("\n");
}

/** Aspas simples de shell: um caminho com espaço ("Stellar Betas") é legítimo. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A orquestração: verifica, extrai, arma o script e — quem troca de fato é o
 * script, já fora deste processo. `rolledBack: true` no erro significa que o
 * bundle em execução não foi tocado (nada aqui escreve nele).
 */
export async function performMacSwap(
  facts: {
    zipPath: string;
    expectedSha512: string;
    currentBundle: string;
    newVersion: string;
    logPath: string;
    workDir: string;
  },
  io: MacSwapIo,
): Promise<MacSwapResult> {
  const steps: MacSwapStep[] = [];
  try {
    const actual = await io.sha512OfFile(facts.zipPath);
    if (actual.trim() !== facts.expectedSha512.trim()) {
      return {
        ok: false,
        failedStep: "verify-checksum",
        error: `o pacote baixado não bate com o sha512 do feed (esperado ${facts.expectedSha512.slice(0, 16)}…, veio ${actual.slice(0, 16)}…)`,
        rolledBack: true,
      };
    }
    steps.push("verify-checksum");
  } catch (err) {
    return { ok: false, failedStep: "verify-checksum", error: message(err), rolledBack: true };
  }

  let newBundle: string;
  try {
    await io.extractZip(facts.zipPath, facts.workDir);
    steps.push("extract");
    const appName = facts.currentBundle.split("/").pop() ?? "";
    newBundle = `${facts.workDir}/${appName}`;
  } catch (err) {
    return { ok: false, failedStep: "extract", error: message(err), rolledBack: true };
  }

  try {
    const dir = facts.currentBundle.split("/").slice(0, -1).join("/");
    const needsElevation = !(await io.pathIsWritable(dir));
    const scriptPath = `${facts.workDir}/swap.sh`;
    await io.writeScript(
      scriptPath,
      renderMacSwapScript({
        currentBundle: facts.currentBundle,
        newBundle,
        pid: process.pid,
        logPath: facts.logPath,
        needsElevation,
        newVersion: facts.newVersion,
      }),
    );
    io.spawnDetached(scriptPath);
    steps.push("arm-script");
    return { ok: true, steps, needsElevation, scriptPath, newBundle };
  } catch (err) {
    return { ok: false, failedStep: "arm-script", error: message(err), rolledBack: true };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A COSTURA REAL, em Node puro — separada de `updater.ts` (que importa
 * `electron`) para ser exercitada por teste nesta máquina sem darwin. Cada
 * função faz UMA coisa do sistema; nenhuma delas decide nada.
 */
export const macSwapNodeIo: MacSwapIo = {
  // O zip do mac é grande: hash em FLUXO, e o valor não é usado antes de bater
  // com o do feed.
  sha512OfFile: (path) =>
    new Promise((resolve, reject) => {
      const hash = createHash("sha512");
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("base64")));
    }),
  extractZip: (zipPath, destDir) =>
    new Promise((resolve, reject) => {
      // `ditto -x -k` é o extrator que a Apple recomenda para `.app`: preserva
      // o bundle. `unzip` perderia metadados que o app precisa.
      const child = spawnChild("ditto", ["-x", "-k", zipPath, destDir]);
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`ditto saiu com ${String(code)}`)),
      );
    }),
  pathIsWritable: async (path) => {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  writeScript: async (path, content) => {
    writeFileSync(path, content, { mode: 0o755 });
  },
  spawnDetached: (scriptPath) => {
    // DESTACADO de propósito: quem troca o bundle não pode ser o processo que
    // está rodando DENTRO dele. `unref` + stdio ignorado fazem o script
    // sobreviver ao `app.quit()` que vem logo depois.
    spawnChild("/bin/sh", [scriptPath], { detached: true, stdio: "ignore" }).unref();
  },
};

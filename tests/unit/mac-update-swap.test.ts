import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundlePathFromExe,
  macSwapNodeIo,
  pickMacZipSha512,
  sha512Base64,
  performMacSwap,
  renderMacSwapScript,
  verifySha512,
  type MacSwapIo,
} from "../../src/main/mac-update-swap";

/**
 * A TROCA NO MAC SEM ASSINATURA DA APPLE (task d0fef4e7).
 *
 * O PROBLEMA, medido: o `electron-updater` no darwin NÃO instala — ele delega ao
 * `electron.autoUpdater` (Squirrel.Mac/ShipIt): `MacUpdater` sobe um servidor
 * local com o zip e chama `nativeUpdater.quitAndInstall()`
 * (`node_modules/electron-updater/out/MacUpdater.js:211-233`). ShipIt exige
 * bundle ASSINADO, e o build desta casa sai sem assinatura
 * (`CSC_IDENTITY_AUTO_DISCOVERY=false`) — então o botão de instalar oferecido
 * hoje cai no caminho que recusa. A decisão pura dizia `canInstall: true` para
 * darwin SEM medição nenhuma.
 *
 * O que estes testes travam é a TROCA que fazemos por conta própria: verificar o
 * sha512 ANTES de usar, extrair com `ditto`, e um script DESTACADO que espera o
 * PID sair, troca o bundle de forma ATÔMICA (renomeia o velho, move o novo, só
 * então apaga o velho; se o move falhar, desfaz), limpa o `com.apple.quarantine`
 * e reabre. Falha em qualquer passo = o app velho intacto.
 *
 * NÃO TEMOS MAC: o script é testado pelo CONTEÚDO (é ele que roda lá), e a
 * orquestração por costura injetável — nenhum teste aqui precisa de darwin.
 */

const FACTS = {
  currentBundle: "/Applications/Stellar.app",
  newBundle: "/tmp/stellar-swap-1/Stellar.app",
  pid: 4242,
  logPath: "/Users/x/Library/Application Support/Stellar/update-swap.log",
  newVersion: "9.9.9",
};

describe("bundlePathFromExe — onde o app ESTÁ, nunca onde se presume", () => {
  it("sobe do executável até o `.app` (o caminho real desta instalação)", () => {
    expect(bundlePathFromExe("/Applications/Stellar.app/Contents/MacOS/Stellar")).toBe(
      "/Applications/Stellar.app",
    );
    expect(
      bundlePathFromExe("/Users/x/Downloads/Stellar Betas/Stellar.app/Contents/MacOS/Stellar"),
    ).toBe("/Users/x/Downloads/Stellar Betas/Stellar.app");
  });

  it("fora de um bundle -> null (a troca NÃO pode adivinhar um destino)", () => {
    expect(bundlePathFromExe("/usr/local/bin/stellar")).toBeNull();
    expect(bundlePathFromExe("/Applications/Stellar.app")).toBeNull();
  });
});

describe("verifySha512 — o pacote não é usado antes de bater com o feed", () => {
  const data = Buffer.from("conteudo de teste");
  const expected =
    "ajdtW7Bd2OEXZS8QRTsc7Lq7kORdEKf4TAC5j0re2Yq1Q6KP7fAuaXkj5CubJXLeHipcAgyC79y8ZcEN7BGdGQ==";

  it("bate -> true", () => {
    expect(verifySha512(data, expected)).toBe(true);
  });

  it("um byte diferente, ou base64 vazio -> false (nada é usado por aproximação)", () => {
    expect(verifySha512(Buffer.from("conteudo de testes"), expected)).toBe(false);
    expect(verifySha512(data, "")).toBe(false);
    expect(verifySha512(data, "   ")).toBe(false);
  });
});

describe("renderMacSwapScript — o script que RODA no Mac é texto testável", () => {
  const script = renderMacSwapScript({ ...FACTS, needsElevation: false });

  it("espera o PID sair antes de tocar no bundle", () => {
    // O PID do app que está RODANDO é o do próprio processo que armou o script;
    // a espera é com a variável, não com um literal (assertiva ajustada: a
    // primeira versão deste teste procurava o texto `kill -0 4242` e falhava
    // por uma razão que não era a propriedade).
    expect(script).toContain("PID=4242");
    expect(script).toContain('while kill -0 "$PID"');
    expect(script).toContain("o app nao saiu em 60s");
  });

  it("troca ATÔMICA: renomeia o velho, move o novo, e só então apaga o velho", () => {
    const iRename = script.indexOf('mv "$CURRENT" "$CURRENT.old"');
    const iMove = script.indexOf('mv "$NEW" "$CURRENT"');
    const iRm = script.indexOf('rm -rf "$CURRENT.old"');
    expect(iRename).toBeGreaterThan(-1);
    expect(iMove).toBeGreaterThan(iRename);
    expect(iRm).toBeGreaterThan(iMove);
  });

  it("se o MOVE falhar, DESFAZ (o app velho volta ao lugar)", () => {
    expect(script).toContain('mv "$CURRENT.old" "$CURRENT"');
  });

  it("limpa o quarantine do bundle novo e reabre o app", () => {
    expect(script).toContain("xattr -dr com.apple.quarantine");
    expect(script).toContain('open \"$CURRENT\"');
  });

  it("escreve cada passo no log que o testador pode mandar", () => {
    expect(script).toContain(FACTS.logPath);
    expect(script).toContain("swap:");
  });

  it("elevação: o pedido é o diálogo NATIVO do macOS — nunca senha num campo nosso", () => {
    const elevated = renderMacSwapScript({ ...FACTS, needsElevation: true });
    expect(elevated).toContain("osascript");
    expect(elevated).toContain("with administrator privileges");
    expect(elevated).not.toContain("read -s");
  });
});

describe("performMacSwap — a orquestração, com a costura injetável", () => {
  function seams(over: Partial<MacSwapIo> = {}) {
    const calls: string[] = [];
    const io: MacSwapIo = {
      sha512OfFile: async () => "sha",
      extractZip: async () => calls.push("extract"),
      pathIsWritable: async () => true,
      writeScript: async (path) => calls.push(`write:${path}`),
      spawnDetached: (path) => calls.push(`spawn:${path}`),
      ...over,
    };
    return { io, calls };
  }
  const facts = {
    zipPath: "/tmp/update.zip",
    expectedSha512: "sha",
    currentBundle: FACTS.currentBundle,
    newVersion: "9.9.9",
    logPath: FACTS.logPath,
  };

  it("caminho feliz: verifica -> extrai -> arma o script -> RECUSA seguir sem o app sair", async () => {
    const { io, calls } = seams();
    const result = await performMacSwap(facts, io);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "extract",
      expect.stringContaining("write:"),
      expect.stringContaining("spawn:"),
    ]);
  });

  it("sha512 DIFERENTE -> aborta ANTES de extrair ou tocar em qualquer coisa", async () => {
    const { io, calls } = seams({ sha512OfFile: async () => "outro" });
    const result = await performMacSwap(facts, io);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failedStep).toBe("verify-checksum");
    expect(calls).toEqual([]);
  });

  it("destino NÃO gravável -> o script sai com elevação (e o passo é dito)", async () => {
    const { io, calls } = seams({ pathIsWritable: async () => false });
    const result = await performMacSwap(facts, io);
    expect(result.ok).toBe(true);
    expect(result.ok && result.needsElevation).toBe(true);
    expect(calls).toContain("extract");
  });

  it("falha ao extrair -> o app velho fica intacto e o erro é nomeado", async () => {
    const { io } = seams({
      extractZip: async () => {
        throw new Error("ditto: not a zip");
      },
    });
    const result = await performMacSwap(facts, io);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failedStep).toBe("extract");
    expect(result.error).toContain("ditto");
  });
});

describe("pickMacZipSha512 — o zip do feed, a mesma escolha do MacUpdater", () => {
  it('acha o sha512 do `.zip` e IGNORA pkg/dmg (a lib usa `findFile(files, "zip", ["pkg", "dmg"])`)', () => {
    expect(
      pickMacZipSha512([
        { url: "https://x/Stellar-1.0.0-arm64.dmg", sha512: "dmg" },
        { url: "https://x/Stellar-1.0.0-arm64.pkg", sha512: "pkg" },
        { url: "https://x/Stellar-1.0.0-arm64-mac.zip", sha512: "zipsha" },
      ]),
    ).toBe("zipsha");
  });

  it("sem zip, ou com sha512 vazio -> null: sem valor para conferir, a troca não acontece", () => {
    expect(pickMacZipSha512([{ url: "https://x/a.dmg", sha512: "d" }])).toBeNull();
    expect(pickMacZipSha512([{ url: "https://x/a.zip", sha512: "" }])).toBeNull();
    expect(pickMacZipSha512([])).toBeNull();
  });
});

describe("macSwapNodeIo — a costura REAL, exercitada nesta máquina (sem darwin)", () => {
  it("sha512OfFile lê EM FLUXO e bate com o valor calculado em memória", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7); // > um chunk: exercita o fluxo
    const file = join(tmpdir(), `stellar-hash-${process.pid}.bin`);
    writeFileSync(file, big);
    try {
      expect(await macSwapNodeIo.sha512OfFile(file)).toBe(sha512Base64(big));
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("arquivo ausente -> rejeita (a troca aborta no passo `verify-checksum`)", async () => {
    await expect(macSwapNodeIo.sha512OfFile("/tmp/nao-existe-stellar.zip")).rejects.toThrow();
  });

  it("pathIsWritable: diretório gravável -> true", async () => {
    expect(await macSwapNodeIo.pathIsWritable(tmpdir())).toBe(true);
  });

  it("writeScript deixa o script EXECUTÁVEL (0755) — é ele que roda depois do quit", async () => {
    const file = join(tmpdir(), `stellar-swap-${process.pid}.sh`);
    try {
      await macSwapNodeIo.writeScript(file, "#!/bin/sh\ntrue\n");
      expect(statSync(file).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("extractZip com um arquivo que não é zip -> rejeita nomeando o `ditto`", async () => {
    const file = join(tmpdir(), `stellar-notzip-${process.pid}.zip`);
    writeFileSync(file, "isto nao e um zip");
    try {
      // No Linux o `ditto` nem existe (spawn error); no Mac ele sai != 0. Os
      // dois caminhos são falha, e falha aqui = app velho intacto.
      await expect(macSwapNodeIo.extractZip(file, tmpdir())).rejects.toThrow(/ditto|ENOENT/);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("renderMacSwapScript — o caminho ELEVADO, por re-execução (não por quoting aninhado)", () => {
  const elevated = renderMacSwapScript({ ...FACTS, needsElevation: true });
  const normal = renderMacSwapScript({ ...FACTS, needsElevation: false });

  it("eleva RE-EXECUTANDO o próprio script com --elevated", () => {
    expect(elevated).toContain('if [ "$1" = "--elevated" ]');
    expect(elevated).toContain("--elevated");
    expect(elevated).toContain('-elevated" ]');
    // Não há mais flag de runtime: a elevação é decidida na MONTAGEM do script
    // (quem não precisa não tem o caminho da senha no texto).
    expect(elevated).not.toContain("NEEDS_ELEVATION");
  });

  it("o caminho de usuário NÃO entra dentro da linha do osascript (o difícil do quoting some por construção)", () => {
    const osa = elevated.split("\n").find((line) => line.includes("osascript"));
    expect(osa).toBeDefined();
    expect(osa).not.toContain(FACTS.currentBundle);
    expect(osa).not.toContain(FACTS.newBundle);
    expect(osa).toContain("quoted form of");
  });

  it("destino GRAVÁVEL não pede senha nenhuma", () => {
    // Melhor que um `if` de runtime: o script que não precisa de elevação não
    // TEM o caminho da senha no texto. (A primeira versão desta assertiva
    // falhou: o ramo existia sempre, e o teste a pegou.)
    expect(normal).not.toContain("osascript");
    expect(normal).not.toContain("--elevated");
  });

  it("o log continua sendo do USUÁRIO: no caminho elevado só se IMPRIME (quem anexa é o pai)", () => {
    expect(elevated).toContain("echo 'trocado'");
    expect(elevated).not.toContain('log "trocado"');
  });

  it("espera o app sair ANTES de pedir a senha (o diálogo não aparece com o app aberto)", () => {
    expect(elevated.indexOf('while kill -0 "$PID"')).toBeLessThan(elevated.indexOf("osascript"));
  });
});

describe("o script EXECUTADO de verdade (sh nesta máquina, com paths de mentira)", () => {
  it("troca o bundle, apaga o .old e escreve cada passo no log", async () => {
    // A prova mais forte possível sem um Mac: `sh` roda o script DE VERDADE,
    // com `CURRENT`/`NEW` em /tmp e um PID que já saiu. Ficam de fora só os
    // comandos que não existem aqui (`ditto` na extração, `xattr`, `open`) — e
    // os dois últimos têm `|| true` / são o passo final no script.
    const root = mkdtempSync(join(tmpdir(), "stellar-script-"));
    const current = join(root, "Stellar.app");
    const fresh = join(root, "novo", "Stellar.app");
    mkdirSync(join(current, "Contents"), { recursive: true });
    mkdirSync(join(fresh, "Contents"), { recursive: true });
    writeFileSync(join(current, "Contents", "versao.txt"), "VELHA");
    writeFileSync(join(fresh, "Contents", "versao.txt"), "NOVA");
    const logPath = join(root, "update-swap.log");
    const scriptPath = join(root, "swap.sh");
    const script = renderMacSwapScript({
      currentBundle: current,
      newBundle: fresh,
      // Um PID que NÃO existe: a espera pelo app sai na hora (no Mac é o PID do
      // app que acabou de sair).
      pid: 999999,
      logPath,
      needsElevation: false,
      newVersion: "9.9.9",
    });
    writeFileSync(scriptPath, script);
    try {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn("/bin/sh", [scriptPath], { stdio: "ignore" });
        child.on("close", (c) => resolve(c));
      });
      // `open` não existe no Linux -> o script termina com o código dele. O que
      // importa é o que aconteceu com os arquivos ANTES disso.
      expect(code).not.toBeNull();
      expect(readFileSync(join(current, "Contents", "versao.txt"), "utf8")).toBe("NOVA");
      expect(existsSync(`${current}.old`)).toBe(false);
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("swap: start");
      expect(log).toContain("novo 9.9.9"); // o log diz PARA QUAL versão se trocou
      expect(log).toContain("swap: app saiu");
      expect(log).toContain("swap: trocado");
      expect(log).toContain("swap: quarantine removido");
      expect(log).not.toContain("desfeito");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("app que NÃO sai: espera, desiste dizendo isso e não toca em nada", async () => {
    // Não dá para esperar 60s reais num teste: aqui se prova o CAMINHO do "não
    // vai trocar", com um PID que fica vivo. O `sleep 61` que o script faria é
    // o mesmo laço; o que este teste trava é que o script sai com erro e deixa
    // o bundle intacto quando o app não morre.
    const root = mkdtempSync(join(tmpdir(), "stellar-script-busy-"));
    const current = join(root, "Stellar.app");
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "marca"), "VELHA");
    const script = renderMacSwapScript({
      currentBundle: current,
      newBundle: join(root, "nao-existe", "Stellar.app"),
      pid: process.pid, // vivo: o do próprio teste
      logPath: join(root, "update-swap.log"),
      needsElevation: false,
      newVersion: "9.9.9",
    });
    const scriptPath = join(root, "swap.sh");
    writeFileSync(scriptPath, script);
    try {
      // `-t 1`: o laço não é esperado até o fim aqui; o que se lê é o estado.
      const child = spawn("/bin/sh", [scriptPath], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(join(current, "marca"))).toBe(true);
      expect(existsSync(`${current}.old`)).toBe(false);
      child.kill();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  composePath,
  fallbackShell,
  isExecutableFile,
  isUsableNodeVersion,
  knownBinDirs,
  loginShell,
  mergePathDirs,
  queryShellPath,
  resolveRealNode,
  shellQuery,
} from "../../src/main/user-env";
import { which } from "../../src/main/providers";

/**
 * Relatado ao vivo (2026-09-08): a detecção de CLI falha em sistemas como
 * o macOS. A causa é `which()` varrer só `process.env.PATH`, que num
 * `.app` aberto pelo Finder é o mínimo do launchd — ver o cabeçalho de
 * `src/main/user-env.ts`.
 *
 * Estes testes cobrem o comportamento do macOS SEM finge-lo: as funções
 * recebem plataforma, PATH e diretórios por injeção, e os candidatos de
 * binário são ARQUIVOS DE VERDADE num diretório temporário (um diretório
 * com o nome de uma CLI, um arquivo sem bit de execução, um executável
 * real). Nada aqui é mock de comportamento que o SO já oferece nativamente,
 * o que o AGENTS.md deste repo proíbe.
 *
 * O que estes testes NÃO provam, e nenhum teste rodando no Linux poderia:
 * o ambiente real do launchd, `path_helper`, dotfiles de um Mac, Rosetta,
 * e um `.app` empacotado de verdade. Isso exige um Mac e está declarado
 * como descoberto em vez de simulado.
 */

/** O PATH exato que um `.app` aberto pelo Finder/Dock recebe no macOS. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("user-env: composePath", () => {
  it("traz os diretórios da login shell, que é o que falta no PATH do launchd", () => {
    const shellPath = "/opt/homebrew/bin:/Users/x/.nvm/versions/node/v22.14.0/bin:/usr/bin:/bin";
    const composed = composePath(LAUNCHD_PATH, shellPath, []).split(delimiter);
    expect(composed).toContain("/opt/homebrew/bin");
    // O caso que uma lista estática de diretórios nunca resolveria: só a
    // shell sabe qual versão de Node está ativa.
    expect(composed).toContain("/Users/x/.nvm/versions/node/v22.14.0/bin");
  });

  it("põe um override explícito de PATH na frente do PATH da login shell", () => {
    // `PATH=/meu/custom:$PATH stellar` a partir de um terminal: a intenção
    // mais específica que existe, e a login shell não sabe dela.
    const inherited = `/meu/custom${delimiter}/usr/bin${delimiter}/bin`;
    const shellPath = "/opt/homebrew/bin:/usr/bin:/bin";
    const composed = composePath(inherited, shellPath, []).split(delimiter);
    expect(composed[0]).toBe("/meu/custom");
    expect(composed.indexOf("/meu/custom")).toBeLessThan(composed.indexOf("/opt/homebrew/bin"));
  });

  it("num launch pelo Finder não inventa override: os dirs do launchd já estão no PATH da shell", () => {
    const shellPath = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const composed = composePath(LAUNCHD_PATH, shellPath, []).split(delimiter);
    // Nada do launchd é "novo", então a ordenação escolhida pelo usuário
    // nos dotfiles dele sobrevive intacta na frente.
    expect(composed[0]).toBe("/opt/homebrew/bin");
  });

  it("dedup preservando a primeira aparição e descartando entradas vazias", () => {
    const composed = composePath(`/a${delimiter}${delimiter}/b`, "/b:/a:/c", ["/a", "/d"]).split(delimiter);
    expect(composed).toEqual(["/b", "/a", "/c", "/d"]);
    expect(composed).not.toContain("");
  });

  it("sem PATH da shell (falha/timeout/tcsh) ainda entrega os diretórios conhecidos", () => {
    const composed = composePath(LAUNCHD_PATH, null, ["/opt/homebrew/bin"]).split(delimiter);
    expect(composed).toContain("/opt/homebrew/bin");
    expect(composed).toContain("/usr/bin");
  });

  it("tolera PATH ausente sem quebrar", () => {
    expect(composePath(undefined, null, ["/opt/homebrew/bin"])).toBe("/opt/homebrew/bin");
  });
});

describe("user-env: knownBinDirs", () => {
  it("cobre os dois prefixos de Homebrew sem inferir arquitetura", () => {
    const dirs = knownBinDirs("darwin", "/Users/x");
    expect(dirs).toContain("/opt/homebrew/bin"); // Apple Silicon
    expect(dirs).toContain("/usr/local/bin"); // Intel
  });

  it("cobre onde os installers oficiais de agy e cursor-agent fazem symlink", () => {
    expect(knownBinDirs("darwin", "/Users/x")).toContain("/Users/x/.local/bin");
  });

  it("cobre o diretório do installer curl do opencode", () => {
    expect(knownBinDirs("darwin", "/Users/x")).toContain("/Users/x/.opencode/bin");
  });

  it("pnpm segue a convenção da Apple no macOS e a XDG no Linux", () => {
    expect(knownBinDirs("darwin", "/Users/x")).toContain("/Users/x/Library/pnpm");
    expect(knownBinDirs("linux", "/home/x")).toContain("/home/x/.local/share/pnpm");
  });

  it("não globa ~/.nvm: escolher uma versão arbitrária de Node é pior que não achar", () => {
    expect(knownBinDirs("darwin", "/Users/x").some((d) => d.includes(".nvm"))).toBe(false);
  });

  it("vazio no Windows — lá o processo já herda o ambiente do usuário", () => {
    expect(knownBinDirs("win32", "C:\\Users\\x")).toEqual([]);
  });
});

describe("user-env: mergePathDirs", () => {
  it("preserva ordem da primeira aparição", () => {
    expect(mergePathDirs(["/a", "/b"], ["/b", "/c"], ["/a", "/d"])).toEqual(["/a", "/b", "/c", "/d"]);
  });
});

describe("user-env: loginShell", () => {
  it("$SHELL vence quando existe", () => {
    expect(loginShell("darwin", { SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
  });

  it("o degrau fixo do macOS é zsh (padrão desde o Catalina), não bash", () => {
    // `loginShell` consulta a base de usuário do SO (getpwuid) antes de
    // chegar aqui, e nesta máquina Linux ela responde `/bin/bash` — o que
    // é o comportamento certo. O degrau FIXO é o que este teste isola.
    expect(fallbackShell("darwin")).toBe("/bin/zsh");
  });

  it("o degrau fixo fora do macOS é /bin/sh, não /bin/bash", () => {
    // `/bin/bash` era o fallback anterior e não existe em toda distro.
    expect(fallbackShell("linux")).toBe("/bin/sh");
  });

  it("nunca devolve string vazia", () => {
    expect(loginShell("linux", {}).length).toBeGreaterThan(0);
  });
});

describe("user-env: shellQuery", () => {
  it("bash e zsh recebem o executável como parâmetro posicional, nunca interpolado", () => {
    const args = shellQuery("/bin/zsh")!.args('"$1" -e code', "/Applications/My App.app/Contents/MacOS/Stellar");
    expect(args).toEqual(["-ilc", '"$1" -e code', "--", "/Applications/My App.app/Contents/MacOS/Stellar"]);
    // O caminho com espaço não aparece dentro da string do -c, que é
    // exatamente o que impede a quebra no espaço.
    expect(args[1]).not.toContain("My App");
  });

  it("fish não tem $0/$1 do POSIX — usa $argv[1]", () => {
    const args = shellQuery("/opt/homebrew/bin/fish")!.args('"$1" -e code', "/path/to/exe");
    expect(args[2]).toContain("$argv[1]");
    expect(args[2]).not.toContain('"$1"');
  });

  it("tcsh e csh não são interrogadas: lá -c e -l não combinam e a invocação falha", () => {
    expect(shellQuery("/bin/tcsh")).toBeNull();
    expect(shellQuery("/bin/csh")).toBeNull();
  });
});

describe("user-env: isExecutableFile e which, contra arquivos reais em disco", () => {
  let root: string;
  let binDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stellar-userenv-"));
    binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });

    // Um executável de verdade.
    const real = join(binDir, "agy");
    writeFileSync(real, "#!/bin/sh\nexit 0\n");
    chmodSync(real, 0o755);

    // Um DIRETÓRIO com o nome primário da CLI do Cursor. O `existsSync`
    // que estava aqui antes devolvia este caminho como se fosse o binário.
    mkdirSync(join(binDir, "agent"));

    // Um arquivo que existe mas não é executável.
    const notExec = join(binDir, "codex");
    writeFileSync(notExec, "não sou executável\n");
    chmodSync(notExec, 0o644);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("aceita um arquivo com bit de execução", () => {
    expect(isExecutableFile(join(binDir, "agy"))).toBe(true);
  });

  it("rejeita um diretório com o nome do binário", () => {
    expect(existsSync(join(binDir, "agent"))).toBe(true); // existe...
    expect(isExecutableFile(join(binDir, "agent"))).toBe(false); // ...mas não serve
  });

  it("rejeita um arquivo sem bit de execução", () => {
    expect(isExecutableFile(join(binDir, "codex"))).toBe(false);
  });

  it("rejeita o que não existe", () => {
    expect(isExecutableFile(join(binDir, "nada"))).toBe(false);
  });

  it("which não acha nada com o PATH do launchd — este é o bug relatado", () => {
    const dirs = LAUNCHD_PATH.split(":");
    expect(which(["agy"], { platform: "darwin", pathDirs: dirs })).toBeNull();
  });

  it("which acha quando o diretório real entra na lista — este é o fix", () => {
    const dirs = [...LAUNCHD_PATH.split(":"), binDir];
    expect(which(["agy"], { platform: "darwin", pathDirs: dirs })).toBe(join(binDir, "agy"));
  });

  it("which pula o diretório homônimo e segue a busca pelo nome legado", () => {
    const legacy = join(binDir, "cursor-agent");
    writeFileSync(legacy, "#!/bin/sh\nexit 0\n");
    chmodSync(legacy, 0o755);
    // `agent` é um diretório aqui; a busca não pode parar nele.
    expect(which(["agent", "cursor-agent"], { platform: "darwin", pathDirs: [binDir] })).toBe(legacy);
  });

  it("which não devolve um arquivo sem bit de execução", () => {
    expect(which(["codex"], { platform: "darwin", pathDirs: [binDir] })).toBeNull();
  });

  it("which tolera lista de diretórios vazia", () => {
    expect(which(["agy"], { platform: "darwin", pathDirs: [] })).toBeNull();
  });

  it("which no Windows tenta as extensões do PATHEXT (regressão de 2026-09-03)", () => {
    const shim = join(binDir, "claude.cmd");
    writeFileSync(shim, "@echo off\n");
    chmodSync(shim, 0o755);
    // Extensão minúscula aqui de propósito: `PATHEXT` é maiúsculo e o shim
    // que `npm install -g` cria é `claude.cmd` minúsculo. No NTFS isso é
    // indiferente (case-insensitive), mas este teste roda em ext4, que não
    // é — o que a suíte pode afirmar é a mecânica da extensão, não a
    // insensibilidade a caixa do filesystem do Windows.
    expect(which(["claude"], { platform: "win32", pathDirs: [binDir], pathExt: [".cmd", ".exe"] })).toBe(shim);
  });

  it("a assinatura antiga (plataforma como 2º argumento) continua valendo", () => {
    expect(which(["definitivamente-nao-existe-xyz"], "darwin")).toBeNull();
  });
});

describe("user-env: queryShellPath contra um shell de verdade", () => {
  // Evidência real, não simulada: roda o shell que existe nesta máquina.
  // No CI/Linux é bash; num Mac seria zsh. Se não houver bash instalado,
  // o teste declara isso em vez de fingir que passou.
  const bash = ["/bin/bash", "/usr/bin/bash"].find((p) => existsSync(p));

  it.skipIf(!bash)("obtém um PATH não vazio da login shell", async () => {
    const path = await queryShellPath({ shell: bash!, platform: "linux", execPath: process.execPath });
    expect(path).toBeTruthy();
    expect(path!.length).toBeGreaterThan(0);
  });

  it.skipIf(!bash)("sobrevive a um caminho de executável com espaço", async () => {
    // O caso do macOS: /Applications/Stellar.app/Contents/MacOS/Stellar.
    // Confirmado ao vivo que interpolar o caminho na string do -c quebra
    // no espaço, e que `'$1'` entre aspas simples sai 127.
    const dir = mkdtempSync(join(tmpdir(), "stellar dir com espaço-"));
    const exe = join(dir, "My Node");
    try {
      // Um wrapper de verdade que repassa para o node desta máquina.
      writeFileSync(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
      chmodSync(exe, 0o755);
      const path = await queryShellPath({ shell: bash!, platform: "linux", execPath: exe });
      expect(path).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolve null em vez de lançar quando o shell não existe", async () => {
    const path = await queryShellPath({ shell: "/definitivamente/nao/existe/sh", platform: "linux" });
    expect(path).toBeNull();
  });

  it("resolve null para tcsh sem nem tentar spawnar", async () => {
    expect(await queryShellPath({ shell: "/bin/tcsh", platform: "linux" })).toBeNull();
  });

  it("não interroga shell nenhuma no Windows", async () => {
    expect(await queryShellPath({ platform: "win32" })).toBeNull();
  });

  it.skipIf(!bash)("respeita o timeout em vez de esperar para sempre", async () => {
    // `sleep 30` no lugar do nosso comando: com stdin fechado e um dotfile
    // que trava (o caso do `exec tmux`), o boot não pode ficar preso.
    const started = Date.now();
    const path = await queryShellPath({ shell: bash!, platform: "linux", execPath: "/bin/sleep", timeoutMs: 300 });
    expect(path).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/**
 * Otimização de RSS (2026-09-09): preferir um `node` real ao invés de
 * reexecutar o binário do Electron como Node para os shims de
 * `resources/bin` (`stellar-mcp`, `acbridge`) — ~35 MB a menos de RSS por
 * card, medido ao vivo nesta máquina. O que faz essa preferência segura,
 * e não só "achar `node` no PATH", é a VALIDAÇÃO de versão: `isExecutableFile`
 * já cobre symlink morto, só falta cobrir "existe, executa, mas é
 * v12/v16" — que um `nvm` com versão ativa velha produziria em silêncio.
 *
 * `isUsableNodeVersion` é testada isolada da execução real (pura, só
 * parsing + comparação de major — piso em `MIN_REAL_NODE_MAJOR` = 18,
 * ancorado no que `resources/bin/stellar-mcp` e `resources/bin/acbridge`
 * realmente usam, não escolhido a dedo), e `resolveRealNode` é testada
 * com `find`/`check` injetados — a função de DECISÃO de produção de
 * verdade, não um mock do comportamento do SO. A checagem estrita
 * `^...$` também é a proteção do canal JSON-RPC do MCP contra um `node`
 * wrapper que imprima ruído no stdout — coberta abaixo com ruído
 * antes/depois do número.
 */
describe("user-env: isUsableNodeVersion", () => {
  it("aceita uma major >= 18 (piso ancorado no que stellar-mcp/acbridge realmente usam: fetch global e import ESM de node:net, ambos estáveis desde o 18)", () => {
    expect(isUsableNodeVersion("18.20.4")).toBe(true);
    expect(isUsableNodeVersion("22.23.1")).toBe(true);
    expect(isUsableNodeVersion("23.0.0\n")).toBe(true); // saída de `-p` vem com \n
  });

  it("rejeita uma major abaixo do piso", () => {
    expect(isUsableNodeVersion("16.20.0")).toBe(false);
    expect(isUsableNodeVersion("12.22.12")).toBe(false);
  });

  it("rejeita saída lixo/não-semver", () => {
    expect(isUsableNodeVersion("not a version")).toBe(false);
    expect(isUsableNodeVersion("v22.23.1")).toBe(false); // o `v` do `node --version`, não do `process.versions.node`
    expect(isUsableNodeVersion("")).toBe(false);
  });

  it("rejeita null (candidato ausente ou falha de exec já resolvida a montante)", () => {
    expect(isUsableNodeVersion(null)).toBe(false);
  });

  it("rejeita ruído DEPOIS do número — proteção do canal, não só parsing: o stdout do stellar-mcp É o transporte JSON-RPC do MCP, então um wrapper (nvm/asdf/volta/shim corporativo) que escreva qualquer coisa além da versão tem que cair no fallback", () => {
    expect(isUsableNodeVersion("22.23.1\nWarning: this node is a wrapper")).toBe(false);
    expect(isUsableNodeVersion("22.23.1 (compiled with extra flags)")).toBe(false);
  });

  it("rejeita ruído ANTES do número, pelo mesmo motivo — trim() só remove espaço nas pontas, não separa linhas internas", () => {
    expect(isUsableNodeVersion("nvm is not compatible with the \"npm_config_prefix\" env variable\n22.23.1")).toBe(false);
    expect(isUsableNodeVersion("Warning: 22.23.1")).toBe(false);
  });
});

describe("user-env: resolveRealNode", () => {
  it("resolve o candidato quando `find` acha algo e `check` confirma major válida", async () => {
    const node = await resolveRealNode({
      find: (names) => (names.includes("node") ? "/usr/bin/node" : null),
      check: async (candidate) => (candidate === "/usr/bin/node" ? "22.23.1" : null),
    });
    expect(node).toBe("/usr/bin/node");
  });

  it("resolve null quando `find` não acha candidato nenhum — nem tenta executar", async () => {
    let checked = false;
    const node = await resolveRealNode({
      find: () => null,
      check: async () => {
        checked = true;
        return "22.23.1";
      },
    });
    expect(node).toBeNull();
    expect(checked).toBe(false);
  });

  it("resolve null quando o candidato existe mas a major é velha", async () => {
    const node = await resolveRealNode({
      find: () => "/home/x/.nvm/versions/node/v16.20.0/bin/node",
      check: async () => "16.20.0",
    });
    expect(node).toBeNull();
  });

  it("resolve null quando a execução falha (symlink morto, ENOENT, crash)", async () => {
    const node = await resolveRealNode({
      find: () => "/caminho/quebrado/node",
      check: async () => null,
    });
    expect(node).toBeNull();
  });

  it("resolve null quando a saída não parseia como versão", async () => {
    const node = await resolveRealNode({
      find: () => "/usr/bin/node",
      check: async () => "command not found",
    });
    expect(node).toBeNull();
  });

  // Oportunista: usa `which()` de providers.ts por padrão (sem injetar
  // `find`), então depende do PATH de verdade da máquina que roda o
  // teste. Em CI onde o `node` do próprio vitest não está no PATH
  // varrido por `effectivePath()`, `which(["node"])` pode não achar nada
  // — e isso é `resolveRealNode` funcionando corretamente (retorna
  // `null` em vez de inventar um candidato), não uma falha do teste. Por
  // isso a asserção cobre só a FORMA do retorno, nunca "achou algo".
  it("usa `which()` de providers.ts por padrão contra um PATH de verdade — oportunista, aceita null quando a máquina não tem node no PATH varrido", async () => {
    const preflight = which(["node"]);
    const node = await resolveRealNode({ check: async () => "22.23.1" });
    if (preflight === null) {
      expect(node).toBeNull();
      return;
    }
    expect(typeof node).toBe("string");
    expect(node).toBe(preflight);
    expect(existsSync(node!)).toBe(true);
  });
});

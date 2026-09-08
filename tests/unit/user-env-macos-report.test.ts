import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { composePath, isExecutableFile, knownBinDirs } from "../../src/main/user-env";
import { which } from "../../src/main/providers";

/**
 * Depoimento real de um usuário de macOS (Stellar.app 0.5.0, macOS 26.6.2),
 * antes da correção de PATH: o card do provider `claude` falhava com
 * "claude não encontrado no PATH" enquanto um card `bash` na MESMA máquina
 * resolvia `claude` sem problema.
 *
 * Este teste reproduz o ambiente dele com precisão, incluindo os dois
 * detalhes que o diferenciam dos casos já cobertos:
 *
 *  1. `claude` instalado pelo instalador nativo da Anthropic é um
 *     SYMLINK em `~/.local/bin/claude` apontando para
 *     `~/.local/share/claude/versions/<versão>/claude`. Se a checagem de
 *     candidato não atravessar o link, a correção não serve para ele.
 *  2. O PATH de um app GUI no macOS vem do `path_helper` (`/etc/paths` +
 *     `/etc/paths.d/*`), não do launchd puro nem dos dotfiles. Ele
 *     CONTÉM `/opt/homebrew/bin` (a Homebrew injeta um `paths.d`), o que
 *     explica por que CLIs de Homebrew às vezes funcionavam e as de
 *     diretório de usuário nunca.
 */

/** PATH real de um app GUI no macOS com Homebrew instalado. */
const PATH_HELPER_GUI_PATH = "/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";

describe("depoimento de macOS: claude por symlink em ~/.local/bin", () => {
  let home: string;
  let localBin: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "stellar-machome-"));
    localBin = join(home, ".local", "bin");
    const versionDir = join(home, ".local", "share", "claude", "versions", "1.2.3");
    mkdirSync(localBin, { recursive: true });
    mkdirSync(versionDir, { recursive: true });

    // O binário real, onde o instalador nativo o coloca.
    const realBinary = join(versionDir, "claude");
    writeFileSync(realBinary, "#!/bin/sh\nexit 0\n");
    chmodSync(realBinary, 0o755);

    // O symlink que fica no PATH — é isto que `which` encontra.
    symlinkSync(realBinary, join(localBin, "claude"));
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("isExecutableFile atravessa o symlink até o binário real", () => {
    expect(isExecutableFile(join(localBin, "claude"))).toBe(true);
  });

  it("reproduz a falha relatada: com o PATH do path_helper, claude é invisível", () => {
    const dirs = PATH_HELPER_GUI_PATH.split(":");
    expect(which(["claude"], { platform: "darwin", pathDirs: dirs })).toBeNull();
  });

  it("~/.local/bin está entre os diretórios conhecidos, então o snapshot inicial já resolve", () => {
    // Nem precisa da perna da login shell: o snapshot síncrono, que existe
    // desde o import, já cobre o caso deste usuário.
    expect(knownBinDirs("darwin", home)).toContain(localBin);
    const effective = composePath(PATH_HELPER_GUI_PATH, null, knownBinDirs("darwin", home));
    const found = which(["claude"], { platform: "darwin", pathDirs: effective.split(delimiter) });
    expect(found).toBe(join(localBin, "claude"));
  });

  it("um symlink QUEBRADO não é reportado como instalado", () => {
    // O instalador nativo troca de versão mexendo no symlink; um link
    // apontando para uma versão já removida não pode contar como achado.
    const orphanBin = join(home, ".local", "orphan");
    mkdirSync(orphanBin, { recursive: true });
    symlinkSync(join(home, ".local", "share", "claude", "versions", "9.9.9", "claude"), join(orphanBin, "claude"));
    expect(isExecutableFile(join(orphanBin, "claude"))).toBe(false);
    expect(which(["claude"], { platform: "darwin", pathDirs: [orphanBin] })).toBeNull();
  });

  it("cobre também os diretórios que o usuário nomeou por conta própria", () => {
    // Ele listou ~/.local/bin, ~/.npm-global/bin, ~/.cargo/bin e ~/go/bin.
    const dirs = knownBinDirs("darwin", home);
    for (const rel of [[".local", "bin"], [".npm-global", "bin"], [".cargo", "bin"], ["go", "bin"]]) {
      expect(dirs).toContain(join(home, ...rel));
    }
  });

  it("o PATH do path_helper explica o sintoma parcial: Homebrew funcionava, ~/.local/bin não", () => {
    const dirs = PATH_HELPER_GUI_PATH.split(":");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).not.toContain(localBin);
  });
});

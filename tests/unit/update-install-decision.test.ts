import { describe, it, expect } from "vitest";
import { decideUpdateInstall } from "../../src/main/update-install-decision";

/**
 * "HÁ ATUALIZAÇÃO" NÃO É "DÁ PARA INSTALAR" (task 5fb0c21b, item 2).
 *
 * MEDIDO na lib instalada (electron-updater 6.8.9): no Linux o updater é
 * escolhido por `resources/package-type` (escrito pelo target fpm); sem esse
 * arquivo cai em `AppImageUpdater`, cujo `isUpdaterActive()` devolve FALSE sem
 * `process.env.APPIMAGE` — o updater fica DESLIGADO, nem checa. E quando o
 * `package-type` existe, `RpmUpdater.doInstall` roda `dnf install` via
 * `runCommandWithSudoIfNeeded` (pkexec/sudo): instala, mas EXIGE ELEVAÇÃO.
 *
 * O caso do dono, medido nesta máquina: `rpm -qf /opt/Stellar/stellar` ->
 * `stellar-0.8.2-1.x86_64`, e em `/opt/Stellar/resources/` não há nem
 * `package-type` nem `app-update.yml`. A resposta honesta para ele é "baixe o
 * rpm", não um botão que baixa e falha.
 */
describe("decideUpdateInstall — o formato da instalação decide", () => {
  const ownerInstall = {
    platform: "linux",
    isPackaged: true,
    appImageEnv: false,
    packageType: null,
  };

  it("O CASO DO DONO: rpm instalado SEM `package-type` -> não se atualiza sozinho, e a mensagem diz o que fazer", () => {
    const state = decideUpdateInstall(ownerInstall);
    expect(state.canInstall).toBe(false);
    if (state.canInstall) throw new Error("unreachable");
    expect(state.reason).toBe("not-a-package");
    expect(state.message).toContain("baixe a versão nova");
  });

  it("AppImage (APPIMAGE no ambiente) -> instala sem elevação", () => {
    expect(decideUpdateInstall({ ...ownerInstall, appImageEnv: true })).toEqual({
      canInstall: true,
      how: "appimage",
      needsElevation: false,
    });
  });

  it("pacote com `package-type` -> instala, e a ELEVAÇÃO é declarada (medido: pkexec/sudo na lib)", () => {
    expect(decideUpdateInstall({ ...ownerInstall, packageType: "rpm" })).toEqual({
      canInstall: true,
      how: "rpm",
      needsElevation: true,
    });
    expect(decideUpdateInstall({ ...ownerInstall, packageType: "deb" })).toEqual({
      canInstall: true,
      how: "deb",
      needsElevation: true,
    });
  });

  it("`package-type` com valor que a lib não conhece -> mesma verdade do sem-arquivo (não inventa caminho)", () => {
    expect(decideUpdateInstall({ ...ownerInstall, packageType: "pacman" }).canInstall).toBe(false);
    expect(decideUpdateInstall({ ...ownerInstall, packageType: "lixo" }).canInstall).toBe(false);
  });

  it("DARWIN -> `mac-swap` (medido: a lib delega ao Squirrel, que exige bundle assinado)", () => {
    // Não é "appimage" emprestado: no mac a troca é NOSSA (baixar, conferir
    // sha512, extrair com ditto, trocar por script destacado).
    expect(
      decideUpdateInstall({
        platform: "darwin",
        isPackaged: true,
        appImageEnv: false,
        packageType: null,
      }),
    ).toEqual({
      canInstall: true,
      how: "mac-swap",
      needsElevation: false,
    });
  });

  it("WINDOWS -> `nsis` e sem elevação (NSIS roda sem assinatura; não muda nesta task)", () => {
    expect(
      decideUpdateInstall({
        platform: "win32",
        isPackaged: true,
        appImageEnv: false,
        packageType: null,
      }),
    ).toEqual({
      canInstall: true,
      how: "nsis",
      needsElevation: false,
    });
  });

  it("build de desenvolvimento não finge que atualiza", () => {
    const state = decideUpdateInstall({ ...ownerInstall, isPackaged: false, appImageEnv: true });
    expect(state.canInstall).toBe(false);
    if (state.canInstall) throw new Error("unreachable");
    expect(state.reason).toBe("dev-build");
  });
});

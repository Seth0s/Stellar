/**
 * DÁ PARA INSTALAR A ATUALIZAÇÃO NESTA INSTALAÇÃO? (task 5fb0c21b)
 *
 * A pergunta separa de "existe feed?": o feed pode existir e a instalação
 * automática ainda ser impossível. As duas coisas viram estados distintos e a
 * UI diz o que é verdade em cada caso.
 *
 * MEDIDO na lib instalada (`node_modules/electron-updater@6.8.9`), porque o
 * comportamento por formato não é documentado de forma confiável:
 *
 *   - `out/main.js` escolhe o updater pela PLATAFORMA e, no Linux, por um
 *     arquivo `resources/package-type` (escrito pelo target fpm do
 *     electron-builder — `app-builder-lib/out/targets/FpmTarget.js:140`):
 *     `rpm` -> `RpmUpdater`, `deb` -> `DebUpdater`, `pacman` -> `PacmanUpdater`;
 *     SEM esse arquivo cai em `AppImageUpdater`.
 *   - `AppImageUpdater.isUpdaterActive()` devolve **false** quando
 *     `process.env.APPIMAGE` é null (com o log "APPIMAGE env is not defined,
 *     current application is not an AppImage"). Ou seja: numa instalação que
 *     não é AppImage e não tem `package-type`, o updater não fica
 *     "incapaz de instalar" — ele fica DESLIGADO, nem checa.
 *   - `RpmUpdater.doInstall` roda `zypper|dnf|yum|rpm install <arquivo>` via
 *     `runCommandWithSudoIfNeeded` (`LinuxUpdater.js:34`), que usa
 *     `determineSudoCommand()` (pkexec/sudo/kdesudo/gksudo) — INSTALA, mas
 *     exige ELEVAÇÃO: um app aberto pelo launcher do desktop depende de um
 *     agente polkit gráfico para o pkexec, e de um terminal para o sudo.
 *
 * O CASO DO DONO, medido nesta máquina: `rpm -qf /opt/Stellar/stellar` ->
 * `stellar-0.8.2-1.x86_64` (é RPM de verdade), e em `/opt/Stellar/resources/`
 * NÃO existem nem `package-type` nem `app-update.yml`. Consequência: a
 * instalação DELE não checa e não instala — e nenhuma versão futura conserta
 * isso por dentro, porque o arquivo que faltaria é lido pela build ANTIGA. A
 * verdade para ele é "baixe o rpm novo", não um botão que falha.
 */
export type UpdateInstallState =
  | {
      canInstall: true;
      /**
       * COMO esta instalação troca o binário. `mac-swap` não é detalhe de
       * rótulo: no darwin NÃO é a lib que instala (ver `mac-update-swap.ts`).
       */
      how: "appimage" | "rpm" | "deb" | "nsis" | "mac-swap";
      /** `true` quando a instalação passa por elevação (pkexec/sudo). */
      needsElevation: boolean;
    }
  | { canInstall: false; reason: "not-a-package" | "dev-build" | "not-linux"; message: string };

const PACKAGE_TYPE_TO_HOW: Record<string, "rpm" | "deb"> = { rpm: "rpm", deb: "deb" };

/**
 * Pura. `packageType` é o conteúdo de `resources/package-type` (ou `null`).
 * @param appImageEnv `process.env.APPIMAGE` presente?
 */
export function decideUpdateInstall(input: {
  platform: string;
  isPackaged: boolean;
  appImageEnv: boolean;
  packageType: string | null;
}): UpdateInstallState {
  if (!input.isPackaged) {
    return {
      canInstall: false,
      reason: "dev-build",
      message: "Build de desenvolvimento: atualização automática não se aplica.",
    };
  }
  if (input.platform === "darwin") {
    // MAC: MEDIDO (task d0fef4e7) — a lib NÃO instala aqui. O `MacUpdater`
    // entrega o zip a um servidor local e chama `nativeUpdater.quitAndInstall()`
    // (`out/MacUpdater.js:211-233`): quem aplica é o Squirrel.Mac/ShipIt, que
    // exige bundle ASSINADO — e o build desta casa sai sem assinatura
    // (`CSC_IDENTITY_AUTO_DISCOVERY=false`). O caminho próprio é a TROCA que
    // fazemos por conta própria (`mac-update-swap.ts`). Antes disto a resposta
    // era `how: "appimage"` para darwin: um rótulo emprestado, sem medição.
    return { canInstall: true, how: "mac-swap", needsElevation: false };
  }
  if (input.platform === "win32") {
    // Windows NÃO muda nesta task: o NSIS roda sem assinatura, então o caminho
    // da lib segue valendo. O rótulo é `nsis` — antes dizia `rpm`, que era um
    // nome errado para o mesmo veredito.
    return { canInstall: true, how: "nsis", needsElevation: false };
  }
  if (input.platform !== "linux") {
    return {
      canInstall: false,
      reason: "not-linux",
      message: `Plataforma ${input.platform} não é suportada para atualização automática.`,
    };
  }
  if (input.appImageEnv) return { canInstall: true, how: "appimage", needsElevation: false };
  const how =
    input.packageType === null ? null : PACKAGE_TYPE_TO_HOW[input.packageType.trim().toLowerCase()];
  if (how === undefined || how === null) {
    // Exatamente o caso do dono: sem `package-type`, a lib escolhe o
    // AppImageUpdater e DESLIGA (isUpdaterActive false). Dizer "baixe" aqui não
    // é preguiça de UI — é o que a instalação instalada permite.
    return {
      canInstall: false,
      reason: "not-a-package",
      message:
        "Esta instalação não se atualiza sozinha (não é AppImage nem um pacote com `package-type`) — baixe a versão nova pelo site das releases.",
    };
  }
  return { canInstall: true, how, needsElevation: true };
}

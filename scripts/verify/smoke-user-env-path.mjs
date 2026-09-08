// Relatado ao vivo (2026-09-08): "o sistema de path atual tanto para
// detectar as instalações do cli e para verificação é ineficiente em
// sistemas como mac". A causa raiz está no cabeçalho de
// `src/main/user-env.ts`: um `.app` Electron aberto pelo Finder/Dock no
// macOS não herda o ambiente da login shell, herda o do launchd, que é
// `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Como `providers.ts::which()` era
// uma varredura pura de `process.env.PATH`, toda CLI de agente instalada
// pelo usuário ficava invisível e o Topbar oferecia instalar o que já
// existia.
//
// Este smoke NÃO finge ser um macOS — fingir seria mock de comportamento
// que o SO oferece nativamente, o que o AGENTS.md deste repo proíbe. Ele
// reproduz a CONDIÇÃO que causa a falha, que é portável: o app real sobe
// com exatamente o PATH que o launchd daria, e as CLIs de agente desta
// máquina moram fora dele. Nenhum binário é criado, movido ou mockado;
// nenhum arquivo do usuário é tocado.
//
// O que se prova aqui, com o app de verdade: a checagem de
// disponibilidade acha as CLIs mesmo sob o PATH mínimo, e o aviso do
// Topbar não mente. Confirmado que este smoke FALHA contra o código
// anterior — revertendo `effectivePath()` para `process.env.PATH`, as
// cinco CLIs instaladas voltam a ser reportadas como ausentes, que é
// exatamente o bug relatado. É isso que o torna um guarda de regressão e
// não só uma observação.
//
// O PATH que chega num PTY foi deliberadamente DEIXADO DE FORA daqui, e
// vale registrar o porquê: o PTY do provider `bash` roda uma login shell,
// que lê os dotfiles do usuário e reconstrói o próprio PATH: a checagem
// passava igual com o código antigo, ou seja, não guardava nada. O que a
// correção faz por um PTY (dar `node`/`git`/`acbridge` a um provider que
// NÃO é shell) não é distinguível assim numa máquina onde os dotfiles já
// consertam o ambiente.
//
// O que este smoke NÃO prova, e nada rodando no Linux poderia: o launchd
// de verdade, `path_helper`, os dotfiles de um Mac e um `.app`
// empacotado. Isso exige um Mac, e fica declarado como descoberto.
import { execFileSync } from "node:child_process";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-user-env-path-${CDP_PORT}`, import.meta.url).pathname;

/** O PATH exato que um app aberto pelo Finder/Dock recebe no macOS. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Onde as CLIs de agente realmente estão nesta máquina — descoberto, não
 * assumido. Serve para escolher um diretório que comprovadamente está
 * FORA do PATH mínimo e que a recuperação precisa alcançar. */
function realCliDir() {
  for (const name of ["claude", "codex", "agy", "agent", "opencode"]) {
    try {
      const p = execFileSync("which", [name], { encoding: "utf8" }).trim();
      if (p) return p.slice(0, p.lastIndexOf("/"));
    } catch {
      // não instalada nesta máquina — tenta a próxima.
    }
  }
  return null;
}

const cliDir = realCliDir();
if (!cliDir) {
  console.log("SKIP smoke-user-env-path: nenhuma CLI de agente instalada nesta máquina, não há o que recuperar");
  process.exit(0);
}
if (LAUNCHD_PATH.split(":").includes(cliDir)) {
  // Se as CLIs morassem em /usr/bin, o PATH mínimo já as acharia e o teste
  // não estaria medindo nada. Declara em vez de passar vazio.
  console.log(`SKIP smoke-user-env-path: CLIs em ${cliDir}, que já está no PATH mínimo — nada a recuperar aqui`);
  process.exit(0);
}

const { check, finish } = makeChecker();
// O app sobe cego: PATH do launchd, e mais nada. É a condição da falha.
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, extraEnv: { PATH: LAUNCHD_PATH } });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "User Env PATH Teste");
  // A perna da login shell é assíncrona por desenho (ver user-env.ts) e o
  // renderer refaz a checagem quando ela chega. Espera o suficiente para
  // ela ter acontecido — o teto no produto é 5s.
  await new Promise((r) => setTimeout(r, 6000));

  const availability = JSON.parse(
    await page.evalJs(`(async () => JSON.stringify(await window.agents.checkAvailability()))()`),
  );
  const installed = availability.filter((a) => a.installed).map((a) => a.id);

  // A prova central: com o PATH do launchd, o código antigo reportaria
  // TODAS como ausentes, porque nenhuma está em /usr/bin ou /bin.
  check(
    `pelo menos uma CLI de agente é encontrada sob o PATH do launchd (achadas: ${installed.join(", ") || "nenhuma"})`,
    installed.length > 0,
    true,
  );

  // O aviso do Topbar é o sintoma que o usuário vê. Ele não pode listar
  // como ausente algo que está instalado em ${cliDir}.
  const warnVisible = await page.evalJs(`!!document.querySelector('.topbar-agents-warn')`);
  const missingIds = availability.filter((a) => !a.installed).map((a) => a.id);
  const reallyMissing = missingIds.filter((id) => {
    const names = { claude: ["claude"], codex: ["codex"], cursor: ["agent", "cursor-agent"], antigravity: ["agy"], opencode: ["opencode"] }[id] ?? [];
    return !names.some((n) => {
      try {
        return !!execFileSync("which", [n], { encoding: "utf8" }).trim();
      } catch {
        return false;
      }
    });
  });
  check(
    `nenhuma CLI instalada é reportada como ausente (reportadas ausentes: ${missingIds.join(", ") || "nenhuma"}; ausentes de verdade: ${reallyMissing.join(", ") || "nenhuma"})`,
    missingIds.length === reallyMissing.length,
    true,
  );
  check(
    "o badge de aviso só aparece se algo está genuinamente faltando",
    warnVisible === reallyMissing.length > 0,
    true,
  );

} finally {
  await stopApp(app);
}
finish();

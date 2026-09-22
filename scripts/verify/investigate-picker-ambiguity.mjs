// PROVA DA CONDIÇÃO DA 0247900f (task 0247900f, parte 1) — mede o que
// `clickProviderInPicker` FAZ quando o casamento por TEXTO é ambíguo.
//
// O helper casa provider pelo texto visível do botão, e resolve o texto por
// `window.agents.checkAvailability()` (o rótulo declarado do provider). Isso
// dá DUAS formas de ambiguidade, e as duas precisam RECUSAR — em vez de
// clicar:
//
//   M1 (fonte x tela divergem): o rótulo que o helper resolve para o `codex`
//      é o MESMO que outro provider exibe na tela. A lista tem dois labels
//      iguais, mas a tela (renderizada antes) mostra um de cada — então o
//      casamento acha UM botão, e esse botão é o do OUTRO provider. É o modo
//      de falha que o revisor descreveu: clica no errado, em silêncio.
//   M2 (a tela tem dois iguais): dois botões com o mesmo texto, e o rótulo
//      pedido é esse texto. Aqui o casamento acha DOIS botões.
//
// Em nenhum dos dois o helper pode clicar: quem escolhe provider é o humano
// (ou o smoke sabe o id), e "primeiro do DOM" não é contrato de nada.
//
// Uso: node scripts/verify/investigate-picker-ambiguity.mjs m1|m2|m3
//
// M3 (a mutação do revisor, por um caminho SUPORTADO): escreve um
// `providers.json` no perfil ISOLADO do run declarando um provider cujo
// RÓTULO é o mesmo do `antigravity`, DEPOIS da tela já ter renderizado — a
// fonte (main, consultada ao vivo pelo helper) passa a ter dois rótulos
// iguais enquanto o DOM ainda mostra um de cada. É a divergência
// "fonte x tela" que faz o casamento por TEXTO apontar para o botão do
// OUTRO provider, em silêncio. Zero efeito fora do perfil descartável.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startApp,
  stopApp,
  connectPage,
  bootIntoFreshSession,
  pickFreePort,
  openTerminalCreatePopover,
  clickProviderInPicker,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/investigate-picker-ambiguity-${CDP_PORT}`, import.meta.url).pathname;
const MODE = (process.argv[2] ?? "m1").toLowerCase();
const SHARED_LABEL = "Antigravity";

async function pickerState(page) {
  return JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        buttons: [...document.querySelectorAll('.provider-picker-btn')].map((b) => b.textContent.trim()),
        activeIndex: [...document.querySelectorAll('.provider-picker-btn')].findIndex((b) => b.classList.contains('active')),
        activeText: document.querySelector('.provider-picker-btn.active')?.textContent?.trim() ?? null,
      })
    `),
  );
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Picker Ambiguity");
  await new Promise((r) => setTimeout(r, 500));
  await openTerminalCreatePopover(page);
  await new Promise((r) => setTimeout(r, 300));

  console.log(`modo=${MODE}; picker antes: ${JSON.stringify(await pickerState(page))}`);

  if (MODE === "m1") {
    // O rótulo que o HELPER resolve para `codex` passa a ser o mesmo que o
    // `antigravity` exibe. A tela não é tocada — é a mutação do revisor
    // (rótulo declarado mudando na fonte), vista do lado do helper.
    await page.evalJs(`
      (() => {
        const real = window.agents.checkAvailability;
        window.agents.checkAvailability = async () => {
          const all = await real();
          return all.map((e) => (e.id === "codex" ? { ...e, label: ${JSON.stringify(SHARED_LABEL)} } : e));
        };
      })()
    `);
    console.log(
      `fonte mutada: labels de codex/antigravity = ${JSON.stringify(
        await page.evalJs(`
          (async () => {
            const all = await window.agents.checkAvailability();
            return JSON.stringify(["codex", "antigravity"].map((id) => all.find((e) => e.id === id)?.label ?? null));
          })()
        `),
      )}`,
    );
    try {
      await clickProviderInPicker(page, "codex");
      const after = await pickerState(page);
      console.log(`RESULTADO: NÃO recusou — clicou. ativo agora = ${JSON.stringify({ index: after.activeIndex, text: after.activeText })} (pedido: codex/label ${JSON.stringify(SHARED_LABEL)})`);
    } catch (err) {
      console.log(`RESULTADO: recusou — ${String(err.message).slice(0, 240)}`);
    }
  } else if (MODE === "m3") {
    // Um provider declarado pelo usuário com o MESMO rótulo do antigravity,
    // escrito no perfil do run DEPOIS da tela renderizada. `checkAvailability`
    // (que o helper consulta ao vivo) passa a ter dois rótulos iguais.
    const spec = {
      id: "clone-antigravity",
      label: SHARED_LABEL,
      binaryNames: ["claude"],
      installCommand: { posix: "npm install -g cline", windows: "npm install -g cline" },
      capacity: {
        role: "agent",
        session: { canImposeSessionId: false, resumeFlag: "--id" },
        systemPrompt: { mechanism: "none" },
        mcp: { mechanism: "none" },
        acbridgeOnPath: true,
        effort: { mechanism: "none", reason: "no-flag" },
        model: { mechanism: "flag", flag: "-m" },
        delivery: { briefMechanism: "positional" },
      },
    };
    writeFileSync(
      join(USER_DATA_DIR, "providers.json"),
      JSON.stringify({ schemaVersion: 1, providers: [spec] }, null, 2),
      "utf8",
    );
    console.log("providers.json escrito no perfil do run (clone com rótulo compartilhado)");

    let sourceLabels = null;
    const sourceDeadline = Date.now() + 15000;
    while (Date.now() < sourceDeadline) {
      sourceLabels = JSON.parse(
        await page.evalJs(`
          (async () => {
            const all = await window.agents.checkAvailability();
            return JSON.stringify({
              clone: all.find((e) => e.id === "clone-antigravity")?.label ?? null,
              antigravity: all.find((e) => e.id === "antigravity")?.label ?? null,
              sharing: all.filter((e) => e.label === ${JSON.stringify(SHARED_LABEL)}).map((e) => e.id),
            });
          })()
        `),
      );
      if (sourceLabels.clone !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`fonte: clone=${JSON.stringify(sourceLabels?.clone)} antigravity=${JSON.stringify(sourceLabels?.antigravity)} compartilhando=${JSON.stringify(sourceLabels?.sharing)}`);
    console.log(`tela (DOM, possivelmente desatualizada): ${JSON.stringify(await pickerState(page))}`);

    try {
      await clickProviderInPicker(page, "clone-antigravity");
      const after = await pickerState(page);
      console.log(`RESULTADO: NÃO recusou — clicou. ativo agora = ${JSON.stringify({ index: after.activeIndex, text: after.activeText })} (pedido: clone-antigravity, rótulo ${JSON.stringify(SHARED_LABEL)})`);
    } catch (err) {
      console.log(`RESULTADO: recusou — ${String(err.message).slice(0, 300)}`);
    }
  } else {
    // Duplica o TEXTO de um botão na tela e pede o rótulo compartilhado:
    // dois casamentos no DOM.
    const mutated = JSON.parse(
      await page.evalJs(`
        (() => {
          const btns = [...document.querySelectorAll('.provider-picker-btn')];
          const target = btns.find((b) => b.textContent.trim() !== ${JSON.stringify(SHARED_LABEL)});
          if (!target) return JSON.stringify(null);
          let span = target.querySelector('span');
          if (!span) return JSON.stringify(null);
          span.textContent = ${JSON.stringify(SHARED_LABEL)};
          return JSON.stringify(btns.map((b) => b.textContent.trim()));
        })()
      `),
    );
    console.log(`tela mutada: ${JSON.stringify(mutated)}`);
    try {
      await clickProviderInPicker(page, "antigravity");
      const after = await pickerState(page);
      console.log(`RESULTADO: NÃO recusou — clicou. ativo agora = ${JSON.stringify({ index: after.activeIndex, text: after.activeText })}`);
    } catch (err) {
      console.log(`RESULTADO: recusou — ${String(err.message).slice(0, 240)}`);
    }
  }

  console.log(`picker depois: ${JSON.stringify(await pickerState(page))}`);
  page.close();
} finally {
  await stopApp(app);
}

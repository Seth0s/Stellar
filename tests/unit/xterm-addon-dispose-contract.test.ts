import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

/**
 * Bug real (Pop!_OS, 2026-09-09): letra isolada do terminal saindo como
 * bloco cheio ("WHERE TRUE" -> "██ERE TRUE"). Causa: o `WebglAddon` era
 * carregado sem handler de perda de contexto, e o xterm seguia desenhando
 * com o atlas de textura morto. O fix em `useTerminal.ts` é
 * `webgl.onContextLoss(() => webgl.dispose())`.
 *
 * `useTerminal.ts` é um hook React e `vitest.config.ts` roda com
 * `environment: "node"` (sem jsdom, sem @testing-library) — o hook em si
 * não é montável aqui. O que ESTE arquivo cobre é a premissa do xterm em
 * que o fix se apoia, e que hoje não tinha teste nenhum: soltar o addon
 * sozinho e depois derrubar o terminal precisa ser seguro. Se um upgrade
 * de `@xterm/xterm` quebrar esse contrato (dispose em cascata pelo
 * `AddonManager` + guarda de `isDisposed` no dispose embrulhado do
 * addon), o fix passa a dar dispose duas vezes no unmount de todo card e
 * ninguém perceberia — o hook não é exercitado por nenhum teste.
 *
 * Isto é um teste de CONTRATO DE DEPENDÊNCIA, não do nosso código: ele
 * existe para falhar num upgrade, não para provar lógica nossa.
 *
 * Nasceu de sondas soltas (`test-xterm*.cjs`, `test-webgl-addon.cjs`) que
 * um agente de review deixou na raiz do repo ao verificar exatamente isto
 * à mão, imprimindo `console.log` sem asserção nenhuma. Viraram este
 * arquivo e foram apagadas.
 */
describe("contrato do xterm: dispose de addon vs. dispose do terminal", () => {
  it("dar dispose no addon e depois no terminal não estoura (o caminho do onContextLoss)", () => {
    const term = new Terminal();
    const webgl = new WebglAddon();
    term.loadAddon(webgl);

    // O que `onContextLoss` faz em produção: solta só o addon, deixando o
    // terminal vivo para seguir no renderer DOM.
    expect(() => webgl.dispose()).not.toThrow();
    // E o unmount do card, depois, derruba o terminal inteiro.
    expect(() => term.dispose()).not.toThrow();
  });

  it("o dispose em cascata do terminal não chama de novo um addon já disposto", () => {
    const term = new Terminal();
    let disposeCount = 0;
    // Addon mínimo pelo contrato público do xterm (`ITerminalAddon`), para
    // poder CONTAR as chamadas — o `WebglAddon` real não expõe isso.
    const addon = {
      activate() {},
      dispose() {
        disposeCount += 1;
      },
    };
    term.loadAddon(addon);

    addon.dispose();
    expect(disposeCount).toBe(1);

    term.dispose();
    // A garantia que o fix do glyph assume: o `AddonManager` embrulha o
    // `dispose` do addon com uma guarda de `isDisposed`, então derrubar o
    // terminal depois NÃO reentra no addon já solto.
    expect(disposeCount).toBe(1);
  });

  it("derrubar só o terminal dá dispose no addon que ainda estava carregado", () => {
    const term = new Terminal();
    let disposed = false;
    term.loadAddon({
      activate() {},
      dispose() {
        disposed = true;
      },
    });

    term.dispose();
    // O outro lado do mesmo contrato: quem NÃO se soltou sozinho (contexto
    // WebGL nunca caiu) precisa ser solto pelo terminal — senão o fix
    // trocaria um vazamento por outro.
    expect(disposed).toBe(true);
  });
});

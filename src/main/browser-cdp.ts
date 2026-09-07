import type { WebContents } from "electron";

/** DESIGN-BACKLOG.md §2.1 — adoção de CDP via `webContents.debugger`
 * (Electron 42.3.0, confirmado disponível). Duas decisões anteriores do
 * projeto rejeitaram CDP com o argumento "uma sessão CDP por card de
 * navegador aberto, mais uma superfície de estado/custo por card" —
 * esse módulo muda o eixo do custo pra "por INSPECTOR aberto", não "por
 * card aberto": quem chama `attach()`/`detach()` é o mount/unmount do
 * `BrowserInspector.tsx` (que já desmonta de verdade quando o painel
 * fecha, `BrowserCard.tsx`'s `{inspectorOpen && <BrowserInspector/>}`),
 * não `create()`/`destroy()` do card em si. A maioria dos browser cards
 * nunca abre o inspector — o custo de uma sessão CDP nunca existe pra
 * eles.
 *
 * Uma única sessão por card, compartilhada por TODAS as abas do
 * inspector (Elements/Styles/Listeners/Network/Sources/Performance) —
 * não uma sessão por feature. `attach()` habilita de propósito só os
 * domínios sem custo de buffering/instrumentação (`DOM`/`CSS`/`Overlay`/
 * `Runtime`); `Network`/`Debugger`/`Profiler` habilitam sob demanda —
 * `send("Network.enable")` genérico via `sendCdp` do lado do renderer,
 * chamado só quando a aba correspondente abre pela primeira vez (ver
 * `BrowserInspector.tsx`) — sem precisar de um método dedicado além do
 * `send()` que já existe: um domínio `.enable` é só mais um comando CDP
 * como outro qualquer.
 *
 * `attach()` é síncrono e lança na hora se outro consumidor do
 * protocolo já estiver anexado ao MESMO `webContents` (`electron.d.ts`:
 * `Debugger.attach(protocolVersion?): void` — nunca promise, ao
 * contrário de `sendCommand`). O caso real e único hoje: `openDevTools`
 * (browser-registry.ts) já usa o protocolo pra abrir o DevTools real
 * numa janela destacada — os dois não coexistem no mesmo card. Também
 * documentado no próprio `electron.d.ts`: abrir DevTools num
 * `webContents` com nosso debugger anexado dispara `detach` sozinho
 * (não erro) — por isso o listener de `"detach"` trata isso como um
 * evento normal a reportar pro renderer, não uma exceção. */

export type CdpAttachResult = { ok: true } | { ok: false; error: string };
export type CdpSendResult = { ok: true; result: unknown } | { ok: false; error: string };

export type CdpSession = {
  attach: () => Promise<CdpAttachResult>;
  detach: () => void;
  send: (method: string, params?: object) => Promise<CdpSendResult>;
  isAttached: () => boolean;
};

/** Domínios sem efeito colateral de buffering/instrumentação — seguros
 * pra habilitar sempre que o inspector abre, independente de qual aba o
 * usuário vai olhar primeiro (todas menos Network/Sources/Performance
 * dependem de pelo menos um destes). */
const EAGER_DOMAINS = ["DOM", "CSS", "Overlay", "Runtime"];

export function createCdpSession(wc: WebContents, onEvent: (method: string, params: unknown) => void): CdpSession {
  let attached = false;
  let listenersRegistered = false;

  function registerListenersOnce() {
    if (listenersRegistered) return;
    listenersRegistered = true;
    wc.debugger.on("message", (_event, method, params) => {
      onEvent(method, params);
    });
    // Ver doc comment do módulo — dispara tanto num detach EXPLÍCITO nosso
    // quanto quando outra coisa (DevTools real) assume o protocolo por
    // fora; `attached` precisa refletir isso pra `send()` parar de
    // tentar mandar comando num debugger que já não responde
    // mais, e pro renderer poder mostrar o banner de "inspector
    // indisponível" mesmo numa desconexão que ESTE módulo não iniciou.
    wc.debugger.on("detach", (_event, reason) => {
      attached = false;
      onEvent("__detached__", { reason });
    });
  }

  async function attach(): Promise<CdpAttachResult> {
    if (attached) return { ok: true };
    try {
      wc.debugger.attach("1.3");
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    attached = true;
    registerListenersOnce();
    try {
      await Promise.all(EAGER_DOMAINS.map((domain) => wc.debugger.sendCommand(`${domain}.enable`)));
    } catch (err) {
      // Domínio recusando habilitar é mais grave que um comando comum
      // falhar depois — sem DOM/CSS/Runtime não tem inspector nenhum
      // possível. Desanexa e reporta falha em vez de deixar uma sessão
      // "attached" pela metade.
      detach();
      return { ok: false, error: String(err) };
    }
    return { ok: true };
  }

  function detach() {
    if (!attached) return;
    attached = false;
    try {
      wc.debugger.detach();
    } catch {
      // Idempotente de propósito — já pode ter sido desanexado por fora
      // (webContents destruído, ou o evento "detach" já rodou primeiro).
    }
  }

  async function send(method: string, params?: object): Promise<CdpSendResult> {
    if (!attached) return { ok: false, error: "CDP session not attached" };
    try {
      const result = await wc.debugger.sendCommand(method, params);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  function isAttached(): boolean {
    return attached;
  }

  return { attach, detach, send, isAttached };
}

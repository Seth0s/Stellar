import type { EffortCapability } from "./providers";
import type { ProvidersReloadReport } from "./providers-dynamic";

/**
 * O CONTRATO DO CANAL DE DISPONIBILIDADE — o que atravessa para o renderer.
 *
 * POR QUE ESTE MÓDULO EXISTE (2026-09-20, task 07b05f43): o renderer NÃO
 * recebe `capacity`, e por isso cada fato de capacidade que a UI precisa
 * virava uma SEGUNDA TABELA hardcoded do lado de lá — `card-types.ts`'s
 * PROVIDER_EFFORT_VALUES era `capacity.effort.values` de claude e antigravity
 * copiado valor por valor, e precisou de sincronização à mão quando o
 * antigravity mudou de faixa (2026-09-12), enquanto cline e commandcode
 * declaravam as suas e a UI não oferecia nenhuma.
 *
 * A REGRA: projeta-se o que a UI CONSOME, com nome PRÓPRIO dela — nunca o
 * `capacity` inteiro, que acoplaria o renderer ao formato interno do spec e
 * vazaria campos que só o main usa (role, mcp, delivery, session…). Um campo
 * por vez, quando existe um consumidor para ele.
 *
 * Puro de propósito (mesma divisão decisão × efeito do resto do main): as
 * duas funções abaixo são o que um teste consegue travar sem construir uma
 * janela do Electron, e o efeito (ler o registro vivo, mandar o evento) fica
 * no chamador.
 */

/**
 * Os valores de esforço que a UI pode OFERECER para um provider.
 *
 * A ORDEM É A DA DECLARAÇÃO, e é ela que a UI usa (as faixas são escritas do
 * menor para o maior: `low, medium, high, xhigh, max`). Um `Set`/`sort` aqui
 * reordenaria a lista na tela — por isso a cópia é um espalhamento direto.
 *
 * Vazio = este provider não declara esforço (`mechanism: "none"`, o caso do
 * `bash`, cursor e codex). A UI então NÃO oferece o controle; ausência nunca
 * vira um `<select>` vazio, que ofereceria uma escolha que não existe.
 */
export function projectEffortValues(effort: EffortCapability | undefined): string[] {
  return effort?.mechanism === "flag" ? [...effort.values] : [];
}

/** Um aviso do canal, já com os argumentos que o `safeSend` espera. */
export type AvailabilityNotice = {
  channel: "providers:config-changed" | "agents:availability-stale";
  args: unknown[];
};

/**
 * Os DOIS avisos que um reload do `providers.json` precisa emitir.
 *
 * O SEGUNDO FALTAVA, e é um bug medido (2026-09-20): o snapshot de
 * disponibilidade do renderer (`useAgentAvailability.ts`) só re-checava no
 * boot e quando a resolução do PATH terminava — `agents:availability-stale`
 * era emitido em UM lugar só, no boot. Resultado: o dono editava o
 * `providers.json`, a tela de Settings atualizava (ela escuta o primeiro
 * aviso) e o rail, o menu radial e os pickers continuavam mostrando o mundo
 * velho até reiniciar o app; com a projeção acima, a faixa de esforço que ele
 * acabou de editar ficaria na tela com o valor antigo — pior do que não
 * mostrar. O canal e o ouvinte JÁ existiam (o hook chama `recheck()` ao
 * receber); o que faltava era re-emitir.
 *
 * Devolver os avisos como DADO (em vez de dois `safeSend` soltos no boot) é o
 * que deixa um teste travar o par: sem isso, apagar o segundo aviso um dia
 * não quebra nada, e a tela volta a envelhecer em silêncio.
 */
export function providersReloadNotices(report: ProvidersReloadReport, line: string): AvailabilityNotice[] {
  return [
    { channel: "providers:config-changed", args: [{ report, line }] },
    { channel: "agents:availability-stale", args: ["providers:config-changed"] },
  ];
}

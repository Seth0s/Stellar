import type { EffortCapability, OneShotCapability, TurnEndSignal } from "./providers";
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

/**
 * A AÇÃO ONE-SHOT ("Resumir") — o fato que a UI consome é UM BOOLEANO, e é
 * este o terceiro campo desta família (task efc5b6fd, depois de `effortValues`
 * (07b05f43) e `turnEndSignal` (0dd5c145)).
 *
 * O DEFEITO QUE ELE FECHA: o Rail oferecia "Resumir" pelo critério
 * `newProvider !== "bash"` e o main montava o argv por `id` hardcoded — para
 * cline e commandcode a UI oferecia e a execução mandava flags que aquelas
 * CLIs não têm (medido: `cline -p` é PLAN mode e `--output-format` não existe
 * lá; o `--output-format json` do commandcode é stream NDJSON). O usuário
 * clicava numa coisa que o app sabia que ia falhar.
 *
 * `false` = este provider NÃO declara a ação, e a UI NÃO oferece — o botão não
 * aparece, exatamente como o controle de esforço some com `effortValues`
 * vazio. Ausência é a resposta, nunca um "ofereço e vejo".
 *
 * Por que um BOOLEANO e não o mecanismo: o renderer não escolhe argv nem lê a
 * saída — quem faz isso é o main. O único fato que a tela usa é "posso
 * oferecer?"; projetar `args`/`result` acoplaria o renderer ao formato do spec
 * e vazaria dados que ele não consome (a regra do módulo, no topo).
 */
export function projectOneShot(oneShot: OneShotCapability | undefined): boolean {
  return oneShot?.mechanism === "argv";
}

/**
 * Como o renderer aprende que o turno DESTE provider acabou (task 0dd5c145).
 *
 * O renderer decidia isso por `id === "claude"` (mais um Set hardcoded), e a
 * pergunta agora é feita à DECLARAÇÃO (`capacity.delivery.turnEnd`).
 *
 * `null` = este provider não sinaliza, e a UI não promete: a barra de
 * atividade cai no silêncio e nenhum aviso de SO é disparado por aproximação
 * — mesma regra do `effortValues` vazio.
 *
 * POR QUE O PADRÃO ATRAVESSA COMO TEXTO: `RegExp` não é serializável por IPC,
 * então vai `source` + `flags` e o renderer remonta. É o único jeito de o
 * pattern-match (que roda no renderer, sobre o stream do PTY) continuar sendo
 * alimentado por uma declaração que mora no main.
 *
 * O mecanismo NÃO se achata num booleano de propósito: `hook` é um EVENTO
 * entregue pelo CLI e `screen` é leitura de texto — o gate de notificação de
 * SO trata os dois diferente (ver `TerminalCard.tsx`), e um booleano apagaria
 * essa diferença.
 */
export type TurnEndProjection =
  | { mechanism: "hook" }
  | { mechanism: "screen"; source: string; flags: string }
  | null;

export function projectTurnEndSignal(turnEnd: TurnEndSignal | undefined): TurnEndProjection {
  if (!turnEnd) return null;
  if (turnEnd.mechanism === "hook") return { mechanism: "hook" };
  return { mechanism: "screen", source: turnEnd.pattern.source, flags: turnEnd.pattern.flags };
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

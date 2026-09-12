import { app, BrowserWindow, type Session } from "electron";
import { t } from "../shared/i18n";
import { createCdpSession, type CdpSession, type CdpAttachResult, type CdpSendResult } from "./browser-cdp";

export type BrowserMouseEvent = {
  /** `mouseLeave` — achado ao vivo (2026-08-31): sem sinal explícito de
   * "o cursor saiu do card", qualquer `:hover`/tooltip/dropdown que a
   * página embutida abriu ao passar o mouse nunca fecha quando o cursor
   * sai do canvas (nada nele nunca dispara um `mouseleave`/`mouseout`
   * real). Electron's `sendInputEvent` aceita esse tipo nativamente pra
   * eventos de mouse — não é um hack de coordenada fora-de-bounds. */
  type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseLeave";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
};
export type BrowserWheelEvent = { x: number; y: number; deltaX: number; deltaY: number };
export type BrowserKeyEvent = {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers?: Array<"shift" | "control" | "alt" | "meta">;
};

/** Subconjunto de `Electron.ContextMenuParams` que o menu montado em
 * main/index.ts realmente usa — ver `onContextMenu` abaixo. */
export type BrowserContextMenuParams = {
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  selectionText: string;
  isEditable: boolean;
  mediaType: "none" | "image" | "video" | "audio" | "canvas" | "file" | "plugin";
  canGoBack: boolean;
  canGoForward: boolean;
};

export type ConsoleEntry = { level: string; message: string; at: number };
/** Local/session storage — só o `evalJs` de dentro da página enxerga
 * (sem equivalente no processo main). Cookies ficam de fora de propósito:
 * `getCookies`/`CookieEntry` (mais abaixo) já cobrem isso via
 * `session.cookies.get`, evitando duplicar a mesma leitura por dois
 * caminhos diferentes. */
export type LocalSessionStorage = { local: [string, string][]; session: [string, string][] };
export type PageElement = { ref: string; role: string; name: string; tag: string; disabled?: boolean; checked?: boolean; value?: string };
export type NetworkEntry = { method: string; url: string; status: number | null; error?: string; at: number };
/** Aba Application do mini-inspector — ver `getCookies` abaixo pro porquê
 * de vir de `session.cookies.get` (main process) e não de `evalJs`. */
export type CookieEntry = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expirationDate?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
};

/** Achado ao vivo (2026-09-01, relato de um agente que dirigiu o navegador
 * daqui): "debugar uma falha silenciosa (um botão de salvar que não faz
 * nada porque a API deu 500) não tem caminho nenhum pelo lado do Stellar".
 * Console e rede passam a ser gravados por card, em anel — a captura já
 * existia pro console (o contador de erros no header do card vem dela),
 * só era descartada depois de contar. Anel e não lista infinita: uma SPA
 * ruidosa geraria centenas de entradas por minuto e isso vive pela vida
 * inteira do card. */
const CONSOLE_BUFFER = 500;
const NETWORK_BUFFER = 300;

type Entry = {
  win: BrowserWindow;
  visible: boolean;
  scaleFactor: number;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** DESIGN-BACKLOG.md §2.1 — sessão CDP do inspector embutido, ver
   * browser-cdp.ts. `null` a maior parte da vida do card — só existe
   * entre `attachInspector`/`detachInspector` (mount/unmount do
   * `BrowserInspector.tsx`), nunca durante a vida inteira do card. */
  cdp: CdpSession | null;
  /** Pendentes #188 (UA+touch) — UA de ORIGEM do `webContents`, guardado
   * na hora em que a emulação mobile liga pela primeira vez (via
   * `wc.getUserAgent()`, nunca reconstruído). `null` quando não há
   * override ativo — dobra como flag de "emulação mobile está ligada
   * agora" (ver `setDeviceEmulation`), pra restaurar o UA exato de antes
   * ao desligar em vez de adivinhar um default. */
  originalUserAgent: string | null;
  /** Review adversarial, achado 1 (2026-09-09) — contagem de uso do
   * domínio `Network` na sessão CDP. Dois consumidores independentes
   * podem querer `Network` habilitado ao mesmo tempo: a aba Network do
   * inspector embutido (`BrowserInspector.tsx`, liga sob demanda quando a
   * aba abre, NUNCA desliga — ver doc comment do módulo `browser-cdp.ts`,
   * "Network/Debugger/Profiler habilitam sob demanda") e o override de
   * client hints da emulação mobile (`applyMobileCdpOverrides` abaixo,
   * que também depende de `Network` habilitado). Sem contagem, desligar
   * a emulação mobile enquanto a aba Network está aberta derrubaria o
   * monitoramento de rede do usuário por baixo dos panos; SEM desligar
   * nunca, a sessão fica com eventos de rede atravessando o IPC pro resto
   * da vida do card, sem ninguém consumindo, sempre que a emulação mobile
   * ligou pelo menos uma vez — o próprio modelo "sob demanda" que
   * `EAGER_DOMAINS` estabelece. `sendCdp`/`applyMobileCdpOverrides` são
   * os dois únicos pontos que tocam `Network.enable`/`Network.disable` —
   * ambos passam por `trackedNetworkSend` abaixo. Zerado em
   * `detachInspector` (sessão nova começa sem nenhum domínio habilitado,
   * a contagem da sessão anterior não faz sentido nela). */
  networkEnableRefs: number;
};

// Pre-release audit P2 — every visible browser card painted at the same
// rate regardless of whether it's the one the user is actually
// interacting with. Two visible-but-unfocused cards (the common
// multi-browser-card layout) competed for main-process CPU/IPC at full
// rate for content nobody's actively watching move.
//
// Pedido ao vivo (2026-08-31, uso da v0.2.0) — 30fps focado sentia
// travado; subiu pra 60. `UNFOCUSED_FRAME_RATE` ficou parado em 8 por
// decisão explícita: sem custo extra pra cards fora de foco, só o card
// que a pessoa está de fato olhando fica mais caro em encode/transfer
// JPEG por frame.
const FOCUSED_FRAME_RATE = 60;
const UNFOCUSED_FRAME_RATE = 8;

/** Pendentes #188 (UA+touch) — `maxTouchPoints` reportado a
 * `navigator.maxTouchPoints` enquanto a emulação mobile está ligada. 5 é
 * o valor que o próprio device toolbar do Chrome usa pros presets de
 * celular (não há um "certo" universal; só precisa ser >0 pras media
 * features `pointer: coarse`/`hover: none` e pro `maxTouchPoints`-sniffing
 * de sites ligarem o caminho touch). */
const MOBILE_TOUCH_POINTS = 5;

// Supersample fixo, pedido explícito do usuário (2026-09-02: "mandar
// renderizar o triplo da resolução e aumentar para escala 1:1") — ver o
// doc comment de `resize()` abaixo pro porquê de precisar do PAR
// `setContentSize`+`setZoomFactor` (não `setContentSize` sozinho) pra isto
// ser supersample de verdade, e não só a página acreditando que tem um
// viewport maior. Verificado ao vivo, 3 scripts de diagnóstico isolados
// antes de embarcar: (1) `setContentSize(N×)` sozinho deixa o conteúdo
// lógico da página proporcionalmente MENOR na tela (mais página cabe no
// card, texto ilegível a 3×) — não é supersample; (2) `setContentSize(N×)`
// + `setZoomFactor(N)` juntos mantêm a MESMA área lógica visível (mesmo
// "zoom" aparente do conteúdo) com N²× mais pixels reais de raster por
// trás — supersample de verdade, texto visivelmente mais nítido no
// screenshot comparado lado a lado; (3) clique continua preciso com o
// combo ativo (`sendInputEvent` opera no espaço de coordenadas da janela,
// não no espaço pós-zoom da página — mesmo raciocínio de por que zoom de
// página nunca quebra clique num browser real). Custo real medido numa
// página de conteúdo denso (texto real, não tela em branco): ~5× bytes
// por frame em JPEG qualidade 90 (não 9× — JPEG comprime o detalhe extra
// bem melhor que pixels brutos sugeririam) — MAS esse número foi medido só
// com `scaleFactor=1` (a máquina de dev não tem monitor HiDPI real).
//
// Dois bugs reais achados ao vivo pelo usuário testando num monitor 4K de
// verdade (2026-09-02), NENHUM pego pelos testes porque todos rodam em
// scaleFactor=1 (onde os dois degeneram e viram invisíveis):
//
// 1. "Tudo muito pequeno" — `setZoomFactor` era setado UMA VEZ em
//    `create()`, sempre com o valor fixo `BROWSER_SUPERSAMPLE`, mas o
//    `factor` real usado em `setContentSize` (abaixo) é
//    `scaleFactor × BROWSER_SUPERSAMPLE`. Em scaleFactor=1 os dois batem
//    por coincidência (3 == 1×3); em qualquer monitor real com
//    scaleFactor > 1 (comum em 4K) o zoom passa a compensar MENOS do que
//    o content size cresceu — sobra um fator `scaleFactor` de "mais
//    página cabe no card" não cancelado, o MESMO bug que o combo
//    content-size+zoom foi feito pra eliminar, só que vazando de novo.
//    Fix: `setZoomFactor` agora é recalculado e reaplicado em TODA
//    chamada de `resize()` (que já roda a cada resize real de rect e a
//    cada troca de `scaleFactor`/monitor — `refreshScaleFactor`), sempre
//    com o MESMO fator aplicado ao content size, nunca uma constante solta.
//
// 2. "Travar" — o custo real de raster escala com o QUADRADO do fator
//    total (`scaleFactor × BROWSER_SUPERSAMPLE`)². Num monitor
//    scaleFactor=2 isso já é 6× de densidade — 36× a contagem de pixels
//    da base, 4× mais pesado que os 9× medidos em scaleFactor=1. Um
//    monitor HiDPI já ganha nitidez real só do `scaleFactor` (Item 6);
//    empilhar o supersample fixo por cima sem limite é onde o custo
//    explode sem ganho proporcional. Fix: `BROWSER_MAX_DENSITY` — teto no
//    fator TOTAL (não só no supersample), então quanto maior o
//    `scaleFactor` do monitor, menos supersample extra é empilhado em
//    cima (em vez de multiplicar sem parar). `2` é o primeiro candidato
//    real pra testar ao vivo num monitor 4K de verdade — não o "ponto
//    doce" final ainda (investigação em rodadas: 4K primeiro, depois
//    telas maiores, depois 1080p, cada uma com seu próprio teto ideal).
//    Medido num script de diagnóstico descartável antes de escolher este
//    valor: com o teto ativo, o custo (bytes/frame, latência) fica
//    IDÊNTICO pra qualquer `scaleFactor` de 1 a 2 — o teto absorve toda a
//    variação do monitor, exatamente o comportamento pretendido. `2`
//    entrega ~323KB/frame (JPEG qualidade 90) contra ~572KB do teto
//    antigo de `3` — bem mais leve, ainda com ganho real de nitidez sobre
//    a densidade pura do Item 6 (sem supersample nenhum).
const BROWSER_SUPERSAMPLE = 3;
const BROWSER_MAX_DENSITY = 2;

/**
 * Um endereço que não pode ter certificado TLS público, e por isso recebe
 * `http` em vez de `https` quando digitado sem esquema.
 *
 * Relatado ao vivo (2026-09-08): "o navegador não resolve para http". A
 * regra anterior era literal — só `localhost` e `127.` ganhavam `http`, e
 * todo o resto ia para `https`. Então um servidor de desenvolvimento em
 * `192.168.1.50:8080`, `[::1]:5173`, `10.0.0.5:3000`, `meumac.local:8080`
 * ou um hostname de rótulo único como `buun:8080` era carregado por
 * `https://`, falhava no handshake TLS e parecia um bug do navegador.
 *
 * O critério não é mais "é o localhost", é "nenhuma autoridade emite
 * certificado para este nome": loopback, faixas privadas (RFC 1918),
 * link-local, ULA de IPv6, mDNS `.local` e nome de rótulo único (sem
 * ponto), que por definição não é resolvível na internet pública.
 *
 * Isto não afrouxa segurança nenhuma: a rejeição de `javascript:`/`file:`/
 * `data:`/`blob:`/`vbscript:` em `normalizeUrl` é o que protege contra uma
 * navegação virar execução local, e continua idêntica. Um esquema `http://`
 * explícito sempre foi respeitado; o que mudou é só o palpite para quando
 * NENHUM esquema foi dado.
 */
/**
 * Canoniza um host IPv4 em qualquer notação que o Chromium aceita e
 * devolve os 4 octetos, ou `null` se não for um IPv4.
 *
 * Existe por causa de um downgrade de segurança real, achado em review e
 * confirmado medindo (2026-09-08): a regra anterior classificava
 * "rótulo único, sem ponto" como local, e `16843009` não tem ponto — mas
 * é `1.1.1.1` em notação inteira, um IP PÚBLICO, que passou a ser
 * carregado por `http://`. O inverso também errava: `0x7f.1` é
 * `127.0.0.1` e ia para `https`.
 *
 * As regras seguem o parser de host da WHATWG URL, que é o que o
 * Chromium implementa: 1 a 4 partes separadas por ponto; cada parte é
 * hexadecimal com prefixo `0x`, octal com `0` à frente, ou decimal; a
 * ÚLTIMA parte cobre todos os octetos restantes (`1.1` = 1.0.0.1,
 * `16843009` = 1.1.1.1).
 */
export function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]*$/.test(part)) value = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    // Prefixo `0` é octal, e o spec da WHATWG manda FALHAR se o resto
    // contiver dígito não octal — `09` não é 9, é inválido. Importa
    // porque esta função decide http vs https.
    else if (/^0\d*$/.test(part)) {
      if (!/^0[0-7]*$/.test(part)) return null;
      value = part === "0" ? 0 : parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    numbers.push(value);
  }

  // Toda parte menos a última cabe em um octeto; a última cobre o resto.
  const last = numbers.pop()!;
  if (numbers.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - numbers.length)) return null;

  let address = last;
  for (let i = numbers.length - 1; i >= 0; i -= 1) address += numbers[i] * 256 ** (3 - i);
  return [(address >>> 24) & 255, (address >>> 16) & 255, (address >>> 8) & 255, address & 255];
}

/**
 * Um endereço que não pode ter certificado TLS público, e por isso recebe
 * `http` em vez de `https` quando digitado sem esquema.
 *
 * Relatado ao vivo (2026-09-08): "o navegador não resolve para http". A
 * regra anterior era literal — só `localhost` e `127.` ganhavam `http`, e
 * todo o resto ia para `https`. Então um servidor de desenvolvimento em
 * `192.168.1.50:8080`, `[::1]:5173`, `10.0.0.5:3000` ou `meumac.local`
 * era carregado por `https://`, falhava no handshake TLS e parecia um bug
 * do navegador.
 *
 * O critério não é "é o localhost", é "nenhuma autoridade emite
 * certificado para este nome": loopback, faixas privadas (RFC 1918),
 * link-local, ULA de IPv6, os sufixos não delegáveis de `LOCAL_SUFFIXES`
 * e nome de rótulo único NÃO numérico, que por definição não é
 * resolvível na internet pública.
 *
 * Isto não afrouxa a segurança da navegação: a rejeição de `javascript:`/
 * `file:`/`data:`/`blob:`/`vbscript:` em `normalizeUrl` é o que impede uma
 * navegação de virar execução local, e continua idêntica. Um esquema
 * explícito sempre foi respeitado; o que mudou é só o palpite para quando
 * NENHUM esquema foi dado.
 *
 * Limite conhecido e aceito: um rótulo único que também é um TLD público
 * de verdade (`ai`, `dk`) é tratado como local e recebe `http`. Trocar
 * isso exigiria embutir a lista de public suffixes; o custo real é uma
 * primeira navegação em claro para um host que o usuário digitou sem
 * esquema, que o próprio site corrige por redirect ou HSTS.
 */
/**
 * Sufixos que NUNCA podem ser delegados na internet pública e portanto
 * nunca podem ter certificado TLS público — o que os torna, por
 * definição, endereços de rede local.
 *
 * Pergunta do usuário que expôs o buraco (2026-09-08): "não terá problema
 * em abrir http para testes locais?". Tinha: a versão anterior só
 * reconhecia `localhost` e `.local`, então `servidor.lan:8080`,
 * `nas.home:8080`, `box.internal:3000`, `api.test:8080` e
 * `dev.home.arpa:8080` iam todos para `https` e falhavam no handshake.
 * É justamente a categoria "endereço de teste local".
 *
 * Isto é uma LISTA, não uma regra derivável, e é por isso que não saiu
 * junto com a checagem de faixa de IP: cada entrada tem uma fonte.
 *
 *   localhost, test, invalid, example  RFC 6761, reservados
 *   local                              mDNS, RFC 6762
 *   home.arpa                          RFC 8375, redes domésticas
 *   internal                           reservado pela ICANN (2024) para
 *                                      uso privado
 *   lan, home, localdomain, intranet,  nunca delegáveis; é o que
 *   corp, private                      roteador e AD entregam na prática
 */
const LOCAL_SUFFIXES = [
  "localhost",
  "local",
  "test",
  "invalid",
  "example",
  "home.arpa",
  "internal",
  "lan",
  "home",
  "localdomain",
  "intranet",
  "corp",
  "private",
];

export function isLocalHostname(raw: string): boolean {
  // Descarta credenciais, porta, caminho, query e fragmento — sobra o host.
  const authority = raw.replace(/^\/\//, "").split(/[/?#]/)[0];
  const afterCredentials = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  // IPv6 vem entre colchetes (`[::1]:5173`); fora deles, o `:` é a porta.
  const bracketed = afterCredentials.match(/^\[([^\]]+)\]/);
  let host = (bracketed ? bracketed[1] : afterCredentials.split(":")[0]).toLowerCase();
  // Ponto final é um FQDN raiz válido: `localhost.` é o mesmo host que
  // `localhost`, e sem isto caía no ramo errado.
  if (host.endsWith(".") && host !== ".") host = host.slice(0, -1);
  if (host === "") return false;

  if (host === "host.docker.internal") return true;
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;

  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    // IPv4-mapped/embutido (`::ffff:192.168.0.1`): o que decide é o IPv4
    // no fim, não o prefixo IPv6.
    const embedded = host.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
    if (embedded) {
      const octets = ipv4Octets(embedded[1]);
      if (octets) return isPrivateIpv4(octets);
    }
    // ULA (fc00::/7) e link-local (fe80::/10), incluindo o `%zona`.
    const head = host.split(":")[0];
    return /^f[cd]/.test(head) || /^fe[89ab]/.test(head);
  }

  const octets = ipv4Octets(host);
  // Todo IPv4, em qualquer notação, é decidido pela faixa — e nunca cai
  // na regra de rótulo único abaixo. É isto que fecha o downgrade de
  // `16843009` (1.1.1.1, público) para `http`.
  if (octets) return isPrivateIpv4(octets);

  // Rótulo único não numérico (`buun`, `raspberrypi`): não é resolvível
  // na internet pública, então só pode ser um host da rede local.
  return !host.includes(".");
}

/** Loopback, RFC 1918 e link-local. */
function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 127 || a === 0) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Ported from CentralByte's browser.rs::normalize_url — rejects schemes that
 * would let a "navigate to a URL" request turn into local code execution or
 * file access (javascript:/file:/data:/blob:/vbscript:); an address that
 * cannot hold a public TLS certificate (see `isLocalHostname`) gets http,
 * everything else gets https if no scheme was given.
 *
 * `file:` stays rejected on purpose, not as leftover caution. Human-in-the-
 * loop `open_url` shows the URL on the consent dialog, but an autonomous
 * board auto-approves that same call — and a browser card is unsandboxed
 * Chromium with the Electron process's filesystem. `file:` + `get_page_text`
 * would then be an arbitrary local-file read that bypasses the bwrap mask
 * on `$HOME` / secrets. `data:`/`blob:`/`javascript:`/`vbscript:` stay
 * rejected as execution vectors regardless. Serve a local HTML artifact
 * over `http://` instead.
 */
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "about:blank") return "about:blank";
  const schemeMatch = t.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return t;
  if (scheme === "javascript" || scheme === "file" || scheme === "data" || scheme === "blob" || scheme === "vbscript") {
    throw unsupportedUrlScheme(scheme);
  }
  if (scheme === "about") throw unsupportedUrlScheme("about");
  if (scheme && t.includes("://")) throw unsupportedUrlScheme(scheme);
  return `${isLocalHostname(t) ? "http" : "https"}://${t}`;
}

function unsupportedUrlScheme(scheme: string): Error {
  return new Error(`unsupported url scheme: ${scheme}: — the embedded browser only opens http(s) URLs`);
}

/** Error string if `raw` is a scheme we refuse to navigate, else null.
 * Call this BEFORE creating a card or asking for consent — a rejected
 * scheme must not spend a human approval or leave a blank window. */
export function navigationUrlError(raw: string): string | null {
  try {
    normalizeUrl(raw);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "unsupported url scheme";
  }
}

/** Pendentes #188, opção intermediária (device emulation UA+touch) —
 * achado ao vivo (investigação read-only anterior, com teste empírico):
 * abrir google.com no device frame (390×622, DPR 3x) renderiza o layout
 * DESKTOP dentro do frame estreito porque o Google decide o HTML pelos
 * headers `User-Agent`/`Sec-CH-UA-Mobile` — confirmado que, com UA mobile,
 * o Google entrega o HTML mobile (com `meta viewport`). Redimensionar o
 * viewport depois disso (o que `setDeviceEmulation` abaixo já faz certo)
 * não transforma nada — o HTML já veio errado do servidor.
 *
 * `buildMobileUserAgent` deriva um UA mobile a PARTIR do UA desktop real
 * do Chromium embutido (`wc.getUserAgent()`), em vez de um UA mobile fixo
 * hardcoded — assim o `Chrome/N` sempre bate com a versão de verdade
 * embutida no Electron desta build, sem precisar acompanhar upgrades de
 * Electron manualmente. Mesma técnica que o device toolbar do Chrome real
 * usa: troca o token de plataforma pelo de um Android real e insere
 * " Mobile" antes do `Safari/537.36` final (é essa palavra "Mobile" no UA
 * que sites que fazem sniffing por regex geralmente procuram).
 *
 * Sozinha, esta função NÃO cobre Client Hints (`Sec-CH-UA-Mobile`/
 * `Sec-CH-UA-Platform`) — `wc.setUserAgent` só troca o header `User-Agent`,
 * os hints vêm de metadata interna do embedder, não são parseados da
 * string (achado inicial desta tarefa, a partir da ausência de qualquer
 * parâmetro de client hints em `webContents.setUserAgent` no
 * `electron.d.ts` desta versão). Correção do dono do repo: isso mata o
 * propósito da mudança se um site priorizar o hint sobre a string — ver
 * `applyMobileCdpOverrides` abaixo, que fecha essa lacuna via CDP
 * (`Network.setUserAgentOverride`) quando há sessão CDP anexada. */
export function buildMobileUserAgent(desktopUserAgent: string): string {
  const withAndroidPlatform = desktopUserAgent.replace(/\([^)]*\)/, "(Linux; Android 13; Pixel 7)");
  if (/(^|\s)Mobile(\s|$)/.test(withAndroidPlatform)) return withAndroidPlatform;
  if (/ Safari\//.test(withAndroidPlatform)) return withAndroidPlatform.replace(/ Safari\//, " Mobile Safari/");
  // Review adversarial, achado 4 (2026-09-09) — sem `Safari/` no UA (motor
  // não-WebKit, ou string atípica), o `replace` acima é um no-op e a
  // palavra "Mobile" nunca aparece em lugar nenhum — existe backend que
  // decide só por essa palavra estar presente (a mesma premissa que
  // justifica esta função inteira, ver doc comment acima), então o
  // fallback PRECISA garanti-la de algum jeito em vez de desistir
  // silenciosamente: acrescenta no final.
  return `${withAndroidPlatform} Mobile`;
}

/**
 * 2026-08-26 — rewritten from a native `WebContentsView` child
 * (`win.contentView.addChildView`) to offscreen rendering. The child-view
 * approach never composited into the main window on this machine — the
 * view demonstrably loaded and painted real content internally (confirmed
 * via CDP on its own target) but only its background color ever reached
 * the screen. That's not a bug in this app: electron/electron#45367
 * confirms `addChildView(WebContentsView)` visually failing to render
 * despite showing up in the DevTools tree, closed "not planned" upstream —
 * accepted as a real, permanent limitation of that API for exactly this
 * multi-live-child-view-on-a-dynamic-layout use case. See
 * DESIGN-BACKLOG.md item 9 for the full investigation (GPU ruled out,
 * `--ozone-platform=x11` tried and reverted — it stopped the window from
 * appearing at all).
 *
 * Each browser card now gets its own hidden (`show: false`) BrowserWindow
 * with `webPreferences.offscreen: true`. Its `webContents` never attaches
 * to any real window — Chromium paints it to an in-memory buffer instead,
 * delivered via the `paint` event. The renderer draws that buffer onto a
 * plain `<canvas>` inside the card's own DOM (BrowserCard.tsx), so it rides
 * the same CSS transform as every other card kind and respects real DOM
 * z-order/occlusion for free — no more CHROME_INSETS/manual bounds math,
 * no more `raise()`.
 */
export function createBrowserRegistry(callbacks: {
  onNavigate: (id: string, url: string) => void;
  onTitle: (id: string, title: string) => void;
  onLoading: (id: string, loading: boolean) => void;
  onFrame: (id: string, jpeg: Buffer, width: number, height: number) => void;
  /** DESIGN-BACKLOG.md §2.1 Item E — `level` is Electron's own current
   * (non-deprecated) string scale, forwarded raw rather than pre-
   * filtered here so the renderer decides what counts toward its error/
   * warning badge (see BrowserCard.tsx). Zero new architecture —
   * `console-message` is a plain built-in `webContents` event, same
   * primitive class as `did-navigate`/`page-title-updated` right below. */
  onConsoleMessage: (id: string, level: "info" | "warning" | "error" | "debug", message: string) => void;
  /** Pendentes #188 — botão direito real dentro da página embutida
   * (não sintetizado; ver `sendMouseEvent` abaixo: o próprio mouseDown/
   * mouseUp de botão direito, já forwardado normalmente, é o que faz o
   * Chromium da página offscreen disparar este evento sozinho). `x`/`y`
   * de `params` chegam no mesmo espaço de coordenadas de conteúdo que
   * `sendInputEvent` usa (ver BROWSER_SUPERSAMPLE/`resize()` acima) —
   * quem decide onde a seta real aparece na tela é o renderer
   * (BrowserCard.tsx), que sabe o retângulo on-screen real do canvas. */
  onContextMenu: (id: string, params: BrowserContextMenuParams) => void;
  /** Achado ao vivo ("navegador parece 360p") — `webPreferences.offscreen`
   * defaults to `deviceScaleFactor: 1` regardless of the real monitor,
   * confirmed direto no `electron.d.ts` da versão instalada. Toda página
   * embutida rasterizava em densidade 1x mesmo numa tela HiDPI (2x
   * comum) — texto/imagem saíam nativamente moles antes de qualquer
   * JPEG/zoom. `screen.getDisplayMatching(win.getBounds())` (main/
   * index.ts) usa o display onde a janela do app REALMENTE está, correto
   * em multi-monitor com DPIs diferentes, não só "primary display". */
  getScaleFactor: () => number;
  /** DESIGN-BACKLOG.md §2.1 — repassa QUALQUER evento CDP (`DOM.setChildNodes`,
   * `Network.responseReceived`, `Debugger.paused`, o `"__detached__"`
   * sintético de browser-cdp.ts, etc.) por um canal só — CDP já se
   * autodescreve pelo `method`, um canal por domínio só duplicaria esse
   * discriminante. Ver `browser-cdp.ts`'s doc comment. */
  onCdpEvent: (id: string, method: string, params: unknown) => void;
}) {
  const entries = new Map<string, Entry>();
  /** `webRequest` só reporta o `webContentsId`; isto o traduz de volta pro
   * card. Uma entrada morre junto com o card em `destroy`. */
  const wcIdToCardId = new Map<number, string>();
  const tappedSessions = new WeakSet<Session>();

  function recordNetwork(webContentsId: number | undefined, record: NetworkEntry) {
    if (webContentsId === undefined) return;
    const cardId = wcIdToCardId.get(webContentsId);
    if (!cardId) return;
    const entry = entries.get(cardId);
    if (!entry) return;
    entry.network.push(record);
    if (entry.network.length > NETWORK_BUFFER) entry.network.shift();
  }

  /** Um tap por sessão, idempotente — ver o comentário no `create`. Só
   * observa (`onCompleted`/`onErrorOccurred`), nunca bloqueia nem reescreve
   * requisição: um listener que responde tarde num `onBeforeRequest`
   * travaria a navegação da página inteira, e não há nada aqui que
   * justifique esse risco. */
  function ensureNetworkTap(session: Session) {
    if (tappedSessions.has(session)) return;
    tappedSessions.add(session);
    session.webRequest.onCompleted((details) => {
      recordNetwork(details.webContentsId, {
        method: details.method,
        url: details.url,
        status: details.statusCode ?? null,
        at: Date.now(),
      });
    });
    session.webRequest.onErrorOccurred((details) => {
      recordNetwork(details.webContentsId, {
        method: details.method,
        url: details.url,
        status: null,
        error: details.error,
        at: Date.now(),
      });
    });
  }

  function create(id: string, url: string): { scaleFactor: number } {
    // Normalize first: the throw used to happen after `entries.set` and
    // inside `void loadURL(...)`, so a refused scheme left a blank card
    // and the error never reached the caller.
    const normalized = normalizeUrl(url);
    const scaleFactor = callbacks.getScaleFactor();
    const win = new BrowserWindow({
      show: false,
      width: 720,
      height: 560,
      webPreferences: {
        offscreen: { deviceScaleFactor: scaleFactor },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Documentado ao vivo (2026-09-03) — sem `partition`, Electron usa
        // `session.defaultSession` pra QUALQUER BrowserWindow, então todo
        // card de navegador aberto (não só os de um board, TODOS) compartilha
        // cookies/localStorage/service workers entre si. Achado direto:
        // não dava pra simular 2 usuários logados ao mesmo tempo em cards
        // separados — só sequencial (login → ação → logout → outro login)
        // no MESMO card. Um nome de partição único POR CARD isola cada um
        // (Electron cria a sessão isolada sob demanda). Sem prefixo
        // `persist:` de propósito — efêmera, morre com o card/app, do
        // mesmo jeito que uma aba anônima nova; nada aqui pede que um login
        // sobreviva a fechar e reabrir o card.
        partition: `stellar-browser-${id}`,
      },
    });
    const wc = win.webContents;
    // Caps the max paint rate across every open browser card — Chromium
    // only actually emits `paint` on real change (scroll, animation, load),
    // so a mostly-static page costs nothing between those; this just bounds
    // the worst case (video, fast scrolling) instead of firing at whatever
    // the compositor would otherwise allow. A newly created card is the one
    // the user just asked for — starts at the focused rate; `setFocused`
    // below lowers it once something else gets raised on top.
    wc.setFrameRate(FOCUSED_FRAME_RATE);
    // Supersample fixo (ver doc comment de BROWSER_SUPERSAMPLE/`resize()`)
    // — NÃO setado aqui (achado ao vivo: setar uma constante fixa uma
    // única vez, sem reconsiderar o `scaleFactor` real, é exatamente o bug
    // 1 documentado acima). `resize()` recalcula e reaplica `setZoomFactor`
    // toda vez, incluindo na primeira chamada real (disparada pelo
    // primeiro resize do renderer logo após `create()` resolver).

    wc.on("paint", (_event, _dirty, image) => {
      const entry = entries.get(id);
      if (!entry?.visible) return;
      const { width, height } = image.getSize();
      if (width === 0 || height === 0) return;
      // JPEG, not the raw BGRA bitmap — a 720×560 raw frame is ~1.6MB;
      // over IPC at any real paint rate across several open cards that's
      // not viable. Queixa ao vivo de qualidade "parece 360p" (2026-09-01,
      // depois do fix de deviceScaleFactor) — qualidade 70 estava
      // introduzindo artefato de compressão visível em texto/UI real, um
      // segundo fator de perda 100% nosso, independente de qualquer
      // limitação do Electron/GPU. Subida pra 90: ainda troca um pouco de
      // nitidez por caber num canal IPC repetidamente, mas o degrau de
      // qualidade em 70 era desnecessariamente agressivo pra conteúdo de
      // UI/texto (majoritariamente o que se navega aqui).
      callbacks.onFrame(id, image.toJPEG(90), width, height);
    });

    // Same reasoning as before this rewrite: modern Chromium renders
    // about:blank's own background dark under a dark OS/user color-scheme
    // preference, regardless of setBackgroundColor. Force light so a
    // blank/never-navigated card reads as "empty", not "broken".
    wc.on("dom-ready", () => {
      void wc.insertCSS("html{color-scheme:light;background:#fff;}");
    });

    // DESIGN-BACKLOG.md item 37 — a real crash reported live (fullscreen
    // video, "opens another window that errors, crashes the app on
    // close"); not reproduced after real effort (3 separate live CDP
    // repros, see main/index.ts's crash-safety-net comment for detail),
    // but this was a genuine, independently-real gap found reading the
    // code either way: no `setWindowOpenHandler` meant ANY `window.open()`
    // from inside an embedded page (ads, a video player's own popup,
    // YouTube's "watch on..." links, anything) spawned a completely
    // unmanaged, un-offscreen, un-hidden, ACTUALLY VISIBLE native
    // `BrowserWindow` — outside this registry's `entries` map, outside
    // every card lifecycle (resize/destroy/paint), a real "outra janela"
    // by definition. Denied outright: this app has no UI for a second
    // window per card, and a real one showing up broken/unstyled (no
    // `webPreferences` matching this card's own, no positioning) is worse
    // than just not opening it — `navigate()` already exists for a card
    // that wants to follow a link in place.
    wc.setWindowOpenHandler(() => ({ action: "deny" }));

    // Same item — HTML5 fullscreen (a video's own fullscreen button) has
    // no business trying to make the underlying host `BrowserWindow`
    // (offscreen, `show: false`, never mapped by the OS) go native
    // fullscreen; Electron's default un-intercepted behavior tries to
    // sync the two. Explicitly undoing it here every time keeps this
    // window inert regardless of platform-specific fullscreen/windowing
    // behavior (Wayland vs. X11) — the page's OWN fullscreen CSS/JS still
    // resolves normally either way (confirmed live:
    // `document.fullscreenElement` genuinely became truthy and the video
    // filled its own frame), so the card's canvas in BrowserCard.tsx
    // still shows the video "fullscreen" within the card, which is the
    // only fullscreen that makes sense for an embedded card in the first
    // place — the host window was never meant to be seen at all.
    wc.on("enter-html-full-screen", () => {
      if (win.isFullScreen()) win.setFullScreen(false);
    });

    wc.on("did-navigate", (_e, navUrl) => callbacks.onNavigate(id, navUrl));
    wc.on("did-navigate-in-page", (_e, navUrl) => callbacks.onNavigate(id, navUrl));
    wc.on("page-title-updated", (_e, title) => callbacks.onTitle(id, title));
    wc.on("did-start-loading", () => callbacks.onLoading(id, true));
    wc.on("did-stop-loading", () => callbacks.onLoading(id, false));
    wc.on("console-message", (details) => {
      const entry = entries.get(id);
      if (entry) {
        entry.console.push({ level: details.level, message: details.message, at: Date.now() });
        if (entry.console.length > CONSOLE_BUFFER) entry.console.shift();
      }
      callbacks.onConsoleMessage(id, details.level, details.message);
    });

    wc.on("context-menu", (_e, params) => {
      callbacks.onContextMenu(id, {
        x: params.x,
        y: params.y,
        linkURL: params.linkURL,
        srcURL: params.srcURL,
        selectionText: params.selectionText,
        isEditable: params.isEditable,
        mediaType: params.mediaType,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    });

    entries.set(id, { win, visible: true, scaleFactor, console: [], network: [], cdp: null, originalUserAgent: null, networkEnableRefs: 0 });
    // A sessão é a padrão, compartilhada com a janela principal, e o
    // `webRequest` do Electron aceita UM listener por evento por sessão —
    // então o registro é feito uma vez só e despachado por
    // `webContentsId`, nunca um listener por card (o segundo card
    // silenciosamente desligaria o primeiro).
    wcIdToCardId.set(wc.id, id);
    ensureNetworkTap(wc.session);
    void wc.loadURL(normalized);
    return { scaleFactor };
  }

  function navigate(id: string, url: string) {
    const normalized = normalizeUrl(url);
    const wc = entries.get(id)?.win.webContents;
    if (!wc) return;
    void wc.loadURL(normalized);
  }

  function back(id: string) {
    const wc = entries.get(id)?.win.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  function forward(id: string) {
    const wc = entries.get(id)?.win.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  function reload(id: string) {
    entries.get(id)?.win.webContents.reload();
  }

  /** DESIGN-BACKLOG.md §2.1 Item E — `openDevTools` works on an offscreen
   * `webContents` same as a real one; `mode: "detach"` opens it as its
   * OWN normal (on-screen) window rather than trying to render DevTools
   * itself offscreen, which Electron doesn't support.
   *
   * DESIGN-BACKLOG.md §2.1 (adoção de CDP) — Electron só permite UM
   * consumidor do protocolo de depuração por `webContents` por vez.
   * Com o inspector embutido agora também usando `webContents.debugger`
   * (`entry.cdp`, ver browser-cdp.ts), abrir o DevTools real enquanto o
   * inspector está anexado desanexaria a sessão dele sozinho (Electron
   * dispara "detach", não erro — ver doc comment de `createCdpSession`).
   * Recusa explicitamente em vez de deixar isso acontecer "por baixo dos
   * panos": devolve um resultado tipado que a UI usa pra avisar o
   * usuário, em vez de void silencioso. */
  function openDevTools(id: string): { ok: true } | { ok: false; error: string } {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: "card not found" };
    if (entry.cdp?.isAttached()) {
      return { ok: false, error: t("error.closeInspectorFirst") };
    }
    entry.win.webContents.openDevTools({ mode: "detach" });
    return { ok: true };
  }

  /** DESIGN-BACKLOG.md §2.1 — anexa a sessão CDP do inspector embutido.
   * Chamado no MOUNT de `BrowserInspector.tsx` (não em `create()` do
   * card) — a maioria dos cards nunca abre o inspector, então nunca paga
   * o custo de uma sessão CDP. Idempotente: reattach com uma sessão já
   * viva é um no-op (`CdpSession.attach()` já trata isso). */
  async function attachInspector(id: string): Promise<CdpAttachResult> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: "card not found" };
    if (entry.win.webContents.isDevToolsOpened()) {
      return { ok: false, error: t("error.closeDevtoolsFirst") };
    }
    if (!entry.cdp) {
      entry.cdp = createCdpSession(entry.win.webContents, (method, params) => {
        // Review adversarial, rodada 3, achado 1 (2026-09-09) — confirmado
        // no código real (não só por leitura do achado): `browser-cdp.ts`
        // já escuta `wc.debugger.on("detach", ...)` e forwarda como este
        // MESMO evento sintético `"__detached__"` por este MESMO callback
        // (ver doc comment do módulo `browser-cdp.ts`) — a sessão pode
        // cair por conta PRÓPRIA do Chromium, não só pelo nosso
        // `detachInspector` (o caso real: DevTools EXTERNO rouba o
        // protocolo, `browser-cdp.ts`'s doc comment: "abrir DevTools num
        // webContents com nosso debugger anexado dispara detach sozinho,
        // não erro"). Ganchado AQUI (no callback que já existe) em vez de
        // registrar um segundo `wc.debugger.on("detach", ...)` — sem isto,
        // `entry.networkEnableRefs` ficava preso no valor de antes do
        // roubo; na reconexão seguinte (`attachInspector` de novo, sessão
        // NOVA de verdade, domínios todos desabilitados) `trackedNetworkSend`
        // acharia — errado — que `Network` já estava habilitado por outra
        // coisa, pularia o `Network.enable` real, e os client hints da
        // emulação mobile voltariam a não ser aplicados: o bug original da
        // rodada 1 de volta, sem nenhum sinal de erro.
        if (method === "__detached__") entry.networkEnableRefs = 0;
        callbacks.onCdpEvent(id, method, params);
      });
    }
    const result = await entry.cdp.attach();
    // Pendentes #188 (UA+touch) — se a emulação mobile já estava ligada
    // (usuário reabriu o inspector, ou usou "Tentar novamente" depois de
    // fechar o DevTools real que tinha roubado o debugger), a sessão CDP
    // nova nasce SEM nada do que uma sessão anterior tinha aplicado —
    // `Emulation.setTouchEmulationEnabled` E o `Network.setUserAgentOverride`
    // (client hints) abaixo vivem NA sessão CDP, nenhum dos dois sobrevive
    // a um attach novo. `entry.originalUserAgent !== null` já É o sinal de
    // "mobile ativo agora" (ver doc comment do campo), reaproveitado em vez
    // de duplicar o booleano.
    if (result.ok && entry.originalUserAgent !== null) {
      void applyMobileCdpOverrides(entry, entry.originalUserAgent, true);
    }
    return result;
  }

  /** Chamado no UNMOUNT de `BrowserInspector.tsx` E em `destroy()`/
   * `destroyAll()` abaixo — idempotente nos dois casos, qual dos dois
   * rodar primeiro não importa. Detach sempre INCONDICIONAL de propósito
   * (achado 2 da rodada 3 cogitou um detach condicional à emulação mobile
   * pendurada nele e foi revertido): `BrowserInspector.tsx` (~linha 1521)
   * já desliga UA/dimensões/touch/hints juntos no cleanup de unmount do
   * painel, comentário no próprio arquivo — sem o painel aberto não sobra
   * UI pra sair do modo mobile, então a emulação NÃO deve sobreviver ao
   * fechamento. Não há "zumbi" pra corrigir aqui.
   *
   * Ainda assim desliga touch/hints explicitamente ANTES de derrubar a
   * sessão, em vez de confiar que o Chromium reverte isso sozinho ao
   * detach (não confirmado) — idempotente com o que `setDeviceEmulation`
   * já faz pro mesmo card, não importa qual dos dois cleanups roda
   * primeiro. */
  async function detachInspector(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry?.cdp) return;
    if (entry.originalUserAgent !== null) {
      await applyMobileCdpOverrides(entry, entry.originalUserAgent, false);
    }
    entry.cdp.detach();
    entry.cdp = null;
    entry.networkEnableRefs = 0;
  }

  /** Review adversarial, achado 1 (2026-09-09) — `Network.enable` sem um
   * `Network.disable` correspondente deixava o domínio ligado pro resto da
   * vida da sessão CDP sempre que a emulação mobile ligasse ao menos uma
   * vez (eventos de rede atravessando o IPC sem ninguém consumir), E um
   * `disable` ingênuo ao desligar a emulação derrubaria o monitoramento de
   * rede do usuário se a aba Network do inspector também tivesse habilitado
   * o domínio (`BrowserInspector.tsx`, linha ~1146, NUNCA desliga por
   * conta própria — ver doc comment de `Entry.networkEnableRefs`).
   * Contagem de uso: incrementa em QUALQUER `Network.enable` (venha da aba
   * Network ou da emulação mobile), decrementa em `Network.disable`, e só
   * repassa o comando de verdade pro CDP quando a contagem cruza a
   * fronteira relevante (0→1 pra habilitar, 1→0 pra desabilitar) — os dois
   * ÚNICOS pontos deste módulo que tocam esses métodos (`sendCdp`, exposto
   * ao inspector, e `applyMobileCdpOverrides` abaixo) passam por aqui. */
  function trackedNetworkSend(entry: Entry, method: "Network.enable" | "Network.disable"): Promise<CdpSendResult> {
    if (!entry.cdp) return Promise.resolve({ ok: false, error: "CDP session not attached" });
    if (method === "Network.enable") {
      entry.networkEnableRefs += 1;
      if (entry.networkEnableRefs > 1) return Promise.resolve({ ok: true, result: null });
    } else {
      entry.networkEnableRefs = Math.max(0, entry.networkEnableRefs - 1);
      if (entry.networkEnableRefs > 0) return Promise.resolve({ ok: true, result: null });
    }
    return entry.cdp.send(method);
  }

  async function sendCdp(id: string, method: string, params?: object): Promise<CdpSendResult> {
    const entry = entries.get(id);
    if (!entry?.cdp) return { ok: false, error: "CDP session not attached" };
    if (method === "Network.enable" || method === "Network.disable") return trackedNetworkSend(entry, method);
    return entry.cdp.send(method, params);
  }

  /** Pendentes #188 (UA+touch), correção do dono do repo (2026-09-09) —
   * `wc.setUserAgent` (chamado por `setDeviceEmulation` abaixo, o caminho
   * BASE, funciona sem CDP nenhum) só troca o header `User-Agent`. Os
   * client hints de baixa entropia que o Chromium manda em toda requisição
   * (`Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`) vêm de metadata interna do
   * embedder, não da string — um site que priorize o hint sobre a string
   * (o motivo original desta correção) continuaria vendo `?0`/"Linux" e
   * serviria desktop mesmo com a string dizendo Android/Mobile. Esta
   * função é o REFORÇO, só possível com sessão CDP anexada (o inspector
   * embutido aberto): `Network.setUserAgentOverride` aceita `userAgent`
   * (mesma string) + `userAgentMetadata`, que é o que de fato ajusta os
   * client hints (CDP docs, domínio Network — confirmado no protocolo
   * consultado nesta tarefa, não ao vivo: todo campo de `UserAgentMetadata`
   * é opcional, "missing optional values will be filled in by the target
   * with what it would normally use" — por isso só `mobile`/`platform` são
   * passados, o resto fica a cargo do Chromium).
   *
   * `Network.setUserAgentOverride` exige o domínio `Network` habilitado
   * antes (achado do protocolo consultado nesta tarefa,
   * ChromeDevTools/devtools-protocol#10: "this is unlike every other
   * method" — ainda assim true na versão consultada) — por isso passa por
   * `trackedNetworkSend` (achado 1 acima) em vez de `cdp.send` direto, nos
   * dois sentidos: habilita ao ligar mobile, desabilita ao desligar (só de
   * verdade se mais ninguém — a aba Network do inspector — ainda precisar).
   *
   * Retorna a Promise (não dispara fire-and-forget) porque `detachInspector`
   * (achado 2 acima) precisa AGUARDAR o desligamento terminar antes de
   * derrubar a sessão CDP — `setDeviceEmulation`/`attachInspector` chamam
   * com `void` quando não precisam esperar.
   *
   * Restaurar (`mobile: false`) manda a MESMA `userAgent` de origem sem
   * `userAgentMetadata` — não confirmado ao vivo que isso reverte os hints
   * pros valores reais do host (a doc do protocolo não descreve o caminho
   * de reset explicitamente); é a leitura mais direta da doc consultada,
   * mas fica registrado como suposição, não fato verificado. */
  async function applyMobileCdpOverrides(entry: Entry, baseUserAgent: string, mobile: boolean): Promise<void> {
    if (!entry.cdp?.isAttached()) return;
    const cdp = entry.cdp;
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? MOBILE_TOUCH_POINTS : 0 });
    if (mobile) {
      await trackedNetworkSend(entry, "Network.enable");
      await cdp.send("Network.setUserAgentOverride", { userAgent: buildMobileUserAgent(baseUserAgent), userAgentMetadata: { mobile: true, platform: "Android" } });
    } else {
      await cdp.send("Network.setUserAgentOverride", { userAgent: baseUserAgent });
      await trackedNetworkSend(entry, "Network.disable");
    }
  }

  /** Pendentes #188 — "modo responsivo real" pro mini-inspector embutido
   * no card (BrowserCard.tsx's `BrowserInspector`), pedido explícito do
   * usuário como alternativa ao DevTools real (que só sabe abrir numa
   * janela separada — offscreen não pinta a UI do DevTools, ver
   * `openDevTools` acima). `null` desliga a emulação.
   *
   * Achado ao vivo (2026-09-06): `wc.enableDeviceEmulation` NÃO é usado
   * aqui de propósito, apesar do nome sugerir que seria o mecanismo
   * óbvio. Testado e descartado: com `setContentSize(w,h)` +
   * `setZoomFactor(1)` sozinhos, `window.innerWidth` já bate exatamente
   * com `params.width` (confirmado: preset Mobile 390 → innerWidth
   * '390'). Adicionar `enableDeviceEmulation` por cima disso CORROMPE
   * esse resultado correto (innerWidth passa a reportar 980, nem o
   * tamanho do card nem o do preset) — um webContents offscreen não tem
   * o compositor nativo que uma janela on-screen tem por trás da API de
   * emulação, então `viewSize`/`screenSize` competem com o content size
   * real em vez de complementá-lo. Redimensionar o content size de
   * verdade (o que a página mede) já É a emulação, sem precisar da API. */
  function setDeviceEmulation(
    id: string,
    params: { width: number; height: number; deviceScaleFactor: number; mobile: boolean } | null,
  ) {
    const entry = entries.get(id);
    if (!entry) return;
    const wc = entry.win.webContents;
    if (!params) {
      // Não restaura o content size/zoom do supersample aqui de propósito
      // — quem desliga a emulação (BrowserInspector.tsx) sempre chama
      // `resize()` de novo logo em seguida com o tamanho real do card,
      // que já recalcula os dois juntos (ver doc comment de `resize`
      // abaixo). Restaurar às cegas aqui SEM saber o `w`/`h` atual do
      // card deixaria o content size (mudado abaixo, pro tamanho do
      // preset) sem zoom nenhum compensando.
      //
      // Pendentes #188 (UA+touch) — o UA/touch/client-hints, ao contrário
      // do content size, PRECISAM ser desfeitos aqui: se ninguém desligar,
      // a página fica presa servida como mobile (UA+hints) e reportando
      // touch dentro de um card agora desktop. Restaura o UA de ORIGEM
      // guardado (nunca reconstruído) e recarrega — sem reload a página já
      // rodando com JS/CSS de layout mobile não vira desktop sozinha,
      // mesmo o próximo request já saindo com o UA certo. `baseUA` é lido
      // ANTES de zerar `entry.originalUserAgent` — `applyMobileCdpOverrides`
      // abaixo precisa da string de origem mesmo depois do campo já
      // refletir "mobile desligado".
      if (entry.originalUserAgent !== null) {
        const baseUA = entry.originalUserAgent;
        wc.setUserAgent(baseUA);
        entry.originalUserAgent = null;
        wc.reload();
        void applyMobileCdpOverrides(entry, baseUA, false);
      }
      return;
    }
    // Pendentes #188 (UA+touch) — `params.mobile` chegava até aqui e era
    // IGNORADO (achado do doc comment acima, "modo responsivo real"); é o
    // sinal natural pra decidir UA+touch+hints, então passa a ser usado. Só
    // troca o UA (e recarrega) numa TRANSIÇÃO real desktop→mobile ou
    // mobile→desktop — `entry.originalUserAgent !== null` já significa
    // "mobile ligado agora" (ver doc comment do campo), então trocar
    // tamanho/DPR dentro do MESMO estado mobile (ex: girar, DPR, Mobile→
    // Tablet) não deve recarregar a página nem reenviar CDP à toa a cada
    // clique — touch e client hints já ficam corretos desde a transição.
    if (params.mobile && entry.originalUserAgent === null) {
      const baseUA = wc.getUserAgent();
      entry.originalUserAgent = baseUA;
      wc.setUserAgent(buildMobileUserAgent(baseUA));
      wc.reload();
      void applyMobileCdpOverrides(entry, baseUA, true);
    } else if (!params.mobile && entry.originalUserAgent !== null) {
      const baseUA = entry.originalUserAgent;
      wc.setUserAgent(baseUA);
      entry.originalUserAgent = null;
      wc.reload();
      void applyMobileCdpOverrides(entry, baseUA, false);
    }
    // Touch (`setTouchEmulationEnabled`, liga `navigator.maxTouchPoints` e
    // as media features `pointer: coarse`/`hover: none`) só na TRANSIÇÃO
    // acima, dentro de `applyMobileCdpOverrides` — DE PROPÓSITO sem
    // `setEmitTouchEventsForMouse`: esse segundo sintetizaria eventos de
    // toque a PARTIR do mouse, o que arrisca degradar rolagem por wheel e
    // seleção de texto no card (ver briefing da tarefa) — risco que só se
    // prova com o app aberto, e sem ganho aqui: o objetivo é o
    // layout/servidor mobile, não interação por toque de verdade num card
    // que só recebe mouse/teclado do host. Se o CDP ainda não tinha anexado
    // na hora da transição (corrida com `attachInspector`, ou DevTools real
    // roubou o debugger), `attachInspector` acima reaplica isto assim que
    // (re)anexar — `entry.originalUserAgent` já reflete o estado mobile
    // nessa hora.
    // Achado ao vivo (2026-09-07, pedido explícito do usuário: "espero que
    // o size de resolução seja de verdade"): até aqui `deviceScaleFactor`
    // era só um número decorativo no dropdown de DPR — `setContentSize`
    // usava `params.width/height` puros, então um preset "Mobile" (DPR 3)
    // e um "Desktop" (DPR 1) do MESMO tamanho lógico rasterizavam
    // IDENTICOS, sem nenhum ganho real de nitidez. Mesma técnica já usada
    // por `resize()` abaixo (supersample fixo pra navegação normal):
    // `setZoomFactor(factor)` + `setContentSize(w×factor, h×factor)` juntos
    // — nunca só um dos dois (bug 1 do doc comment de `resize`) — faz a
    // página ACREDITAR que seu viewport CSS continua largura/altura lógica
    // (zoom cancela o "mais conteúdo cabe"), enquanto o paint buffer real
    // fica `deviceScaleFactor`× maior, exatamente o que um DPR de
    // dispositivo real significa. Sem cap extra (BROWSER_MAX_DENSITY é
    // sobre supersample AUTOMÁTICO de navegação comum, não sobre um DPR de
    // preset escolhido explicitamente pelo usuário; o próprio seletor já
    // limita a 1x/2x/3x).
    const factor = Math.max(1, params.deviceScaleFactor);
    wc.setZoomFactor(factor);
    entry.win.setContentSize(Math.max(1, Math.round(params.width * factor)), Math.max(1, Math.round(params.height * factor)));
  }

  // Trilha A do navegador (SCREEN_SPACE_PROJECTION_PLAN.md §0.3's "Trilha
  // A do navegador" note, executada 2026-08-31) originalmente também
  // multiplicava a resolução offscreen pelo zoom do board, mesma ideia do
  // `fontSize` do terminal escalando com o zoom. Revertido a pedido
  // explícito do usuário (2026-09-02: "o navegador não precisa ser afetado
  // pelo efeito do zoom aumentar ou diminuir a fonte") — era, na prática,
  // a causa da "resolução quase 4K" que ele notou num teste de zoom bem
  // alto: em `zoom` perto do antigo teto de 3, `factor` chegava a
  // 3×`scaleFactor`, MUITO acima da densidade real do monitor. `zoom` só
  // existe agora no parâmetro por compatibilidade de assinatura com os
  // chamadores existentes (`BrowserCard.tsx`/`browser:resize`) — ignorado
  // aqui de propósito; a resolução do card depende só do tamanho de mundo
  // do rect e do `scaleFactor` real do monitor (Item 6 abaixo), nunca do
  // zoom interativo do board.
  //
  // Item 6 (Trilha B, docs/SCREEN_SPACE_PROJECTION_PLAN.md) — multiplica
  // por `entry.scaleFactor`. IMPORTANTE, achado ao vivo testando isto
  // (2026-09-01, 3 scripts de diagnóstico isolados): `setContentSize`
  // SOZINHO não é supersampling HiDPI de verdade. Confirmado que
  // `webPreferences.offscreen.deviceScaleFactor` é um no-op pro raster
  // real nesta versão/plataforma de Electron (image.getSize() idêntico
  // byte a byte independente do valor) — e pra flag global do Chromium
  // `--force-device-scale-factor` (o `devicePixelRatio` da própria página
  // muda, o raster não). `setContentSize` é a alavanca que muda a
  // resolução real do paint buffer nesta build, mas é TAMBÉM o mesmo
  // número que o layout CSS da página embutida usa como seu próprio
  // viewport — SOZINHO, ele faz a página embutida ACREDITAR que seu
  // viewport é N× maior do que o card mostra visualmente: detalhe mais
  // nítido por pixel, mas proporcionalmente MAIS da página cabe no mesmo
  // card na tela (conteúdo lógico fica menor, não só mais nítido).
  //
  // Supersample fixo (BROWSER_SUPERSAMPLE, pedido explícito do usuário,
  // 2026-09-02: "mandar renderizar o triplo da resolução e aumentar para
  // escala 1:1") — fecha exatamente essa lacuna. `webContents.
  // setZoomFactor()` sozinho já era sabido no-op pro TAMANHO do paint
  // buffer (`getZoomFactor()` reporta certo, o buffer não muda) — mas
  // COMBINADO com um `setContentSize` já maior, o zoom da página faz o
  // conteúdo renderizar N× maior DENTRO desse viewport N× maior,
  // cancelando o "mais página cabe no card": a mesma área lógica fica
  // visível de antes, só que com N²× mais pixels reais de raster por
  // trás — supersample de verdade. Verificado ao vivo com screenshot lado
  // a lado (mesma janela, mesmo card, mesmo crop de tela): texto
  // visivelmente mais nítido, MESMA quantidade de conteúdo visível — e
  // clique continua preciso com o zoom ativo (`sendInputEvent` opera no
  // espaço de coordenadas da JANELA, não no espaço pós-zoom da página,
  // mesmo motivo de zoom de página nunca quebrar clique num browser
  // real). Custo real medido (conteúdo denso, JPEG qualidade 90): ~5×
  // bytes por frame, não 9× — JPEG comprime o detalhe extra bem melhor
  // que a contagem de pixels sugeriria (medido só em scaleFactor=1 — ver
  // os dois achados ao vivo/fixes no doc comment de BROWSER_SUPERSAMPLE/
  // BROWSER_MAX_DENSITY acima pro que mudou desde então).
  function resize(id: string, w: number, h: number, _zoom = 1) {
    const entry = entries.get(id);
    if (!entry) return;
    // `factor` é o fator TOTAL de densidade — content size E zoom da
    // página são sempre o MESMO número (nunca duas fontes de verdade
    // separadas, achado ao vivo/bug 1 acima). `BROWSER_MAX_DENSITY` teta o
    // fator TOTAL (não só o supersample) — quanto maior o `scaleFactor`
    // real do monitor, menos supersample extra fica por cima dele.
    const factor = Math.min(entry.scaleFactor * BROWSER_SUPERSAMPLE, maxDensityOverride ?? BROWSER_MAX_DENSITY);
    entry.win.webContents.setZoomFactor(factor);
    entry.win.setContentSize(Math.max(1, Math.round(w * factor)), Math.max(1, Math.round(h * factor)));
  }

  /** Test-only (scripts/verify) — the real content-pixel size the
   * offscreen `BrowserWindow` is currently rasterizing at, straight from
   * Electron itself. Used to prove `resize`'s scaleFactor scaling actually
   * happened, the same "read the real instance, don't infer it" spirit
   * as `terminal-registry.ts`'s `getTerminalFontSize`. */
  function getContentSize(id: string): { w: number; h: number; scaleFactor: number } | null {
    const entry = entries.get(id);
    if (!entry) return null;
    const [w, h] = entry.win.getContentSize();
    return { w, h, scaleFactor: entry.scaleFactor };
  }

  /** Achado ao vivo (2026-09-02, pedido explícito do usuário: "não apenas
   * monitor 4K" — resolução real também precisa reagir a TROCAR de
   * monitor com a janela aberta, não só ao zoom do board). `entry.
   * scaleFactor` (item 6 acima) era resolvido uma ÚNICA vez, em
   * `create()` — arrastar a janela do app pra outro monitor com
   * scaleFactor diferente nunca reavaliava nada, o navegador embutido
   * continuava rasterizando na densidade do monitor ONDE FOI CRIADO, não
   * do monitor onde está agora. `callbacks.getScaleFactor()` em si já é
   * dinâmico (consulta `screen.getDisplayMatching(win.getBounds())` na
   * hora) — só nunca era CHAMADO de novo. `main/index.ts` chama isto pra
   * cada card vivo quando a janela principal se move (`win.on("moved")`)
   * ou quando o SO reporta mudança de métricas de display (`screen.on(
   * "display-metrics-changed")`) — devolve o novo valor só quando ele
   * REALMENTE mudou (evita round-trip de IPC/resize à toa em todo micro-
   * movimento de janela que não cruza monitor nenhum). */
  function refreshScaleFactor(id: string): number | null {
    const entry = entries.get(id);
    if (!entry) return null;
    const next = callbacks.getScaleFactor();
    if (next === entry.scaleFactor) return null;
    entry.scaleFactor = next;
    return next;
  }

  /** Ids de todo browser card com uma `BrowserWindow` offscreen viva —
   * usado por `refreshScaleFactor`'s caller (main/index.ts) pra saber
   * quais cards revisitar num evento de troca de monitor, sem precisar
   * de acesso direto ao Map interno. */
  function liveIds(): string[] {
    return [...entries.keys()];
  }

  /** Test-only (mesmo raciocínio de `testMakeEditable`) — grava
   * `entry.scaleFactor` direto, sem consultar `callbacks.getScaleFactor()`
   * de verdade. Simula só o VALOR que viria de um monitor diferente; o
   * resto do caminho real (IPC pro renderer, `BrowserCard.tsx` re-
   * disparando resize) roda sem nenhuma simulação — ver o handler
   * `browser:test-force-scale-factor` (main/index.ts) pro porquê. */
  function forceScaleFactor(id: string, scaleFactor: number) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.scaleFactor = scaleFactor;
  }

  /** EXPERIMENTAL, test-only, 2026-09-02 — investigando o "ponto doce" de
   * `BROWSER_MAX_DENSITY` (pedido do usuário: achar o teto certo pra 4K,
   * depois telas maiores, depois 1080p). Override em runtime pra varrer
   * candidatos sem rebuild a cada valor — não é a fiação real, que
   * continua sendo a constante `BROWSER_MAX_DENSITY`. Removível quando o
   * valor final for decidido e virar a constante de verdade. */
  let maxDensityOverride: number | null = null;
  function testSetMaxDensity(value: number | null) {
    maxDensityOverride = value;
  }

  /** Pauses/resumes actual compositing (`stopPainting`/`startPainting`),
   * not just frame delivery — an off-viewport card costs nothing instead of
   * still paying for paints nobody draws. */
  function setVisible(id: string, visible: boolean) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.visible = visible;
    const wc = entry.win.webContents;
    if (visible && !wc.isPainting()) wc.startPainting();
    else if (!visible && wc.isPainting()) wc.stopPainting();
  }

  /** Pre-release audit P2 — a visible-but-not-topmost card still needs
   * to paint (it's genuinely on screen), just not at full rate: nobody's
   * watching it move right now the way they are the one they raised. */
  function setFocused(id: string, focused: boolean) {
    entries.get(id)?.win.webContents.setFrameRate(focused ? FOCUSED_FRAME_RATE : UNFOCUSED_FRAME_RATE);
  }

  function sendMouseEvent(id: string, evt: BrowserMouseEvent) {
    const entry = entries.get(id);
    if (!entry) return;
    // A `show: false` offscreen window never becomes OS-active, and
    // Chromium's own click-to-focus-a-form-field path checks the
    // WebContents' focus state, not just where the synthetic click lands —
    // without this, clicking into a real <input>/<textarea> on the page
    // looked like nothing happened (no caret, no typing) even though the
    // click itself was reaching the right coordinates. Real windows get
    // this for free from the OS when the user clicks into them; this is
    // the offscreen equivalent, done explicitly on every mousedown.
    if (evt.type === "mouseDown") entry.win.webContents.focus();
    entry.win.webContents.sendInputEvent({
      type: evt.type,
      x: Math.round(evt.x),
      y: Math.round(evt.y),
      button: evt.button ?? "left",
      clickCount: evt.clickCount ?? 1,
    });
  }

  function sendWheelEvent(id: string, evt: BrowserWheelEvent) {
    entries.get(id)?.win.webContents.sendInputEvent({
      type: "mouseWheel",
      x: Math.round(evt.x),
      y: Math.round(evt.y),
      deltaX: evt.deltaX,
      deltaY: evt.deltaY,
      canScroll: true,
    });
  }

  function sendKeyEvent(id: string, evt: BrowserKeyEvent) {
    entries.get(id)?.win.webContents.sendInputEvent({
      type: evt.type,
      keyCode: evt.keyCode,
      modifiers: evt.modifiers,
    });
  }

  // Item 26, teclado — 3 gaps reais que `sendInputEvent`'s keyDown/char
  // vocabulary não cobre (BrowserCard.tsx). Os três usam métodos reais
  // do WebContents em vez de tentar sintetizar mais eventos de teclado:
  // - `insertText`: composição de IME (chinês/japonês/coreano) não
  //   corresponde a teclas físicas individuais — o texto final composto
  //   (evento `compositionend` do lado do renderer) precisa ser inserido
  //   de uma vez, não caractere por caractere via `char`.
  // - `paste`: um keyDown sintético de Ctrl+V nunca insere o conteúdo
  //   real do clipboard sozinho (`sendInputEvent` não dispara isso) —
  //   precisa do método dedicado do Electron.
  // - `copy`/`cut`: mesma classe de problema, mesma solução.
  function insertText(id: string, text: string) {
    void entries.get(id)?.win.webContents.insertText(text);
  }
  function pasteText(id: string) {
    entries.get(id)?.win.webContents.paste();
  }
  function copyText(id: string) {
    entries.get(id)?.win.webContents.copy();
  }
  function cutText(id: string) {
    entries.get(id)?.win.webContents.cut();
  }

  /** Test-only (see main/index.ts's `app.isPackaged` guard) — about:blank
   * has no editable field by default, needed to give the paste/copy/IME
   * smoke test a real target without depending on a real third-party
   * page's markup. */
  async function testMakeEditable(id: string) {
    const wc = entries.get(id)?.win.webContents;
    if (!wc) return;
    // Also mirrors every keydown into the page's own title (observable via
    // the existing onTitle IPC channel) — the only page-level side effect
    // a named key like "F5" has on a bare offscreen page with no browser
    // chrome/menu attached (no default reload-on-F5 outside a real
    // browser shell), so this is the smoke test's way to prove a named
    // key genuinely reaches the embedded page's own DOM listeners.
    await wc.executeJavaScript(
      "document.body.contentEditable = 'true'; document.body.focus();" +
        "window.addEventListener('keydown', (e) => { document.title = 'key:' + e.key + ':' + e.ctrlKey; });",
    );
  }

  // DESIGN-BACKLOG.md item 21, ponto 9, achado 5 — an agent could only
  // ever get PIXELS of a browser card (acbridge/MCP `snapshot`), never
  // its actual content; useless for a provider with no image input, and
  // wasteful for one that has it but just needs "what does this page
  // say". `executeJavaScript` is a plain Electron primitive already
  // available on every WebContents here — no new architecture. Truncated
  // rather than returned raw: a complex real page's `innerText` can run
  // to hundreds of KB of mostly-nav/footer noise, which is worse than
  // useless stuffed whole into an agent's context.
  const MAX_PAGE_TEXT_CHARS = 20_000;
  async function getPageText(id: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript("document.body ? document.body.innerText : ''");
      const text = typeof raw === "string" ? raw : "";
      const truncated = text.length > MAX_PAGE_TEXT_CHARS;
      return { ok: true, text: truncated ? text.slice(0, MAX_PAGE_TEXT_CHARS) : text, truncated };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // DESIGN-BACKLOG.md §2.1 "MCP do Navegador — Orquestração Completa" —
  // até aqui um agente só conseguia ABRIR (`open_url`) e LER
  // (`getPageText`) um card de navegador, nunca agir dentro dele. Os 6
  // métodos abaixo (mais `clickSelector`/`query`/`evalJs` usando
  // `executeJavaScript`, mesmo primitivo já usado por `getPageText`) dão
  // controle real, sem depender do humano estar olhando pra clicar.

  /** Um clique de verdade é down+up, não só um dos dois — e um `mouseMove`
   * antes garante que a página viu o cursor "chegar" no elemento (hover)
   * antes do clique, igual uma interação humana real. */
  function clickAtPoint(id: string, x: number, y: number): { ok: true } | { ok: false; error: string } {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    sendMouseEvent(id, { type: "mouseMove", x, y });
    sendMouseEvent(id, { type: "mouseDown", x, y, button: "left", clickCount: 1 });
    sendMouseEvent(id, { type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return { ok: true };
  }

  /** Resolve o centro real do elemento via `executeJavaScript`
   * (`querySelector` + `scrollIntoView` + `getBoundingClientRect`) antes
   * de clicar — muito mais preciso que pedir pro agente adivinhar x/y a
   * partir de um screenshot, e resiliente a scroll/zoom/resize desde a
   * última vez que a página foi vista. */
  /**
   * Achado ao vivo (2026-09-01, relato de um agente que dirigiu o navegador
   * daqui): um `browser_click` com um seletor estilo Playwright
   * (`button:has-text('Salvar')`) falhava com "Script failed to execute,
   * this normally means an error was thrown" — a mensagem genérica do
   * Electron pra QUALQUER exceção dentro do `executeJavaScript`. O agente
   * não tinha como saber que o problema era o seletor, muito menos que o
   * motor aqui é o `querySelector` do próprio navegador (CSS puro) e não o
   * CSS estendido do Playwright; teve que adivinhar e cair pra
   * `browser_eval` com busca manual por `textContent`.
   *
   * O `try/catch` DENTRO da página é o ponto: um seletor inválido lança
   * `SyntaxError` no `querySelector`, e capturá-lo lá permite distinguir
   * três casos que antes viravam a mesma frase — seletor inválido,
   * seletor válido sem correspondência, e uma falha de verdade na
   * avaliação. Compartilhado por click/scroll/query pra que os três deem a
   * mesma resposta ao mesmo erro.
   *
   * `body` é interpolado como corpo de função e roda com `el` já resolvido.
   */
  async function withSelector<T>(
    id: string,
    selector: string,
    body: string,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(`
        (() => {
          let el;
          try {
            el = document.querySelector(${JSON.stringify(selector)});
          } catch (err) {
            return { __selectorError: String((err && err.message) || err) };
          }
          if (!el) return { __noMatch: true };
          return { __value: (function (el) { ${body} })(el) };
        })()
      `);
      const tagged = raw as { __selectorError?: string; __noMatch?: boolean; __value?: T };
      if (tagged?.__selectorError !== undefined) {
        return {
          ok: false,
          error:
            `invalid CSS selector ${JSON.stringify(selector)}: ${tagged.__selectorError}. ` +
            `Selectors here go straight to the page's own document.querySelector — plain CSS only. ` +
            `Playwright/Puppeteer extensions (:has-text(...), text=..., >> , xpath=...) are NOT supported; ` +
            `use a CSS selector, or browser_eval if you need to match on text content.`,
        };
      }
      if (tagged?.__noMatch) return { ok: false, error: `no element matches selector ${JSON.stringify(selector)}` };
      return { ok: true, value: tagged.__value as T };
    } catch (err) {
      return { ok: false, error: `failed to evaluate selector ${JSON.stringify(selector)} in the page: ${String(err)}` };
    }
  }

  async function clickSelector(
    id: string,
    selector: string,
  ): Promise<{ ok: true; x: number; y: number } | { ok: false; error: string }> {
    const found = await withSelector<{ x: number; y: number }>(
      id,
      selector,
      `el.scrollIntoView({ block: "center", inline: "center" });
       const r = el.getBoundingClientRect();
       return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
    );
    if (!found.ok) return found;
    const { x, y } = found.value;
    clickAtPoint(id, x, y);
    return { ok: true, x, y };
  }

  /** `selector` given: focus that field first (via `clickSelector`) so
   * the typed text lands where the caller actually meant, instead of
   * whatever happened to be focused already. Uses `insertText` — same
   * IME-safe, "whole string at once" method item 26 already established
   * (see its own doc comment above), never synthesized char by char. */
  async function typeText(id: string, text: string, selector?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    if (selector) {
      const clicked = await clickSelector(id, selector);
      if (!clicked.ok) return clicked;
    }
    insertText(id, text);
    return { ok: true };
  }

  /** `selector` given: scrolls that element's own container (a nested
   * scrollable div, not necessarily the whole page) by resolving its
   * center point first, same mechanism as `clickSelector`. */
  async function scroll(
    id: string,
    dx: number,
    dy: number,
    selector?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    let x = 0;
    let y = 0;
    if (selector) {
      const found = await withSelector<{ x: number; y: number }>(
        id,
        selector,
        `const r = el.getBoundingClientRect();
         return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`,
      );
      if (!found.ok) return found;
      ({ x, y } = found.value);
    }
    // Same sign inversion BrowserCard.tsx's onCanvasWheel already applies
    // before calling sendWheel — Electron's sendInputEvent mouseWheel
    // takes ticks in the opposite convention from a normal DOM
    // WheelEvent (confirmed live there: unnegated deltas scrolled
    // backwards). `dx`/`dy` here are the tool's own natural "positive
    // scrolls down/right" contract (what an MCP/acbridge caller expects
    // from a scroll tool); the Electron quirk stays encapsulated here
    // rather than leaking into the tool's contract.
    sendWheelEvent(id, { x, y, deltaX: -dx, deltaY: -dy });
    return { ok: true };
  }

  type QueryResult = {
    exists: boolean;
    text?: string;
    value?: string;
    href?: string;
    checked?: boolean;
    disabled?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
  };

  /** Lets an agent inspect what's really on the page (existence, text,
   * form value, link target, checked/disabled state, real on-screen
   * rect) without depending on a screenshot — same `executeJavaScript`
   * primitive as `getPageText`, just scoped to one element. */
  async function query(id: string, selector: string): Promise<({ ok: true } & QueryResult) | { ok: false; error: string }> {
    const found = await withSelector<QueryResult>(
      id,
      selector,
      `const r = el.getBoundingClientRect();
       return {
         exists: true,
         text: (el.innerText ?? el.textContent ?? "").slice(0, 2000),
         value: "value" in el ? String(el.value) : undefined,
         href: "href" in el ? String(el.href) : undefined,
         checked: "checked" in el ? Boolean(el.checked) : undefined,
         disabled: "disabled" in el ? Boolean(el.disabled) : undefined,
         rect: { x: r.x, y: r.y, width: r.width, height: r.height },
       };`,
    );
    // `exists: false` continua sendo uma RESPOSTA, não um erro: perguntar
    // "esse elemento está na página?" e ouvir "não" é o uso normal desta
    // tool. Só o seletor inválido (e uma falha real de avaliação) viram
    // `ok: false` — é essa a distinção que faltava.
    if (!found.ok) {
      if (found.error.startsWith("no element matches")) return { ok: true, exists: false };
      return found;
    }
    return { ok: true, ...found.value };
  }

  // Achado ao vivo (2026-08-31) — `get_page_text`'s "no consent needed"
  // precedent (item 21 ponto 9 achado 5) covers READ-ONLY access; this
  // runs ARBITRARY agent-supplied JS in the page's real context, which
  // can read cookies/session/localStorage the same way a real DevTools
  // console could. Decisão explícita do usuário: expor mesmo assim, sem
  // gate humano — a `description` da tool MCP (mcp-server.ts) deixa esse
  // poder visível pro agente em vez de escondê-lo atrás de uma descrição
  // genérica.
  const MAX_EVAL_RESULT_CHARS = 20_000;
  async function evalJs(id: string, js: string): Promise<{ ok: true; result: string; truncated: boolean } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(js);
      let result: string;
      try {
        result = JSON.stringify(raw) ?? String(raw);
      } catch {
        result = String(raw);
      }
      const truncated = result.length > MAX_EVAL_RESULT_CHARS;
      return { ok: true, result: truncated ? result.slice(0, MAX_EVAL_RESULT_CHARS) : result, truncated };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Pendentes #188 — aba Application do mini-inspector (real, não
   * "planejado" — o gap não era CDP nenhum). Só local/session storage:
   * cookies já vêm de `getCookies` abaixo (via `session.cookies.get`,
   * processo main) — combinar os dois é responsabilidade de quem monta a
   * UI da aba (BrowserInspector.tsx), não deste registry. */
  async function getLocalSessionStorage(id: string): Promise<({ ok: true } & LocalSessionStorage) | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw = (await entry.win.webContents.executeJavaScript(`
        (() => {
          const local = [];
          for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); local.push([k, localStorage.getItem(k)]); }
          const session = [];
          for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); session.push([k, sessionStorage.getItem(k)]); }
          return { local, session };
        })()
      `)) as LocalSessionStorage;
      return { ok: true, local: raw.local, session: raw.session };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Remove uma entrada só (não a área inteira) de local/session storage —
   * remoção de cookie fica com quem já dono da leitura (`getCookies`),
   * evita dois caminhos escrevendo na mesma sessão de card. */
  async function deleteLocalSessionItem(
    id: string,
    area: "local" | "session",
    key: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      await entry.win.webContents.executeJavaScript(`${area === "local" ? "localStorage" : "sessionStorage"}.removeItem(${JSON.stringify(key)})`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  function getConsole(id: string, level?: string, limit?: number): { ok: true; messages: ConsoleEntry[] } | { ok: false; error: string } {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    const filtered = level ? entry.console.filter((m) => m.level === level) : entry.console;
    // Do FIM da lista: o interessante quase sempre é o que acabou de
    // acontecer, não o que a página logou ao carregar.
    return { ok: true, messages: limit ? filtered.slice(-limit) : filtered };
  }

  /** Aba Application do mini-inspector (Pendentes #188, pedido de coluna
   * completa 2026-09-06) — cookies NÃO passam por `evalJs`/`document.
   * cookie` de propósito: JS de página nunca enxerga um cookie `HttpOnly`
   * (por design do próprio navegador) nem seus atributos de verdade
   * (domain/path/expiry/secure/sameSite, só `nome=valor`). `session.
   * cookies.get` é uma API do Electron NO PROCESSO MAIN, escopada à
   * partition isolada deste card (`create()` acima) — dá a tabela real
   * que o DevTools mostra, sem precisar de CDP. */
  async function getCookies(id: string): Promise<{ ok: true; cookies: CookieEntry[] } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const url = entry.win.webContents.getURL();
      const raw = await entry.win.webContents.session.cookies.get(url ? { url } : {});
      return {
        ok: true,
        cookies: raw.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain ?? "",
          path: c.path ?? "/",
          expirationDate: c.expirationDate,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: c.sameSite ?? "unspecified",
        })),
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Aba Sources do mini-inspector (DESIGN-BACKLOG.md §2.1 item 7). Achado
  // ao planejar: buscar o conteúdo de um script via `evalJs`/`fetch()` DE
  // DENTRO da página embutida bateria direto no mesmo teto de truncamento
  // de `evalJs` (`MAX_EVAL_RESULT_CHARS`, 20_000 chars) que já quebrou o
  // Elements/Computed duas vezes nesta mesma sessão — um bundle JS real
  // facilmente passa disso. `session.fetch()` (não `net.fetch()`, que
  // sempre usa a sessão DEFAULT — achado checando os tipos: `net.fetch`
  // não aceita `session` no init, só `ses.fetch()` na própria `Session`
  // tem esse método) roda aqui no processo MAIN, fora
  // do round-trip JSON de `evalJs` — usa a partition/sessão ISOLADA deste
  // card (mesma ideia de `getCookies` acima) e não sofre CORS (não é uma
  // chamada de dentro de uma página, é o processo Node buscando um
  // recurso), então funciona pra scripts cross-origin que uma `fetch()`
  // de dentro da própria página rejeitaria. Teto próprio, bem maior que o
  // de `evalJs` (esse texto nunca passa pelo `JSON.stringify`+parse do
  // round-trip de página): 300_000 chars é generoso pra ler um arquivo
  // fonte real sem deixar a UI travada tentando renderizar um bundle
  // minificado de vários MB inteiro.
  const MAX_SOURCE_CHARS = 300_000;
  async function fetchSource(id: string, url: string): Promise<{ ok: true; content: string; truncated: boolean; totalChars: number } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const res = await entry.win.webContents.session.fetch(url);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
      const full = await res.text();
      return { ok: true, content: full.slice(0, MAX_SOURCE_CHARS), truncated: full.length > MAX_SOURCE_CHARS, totalChars: full.length };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Aba Performance do mini-inspector (DESIGN-BACKLOG.md §2.1 item 8).
  // FPS ao vivo já é possível sem nada novo aqui (o próprio `browser:
  // frame`/`onFrame` que BrowserCard.tsx já escuta pra desenhar — o
  // inspector escuta o MESMO evento em paralelo e mede o intervalo entre
  // chegadas, tudo no renderer, ver BrowserInspector.tsx). O que só dá
  // pra medir aqui no processo MAIN, sem CDP: CPU/memória REAIS do
  // processo offscreen deste card via `app.getAppMetrics()` (a mesma API
  // por trás do Task Manager do Chrome/Electron) — não profiling de
  // verdade (call stacks, flame graph, sample de JS), só o que
  // `getOSProcessId()` + a tabela de métricas do app já expõem de graça.
  function getProcessStats(id: string): { ok: true; cpuPercent: number; memoryMB: number } | { ok: false; error: string } {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    const pid = entry.win.webContents.getOSProcessId();
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    if (!metric) return { ok: false, error: t("error.processMetric") };
    return { ok: true, cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10, memoryMB: Math.round((metric.memory.workingSetSize / 1024) * 10) / 10 };
  }

  function getNetwork(id: string, opts: { status?: number; failedOnly?: boolean; urlContains?: string; limit?: number } = {}) {
    const entry = entries.get(id);
    if (!entry) return { ok: false as const, error: `no browser card with id "${id}"` };
    let list = entry.network;
    // `failedOnly` inclui erro de transporte (`status: null`), não só
    // 4xx/5xx — "a chamada de salvar não deu certo" abrange as duas
    // coisas, e um DNS/CORS falhando é justamente o caso que não aparece
    // em lugar nenhum na tela.
    if (opts.failedOnly) list = list.filter((r) => r.error !== undefined || r.status === null || r.status >= 400);
    if (opts.status !== undefined) list = list.filter((r) => r.status === opts.status);
    if (opts.urlContains) list = list.filter((r) => r.url.includes(opts.urlContains as string));
    return { ok: true as const, requests: opts.limit ? list.slice(-opts.limit) : list };
  }

  /**
   * Espera uma condição na página em vez de dormir e torcer (achado ao
   * vivo 2026-09-01). Polling e não MutationObserver de propósito: o
   * observer teria que ser injetado, sobreviver a navegação e ser
   * desmontado sem vazar, e o custo de um `executeJavaScript` a cada
   * 200ms numa página é irrelevante perto disso.
   */
  const WAIT_POLL_MS = 200;
  async function waitFor(
    id: string,
    opts: { selector?: string; text?: string; gone?: boolean; timeoutMs?: number },
  ): Promise<{ ok: true; waitedMs: number } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    if (!opts.selector && !opts.text) return { ok: false, error: "need either selector or text" };
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const started = Date.now();
    const probe = opts.selector
      ? `(() => { try { return !!document.querySelector(${JSON.stringify(opts.selector)}); } catch (err) { return { __selectorError: String((err && err.message) || err) }; } })()`
      : `(() => (document.body ? document.body.innerText : "").includes(${JSON.stringify(opts.text ?? "")}))()`;
    while (Date.now() - started < timeoutMs) {
      if (entries.get(id) !== entry) return { ok: false, error: `browser card "${id}" closed while waiting` };
      let present: unknown;
      try {
        present = await entry.win.webContents.executeJavaScript(probe);
      } catch (err) {
        return { ok: false, error: `failed to evaluate the wait condition: ${String(err)}` };
      }
      // Um seletor inválido nunca vai ficar verdadeiro — falha na hora em
      // vez de gastar o timeout inteiro e reportar "não apareceu".
      if (present && typeof present === "object" && "__selectorError" in present) {
        return { ok: false, error: `invalid CSS selector ${JSON.stringify(opts.selector)}: ${String((present as { __selectorError: string }).__selectorError)}` };
      }
      if (Boolean(present) === !opts.gone) return { ok: true, waitedMs: Date.now() - started };
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
    const what = opts.selector ? `selector ${JSON.stringify(opts.selector)}` : `text ${JSON.stringify(opts.text)}`;
    return { ok: false, error: `timed out after ${timeoutMs}ms waiting for ${what} to ${opts.gone ? "disappear" : "appear"}` };
  }

  /**
   * Achado ao vivo (2026-09-01): "não existe snapshot por árvore de
   * acessibilidade / ref pra mirar um elemento sem já saber o seletor" — o
   * agente teve que cair pra `browser_eval` com
   * `querySelectorAll` + comparação manual de `textContent` pra achar o
   * botão "Adicionar nota".
   *
   * Isto é o mínimo que resolve o problema real, não uma árvore de
   * acessibilidade de verdade: lista o que é INTERATIVO e VISÍVEL, com o
   * nome que um humano lê na tela, e carimba `data-stellar-ref` em cada um
   * pra que `browser_click`/`browser_type` possam mirar por `ref` depois.
   *
   * Três decisões que o formato exige:
   *
   *  - **Nome acessível na ordem certa**: `aria-label`, depois o `<label>`
   *    associado, depois `placeholder`/`title`/`alt`/`value`, e só então o
   *    texto visível. Um botão de ícone só tem `aria-label`; um input só
   *    tem label ou placeholder. Cair direto no `innerText` acharia
   *    "" pra metade dos controles de uma UI real.
   *  - **Só o que está visível**: `getClientRects().length` mais
   *    `visibility`/`opacity`. Um menu fechado tem os itens no DOM e
   *    mirá-los produz um clique que não acontece — pior que não listar.
   *  - **Os refs são reemitidos a cada chamada**, e o carimbo anterior é
   *    limpo. Um ref é válido até a próxima navegação ou re-render, igual
   *    ao Playwright MCP: guardar ref velho e clicar depois é justamente o
   *    erro que uma numeração estável convidaria.
   */
  const SNAPSHOT_MAX_ELEMENTS = 400;
  async function pageSnapshot(id: string): Promise<{ ok: true; url: string; title: string; elements: PageElement[]; truncated: boolean } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const raw: unknown = await entry.win.webContents.executeJavaScript(`
        (() => {
          const SEL = [
            "a[href]", "button", "input", "select", "textarea", "summary",
            "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
            "[role=tab]", "[role=menuitem]", "[role=option]", "[role=switch]",
            "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
          ].join(",");
          for (const old of document.querySelectorAll("[data-stellar-ref]")) old.removeAttribute("data-stellar-ref");
          function visible(el) {
            if (el.getClientRects().length === 0) return false;
            const st = getComputedStyle(el);
            return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0;
          }
          function accessibleName(el) {
            const aria = el.getAttribute("aria-label");
            if (aria && aria.trim()) return aria.trim();
            const labelledBy = el.getAttribute("aria-labelledby");
            if (labelledBy) {
              const parts = labelledBy.split(/\\s+/).map((x) => document.getElementById(x)).filter(Boolean);
              const joined = parts.map((n) => (n.innerText || n.textContent || "").trim()).join(" ").trim();
              if (joined) return joined;
            }
            if (el.id) {
              const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) {
                const t = (lbl.innerText || lbl.textContent || "").trim();
                if (t) return t;
              }
            }
            const closestLabel = el.closest("label");
            if (closestLabel) {
              const t = (closestLabel.innerText || closestLabel.textContent || "").trim();
              if (t) return t;
            }
            for (const attr of ["placeholder", "title", "alt", "name"]) {
              const v = el.getAttribute(attr);
              if (v && v.trim()) return v.trim();
            }
            const text = (el.innerText || el.textContent || "").trim();
            if (text) return text.replace(/\\s+/g, " ").slice(0, 120);
            if (el.value) return String(el.value).slice(0, 120);
            return "";
          }
          function roleOf(el) {
            const explicit = el.getAttribute("role");
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === "a") return "link";
            if (tag === "button" || tag === "summary") return "button";
            if (tag === "select") return "combobox";
            if (tag === "textarea") return "textbox";
            if (tag === "input") {
              const t = (el.getAttribute("type") || "text").toLowerCase();
              if (t === "checkbox" || t === "radio") return t;
              if (t === "submit" || t === "button" || t === "reset") return "button";
              return "textbox";
            }
            return "generic";
          }
          const out = [];
          let n = 0;
          for (const el of document.querySelectorAll(SEL)) {
            if (!visible(el)) continue;
            if (out.length >= ${SNAPSHOT_MAX_ELEMENTS}) return { url: location.href, title: document.title, elements: out, truncated: true };
            const ref = "e" + ++n;
            el.setAttribute("data-stellar-ref", ref);
            const item = { ref, role: roleOf(el), name: accessibleName(el), tag: el.tagName.toLowerCase() };
            if (el.disabled) item.disabled = true;
            if (typeof el.checked === "boolean" && el.checked) item.checked = true;
            if (el.value !== undefined && el.value !== "" && el.type !== "password") item.value = String(el.value).slice(0, 120);
            out.push(item);
          }
          return { url: location.href, title: document.title, elements: out, truncated: false };
        })()
      `);
      const parsed = raw as { url: string; title: string; elements: PageElement[]; truncated: boolean };
      return { ok: true, ...parsed };
    } catch (err) {
      return { ok: false, error: `failed to snapshot the page: ${String(err)}` };
    }
  }

  /** Um `ref` do `pageSnapshot` vira um seletor CSS comum — todo o resto do
   * caminho (click/type/scroll/query) segue exatamente igual. */
  function refSelector(ref: string): string {
    return `[data-stellar-ref="${ref.replace(/"/g, '\\"')}"]`;
  }


  /** Captura a página do card, e SÓ ela (achado ao vivo 2026-09-01: "eu
   * gostaria que o snapshot fosse cirúrgico e fizesse apenas do card e
   * nada mais"). O `snapshot` de sempre fotografa a JANELA DO APP recortada
   * onde o card está no board — então pega o fundo do canvas por baixo de
   * cantos arredondados, pega qualquer card sobreposto, sai na resolução
   * "tamanho na tela × zoom do board", e trunca o que estiver fora da área
   * visível. Aqui não existe board nenhum: a BrowserWindow offscreen deste
   * card é uma superfície própria, então a captura é exatamente o conteúdo
   * renderizado, na resolução real, independente de onde (ou se) o card
   * aparece na tela. */
  async function capturePage(id: string): Promise<{ ok: true; png: Buffer } | { ok: false; error: string }> {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: `no browser card with id "${id}"` };
    try {
      const image = await entry.win.webContents.capturePage();
      return { ok: true, png: image.toPNG() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  function destroy(id: string) {
    const entry = entries.get(id);
    if (entry) wcIdToCardId.delete(entry.win.webContents.id);
    if (!entry) return;
    // Idempotente mesmo se o unmount do BrowserInspector.tsx já tiver
    // desanexado antes (`detachInspector` acima) — a ordem entre "React
    // unmount → IPC detach" e "card fechando → IPC destroy" nunca
    // precisa de sincronização nova por causa disso.
    entry.cdp?.detach();
    entry.win.destroy();
    entries.delete(id);
  }

  function destroyAll() {
    for (const id of [...entries.keys()]) destroy(id);
  }

  return {
    create,
    navigate,
    back,
    forward,
    reload,
    openDevTools,
    attachInspector,
    detachInspector,
    sendCdp,
    setDeviceEmulation,
    resize,
    getContentSize,
    refreshScaleFactor,
    liveIds,
    forceScaleFactor,
    testSetMaxDensity,
    setVisible,
    setFocused,
    sendMouseEvent,
    sendWheelEvent,
    sendKeyEvent,
    insertText,
    pasteText,
    copyText,
    cutText,
    testMakeEditable,
    getPageText,
    clickAtPoint,
    clickSelector,
    typeText,
    scroll,
    query,
    evalJs,
    getConsole,
    getLocalSessionStorage,
    deleteLocalSessionItem,
    getNetwork,
    getCookies,
    fetchSource,
    getProcessStats,
    waitFor,
    pageSnapshot,
    refSelector,
    capturePage,
    destroy,
    destroyAll,
  };
}

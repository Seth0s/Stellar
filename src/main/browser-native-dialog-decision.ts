/**
 * Guarda de clique: o alvo pode abrir o seletor de arquivo NATIVO do SO?
 *
 * Achado ao vivo (2026-09-19) — um `browser_click` real num botão de
 * upload abriu o seletor de arquivos do SO, o card caiu e a sessão do
 * navegador foi embora antes de o resultado do clique ser lido. Pareceu
 * crash do Stellar, não era: o diálogo é nativo e o card vive numa
 * `BrowserWindow` OFFSCREEN e `show:false` (`browser-registry.ts`), sem
 * janela de verdade pra ser modal — e a sessão daquele card é uma
 * partição EFÊMERA (`stellar-browser-<id>`, sem prefixo `persist:`), então
 * o card morrendo leva cookies/storage junto.
 *
 * POR QUE ANTES DO CLIQUE, E NÃO DEPOIS (medido, não suposto):
 * o Electron 42 não expõe NENHUM gancho pro seletor de arquivo da própria
 * página. Varredura do `electron.d.ts` desta versão: existem eventos
 * `select-*` para hid/serial/usb/webauthn/bluetooth/client-certificate, e
 * NENHUM `select-file`/`FileChooser`/`file chooser` — o dialog nativo que
 * um `<input type=file>` abre nunca atravessa a API. Logo "detectar o
 * diálogo do SO depois do clique" não é implementável de forma honesta
 * aqui; o que dá pra fazer é não mandar o clique. `browser_click` recusa
 * ANTES de qualquer `sendInputEvent`.
 *
 * O que a página DECLARA (e por isso é detectável sem adivinhar):
 * - o próprio alvo ser `<input type="file">`;
 * - `<label>` associado (wrapping ou `for=`) cujo `control` é um input de
 *   arquivo — semântica de HTML, não heurística;
 * - um controle interativo (button/a/summary/`[role=button]`,
 *   input button/submit/image/reset) que tem um `input[type=file]` irmão
 *   direto no mesmo pai, ou dentro de si — o padrão real de "botão
 *   estilizado + input escondido" que motivou este achado.
 *
 * O que NÃO é detectável (declarado, não escondido): um controle que
 * dispara `input.click()` por JS, e dropzone cujo clique é tratado em
 * listener. Não há assinatura no DOM pra esses; inventar um "parece que
 * dispara" por nome/classe seria adivinhação, exatamente o que o resto
 * deste repo recusa fazer. A recusa abaixo é conservadora no que afirma
 * (nomeia o fato medido) e a mensagem ensina a saída.
 *
 * Puro — sem Electron, sem I/O. `COLLECT_CLICK_TARGET_FACTS_JS` é o
 * extrator que roda DENTRO da página (mesmo primitivo de
 * `withSelector`/`getPageText` em `browser-registry.ts`); a decisão
 * (`decideNativeDialogRisk`) recebe só os fatos e é testável fora do
 * navegador.
 */

export type ClickTargetFacts = {
  /** `tagName` minúsculo do elemento clicado. */
  tag: string;
  /** `type` resolvido do elemento (propriedade, não atributo), minúsculo; `null` quando não é input. */
  inputType: string | null;
  /** `role` explícito do elemento, minúsculo; `null` quando ausente. */
  role: string | null;
  /** O alvo É um `<input type="file">`. */
  isFileInput: boolean;
  /** `<label>` associado ao alvo cujo `control` (ou descendente) é um input de arquivo. */
  labelControlsFileInput: boolean;
  /** Existe `input[type=file]` entre os filhos DIRETOS do mesmo pai do alvo. */
  fileInputIsSibling: boolean;
  /** Existe `input[type=file]` DENTRO do alvo. */
  fileInputIsChild: boolean;
};

/**
 * Corpo de um `function (el) { ... }` avaliado no contexto da página. Fica
 * como fonte de texto (e não como código TS) porque é isso que o
 * `executeJavaScript` recebe — e é a MESMA string que a medição fora do
 * navegador usa, pra não existir uma versão medida e outra embarcada.
 * Sem depender de nada além do DOM que o alvo já tem.
 */
export const COLLECT_CLICK_TARGET_FACTS_JS = `function (el) {
  var tag = el && el.tagName ? String(el.tagName).toLowerCase() : "";
  var isInput = tag === "input";
  var inputType = isInput ? String(el.type || "").toLowerCase() : null;
  var roleAttr = el && el.getAttribute ? el.getAttribute("role") : null;
  var role = roleAttr ? String(roleAttr).toLowerCase() : null;
  var isFileInput = isInput && inputType === "file";
  var labelControlsFileInput = false;
  try {
    var label = el && el.closest ? el.closest("label") : null;
    if (label) {
      var control = label.control || null;
      labelControlsFileInput =
        !!(control && control.tagName && String(control.tagName).toLowerCase() === "input" &&
           String(control.type || "").toLowerCase() === "file") ||
        !!label.querySelector('input[type="file"]');
    }
  } catch (err) {
    labelControlsFileInput = false;
  }
  var fileInputIsChild = false;
  try {
    fileInputIsChild = !!(el && el.querySelector && el.querySelector('input[type="file"]'));
  } catch (err) {
    fileInputIsChild = false;
  }
  var fileInputIsSibling = false;
  var parent = el ? el.parentElement : null;
  if (parent) {
    for (var i = 0; i < parent.children.length; i++) {
      var child = parent.children[i];
      if (child === el || !child.tagName || String(child.tagName).toLowerCase() !== "input") continue;
      if (String(child.type || "").toLowerCase() !== "file") continue;
      fileInputIsSibling = true;
      break;
    }
  }
  return {
    tag: tag,
    inputType: inputType,
    role: role,
    isFileInput: isFileInput,
    labelControlsFileInput: labelControlsFileInput,
    fileInputIsSibling: fileInputIsSibling,
    fileInputIsChild: fileInputIsChild,
  };
}`;

const INTERACTIVE_TAGS = new Set(["button", "a", "summary", "label"]);
const INTERACTIVE_INPUT_TYPES = new Set(["button", "submit", "image", "reset"]);

/** O alvo é um controle que a pessoa/agente clica, e não um container qualquer? */
function isInteractiveClickTarget(facts: ClickTargetFacts): boolean {
  if (facts.role === "button") return true;
  if (INTERACTIVE_TAGS.has(facts.tag)) return true;
  if (facts.tag === "input" && facts.inputType !== null) return INTERACTIVE_INPUT_TYPES.has(facts.inputType);
  return false;
}

/** `reason` é o fato medido (a mensagem ao agente é montada por
 * `describeNativeDialogRefusal`, que acrescenta o mecanismo e a saída). */
export type NativeDialogRisk = { risky: false } | { risky: true; reason: string };

/** AGENT-FACING — DO NOT TRANSLATE. English, like every other refusal this
 * registry returns (`no browser card with id ...`), and it TEACHES: names
 * the measured mechanism and the way out. */
export function describeNativeDialogRefusal(reason: string, target: string): string {
  return (
    `browser_click refused before clicking ${target}: ${reason}. ` +
    `That click would open the OS's native file chooser. This card's BrowserWindow is offscreen ` +
    `(show:false, no real window to be modal to) and its session is an ephemeral per-card partition, ` +
    `so losing the card loses cookies/storage with it — measured live: the click took the card and its ` +
    `session down before the result could be read. Electron 42 exposes no hook for the page's own ` +
    `chooser (no select-file/FileChooser event in electron.d.ts), so the dialog cannot be observed or ` +
    `closed from here, and it cannot be answered by an agent anyway — a native file picker needs a ` +
    `human at the machine. Ask the human to pick the file, or use browser_eval to inspect how the page ` +
    `wires this control. Nothing was clicked.`
  );
}

/**
 * Decide se um clique sintético neste alvo deve ser RECUSADO por risco de
 * abrir o seletor nativo. Conservador no que afirma: cada recusa nomeia o
 * fato que a sustenta. Sem fato → permite (o gate não inventa suspeita).
 */
export function decideNativeDialogRisk(facts: ClickTargetFacts): NativeDialogRisk {
  const refuse = (reason: string): NativeDialogRisk => ({ risky: true, reason });
  if (facts.isFileInput) {
    return refuse(`the target is itself an <input type="file">`);
  }
  if (facts.labelControlsFileInput) {
    return refuse(`the target is a <label> whose associated control is an <input type="file">`);
  }
  if (isInteractiveClickTarget(facts)) {
    if (facts.fileInputIsSibling) {
      return refuse(`an <input type="file"> sits as a direct sibling of this ${facts.tag} — the styled "button + hidden file input" upload pattern`);
    }
    if (facts.fileInputIsChild) {
      return refuse(`this ${facts.tag} contains an <input type="file">`);
    }
  }
  return { risky: false };
}

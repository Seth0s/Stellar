import { RENDERER_GONE_PTY_HOLD } from "./renderer-gone-decision";

/**
 * O QUE NÃO PODE SER GUARDADO — a redação do rastro de um card fechado
 * (task 4e4ec327).
 *
 * POR QUE ISTO EXISTE, e não é zelo genérico: o rastro é TELA DE TRABALHO REAL —
 * o que passou por um card deste board, com caminhos, trechos de código e saída
 * de comando. Guardar isso por default muda o regime: de "pixels efêmeros no
 * monitor do dono" para "texto durável, lido por qualquer agente que consiga
 * abrir o banco do board". Esta casa já foi mordida uma vez por um card que fez
 * grep recursivo no diretório do usuário; persistir tela sem pensar repete o erro
 * com mais alcance (durável + backup + legível por agente).
 *
 * O QUE ESTA REDAÇÃO **NÃO** FAZ — declarado aqui, não descoberto depois:
 *   1. ela é por PADRÃO, não por semântica. Um segredo escrito em prosa livre
 *      ("a senha do banco é aquela que o João me passou") passa intacto;
 *   2. ela NÃO mascara PII em geral — e-mail, telefone e nome próprio ficam como
 *      estão, de propósito, porque o rastro existe para ser lido por um humano
 *      que vai retomar o trabalho, e mascarar CPF/e-mail destruiria justamente o
 *      valor de leitura;
 *   3. ela só alcança o que o registry GUARDOU (a cauda ANSI-stripped de
 *      `QUOTA_TAIL_MAX`), não a tela inteira — a tela vive no xterm do renderer,
 *      que o main não lê;
 *   4. segredo COLADO como imagem nunca esteve no texto.
 * Quem quiser exposição zero não usa a persistência — e é por isso que a porta
 * de exclusão real (`deleteCard`, que apaga o rastro junto) precisa existir.
 */

/**
 * A TELA DO CARD NÃO É GUARDADA POR DEFAULT — decisão do dono (2026-09-22), e a
 * razão está medida, não presumida: a varredura por segredo nos buffers vivos
 * deu negativo FRACO (zero padrões reais em ~29 KB, o que NÃO demonstra que a
 * tela é segura), a `mask-buffer.ts` cobre caminho de imagem colada e não
 * credencial, e persistir tela não redigida muda o regime de "pixels efêmeros no
 * monitor do dono" para "texto durável legível por qualquer agente". Isso é
 * decisão DELE, não herança de um default nosso.
 *
 * O que fica ligado por default é a IDENTIDADE (a linha arquivada de `cards`) e
 * os FATOS do registry — quando o card morreu, se foi morte por cota, se o kill
 * foi pedido. Metadado não é tela: não carrega texto nenhum do dono.
 */
export const CARD_TRACE_SCREEN_ENABLED_DEFAULT = false;

/** Teto quando a tela ESTIVER ligada: o número que o app JÁ declarou para
 * guardar bytes de PTY em main (`RENDERER_GONE_PTY_HOLD`), com a mesma política
 * de cauda. Um teto novo seria invenção minha; este é precedente medido, e a
 * justificativa dele é a mesma que vale aqui: "scrollback is the agents' work
 * record". (Na prática a cauda persistida é menor que isso: o registry só
 * mantém `QUOTA_TAIL_MAX` bytes — o teto é limite, não meta.) */
export const CARD_TRACE_TAIL_MAX = RENDERER_GONE_PTY_HOLD.maxBytesPerCard;

const REDACTION_RULES: readonly { name: string; re: RegExp; replacement: string }[] = [
  { name: "chave privada", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[CHAVE PRIVADA REDIGIDA]" },
  { name: "openai/anthropic", re: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "sk-[REDIGIDO]" },
  { name: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "AKIA[REDIGIDO]" },
  { name: "github", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: "gh_[REDIGIDO]" },
  { name: "github pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "github_pat_[REDIGIDO]" },
  { name: "slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "xox-[REDIGIDO]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, replacement: "[JWT REDIGIDO]" },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, replacement: "Bearer [REDIGIDO]" },
  {
    name: "campo sensível",
    re: /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|client[_-]?secret|password|passwd|senha|token)(\s*[:=]\s*)("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"']{6,})/gi,
    replacement: "$1$2[REDIGIDO]",
  },
  {
    name: "uri com credencial",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi,
    replacement: "$1[REDIGIDO]@",
  },
];

export type RedactedTrace = {
  text: string;
  /** `true` quando alguma regra MUDOU o texto. Vai para a linha como coluna:
   * quem lê o rastro sabe se houve redação, em vez de supor. */
  redacted: boolean;
  /** Nomes das regras que casaram — o "por quê" da redação, sem repetir o segredo. */
  rules: string[];
};

/**
 * A DECISÃO DE GUARDAR A TELA, separada da redação e do armazenamento: por
 * default ela NÃO é guardada (`CARD_TRACE_SCREEN_ENABLED_DEFAULT`), e quando não
 * é, o texto sai VAZIO de propósito — não é "a cauda sem redação", é ausência.
 * Quem liga assume o ônus; quem não liga não herda exposição nenhuma.
 */
export function decideTraceTailForStorage(input: {
  tail: string;
  /** Omitido = o default do módulo (`false`). Explícito só em teste ou numa
   * futura preferência do dono. */
  screenEnabled?: boolean;
}): { text: string; screenStored: boolean; redacted: boolean } {
  const enabled = input.screenEnabled ?? CARD_TRACE_SCREEN_ENABLED_DEFAULT;
  if (!enabled) return { text: "", screenStored: false, redacted: false };
  const out = redactTraceTail(input.tail);
  return { text: out.text, screenStored: true, redacted: out.redacted };
}

/** Redige e capa a cauda. Nunca lança: um regex problemático não pode derrubar o
 * fechamento de um card (o rastro é acessório; o fecho não). */
export function redactTraceTail(tail: string): RedactedTrace {
  let text = tail.length > CARD_TRACE_TAIL_MAX ? tail.slice(-CARD_TRACE_TAIL_MAX) : tail;
  const rules: string[] = [];
  for (const rule of REDACTION_RULES) {
    if (!rule.re.test(text)) continue;
    rules.push(rule.name);
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, rule.replacement);
  }
  return { text, redacted: rules.length > 0, rules };
}

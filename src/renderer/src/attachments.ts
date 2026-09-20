import type { MessageKey } from "../../shared/i18n";
import { getLocale } from "../../shared/i18n";
import type { IconName } from "./icons";

/**
 * ANEXO no composer global — a decisão PURA, separada do componente (mesmo
 * padrão de `radial-providers.ts`/`provider-groups.ts`: o que dá para testar
 * em `tests/unit` sem jsdom mora aqui).
 *
 * A pergunta que este módulo responde é "este anexo CHEGA no destino?", e ela
 * foi respondida com MEDIÇÃO, não com palpite (2026-09-20, relatório seq 453):
 * nenhum dos CLIs instalados (claude, codex, cursor-agent, opencode, cline,
 * commandcode) tem flag de anexo utilizável mid-session — o `-i/--image` do
 * codex é do prompt INICIAL (spawn) e o `--file` do claude é
 * `file_id:relative_path` de sessão cloud. O único transporte para um card de
 * terminal VIVO é texto (`bus.send` → `typeAndSubmit` no PTY), então anexo =
 * arquivo real em disco + CAMINHO CITADO NO TEXTO, e quem não tem como
 * receber isso é recusado na UI com motivo.
 */

export type AttachmentKind = "image" | "document";

/**
 * O id do shell. `bash` é o único provider de papel shell oferecido pela UI
 * (os dinâmicos são declarados sempre como `agent` — `main/index.ts`'s
 * `app:add-provider` grava `role: "agent"`, e os embutidos também), e o
 * renderer já usa este id literal em vários lugares (App.tsx's fallback de
 * providers, Rail.tsx's `showAgentFields`). Um shell não lê anexo: um caminho
 * no texto vira um comando executado.
 */
export const SHELL_PROVIDER_ID = "bash";

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** A MESMA whitelist de documento do main (`main/clipboard-image.ts`): aqui
 * ela serve para o filtro do picker/drop e para recusar o que nem chegaria a
 * ser gravado; o main revalida (é a fronteira de escrita em disco). */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "txt",
  "md",
  "markdown",
  "rtf",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yml",
  "yaml",
  "toml",
  "ini",
  "log",
  "xml",
  "html",
  "diff",
  "patch",
  "sql",
  "sh",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
]);

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "sh",
  "sql",
]);
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  "json",
  "jsonl",
  "yml",
  "yaml",
  "toml",
  "ini",
]);
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "txt", "rtf"]);

/** `accept` do `<input type=file>` — a MESMA whitelist de cima, para o
 * seletor do SO já não oferecer o que seria recusado. */
export const ATTACHMENT_ACCEPT = [
  ...[...IMAGE_MEDIA_TYPES],
  ...[...DOCUMENT_EXTENSIONS].map((ext) => `.${ext}`),
].join(",");

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Imagem ou documento — ou `null` quando não é nem uma coisa nem outra (o
 * caso que a UI recusa dizendo o nome do arquivo, em vez de engolir).
 */
export function classifyAttachment(file: { name: string; type: string }): AttachmentKind | null {
  if (IMAGE_MEDIA_TYPES.has(file.type)) return "image";
  if (DOCUMENT_EXTENSIONS.has(extensionOf(file.name))) return "document";
  return null;
}

/** Ícone do chip de documento — todos já existem em `icons.tsx`; nenhum
 * ícone novo foi criado para isto. */
export function attachmentIcon(fileName: string): IconName {
  const ext = extensionOf(fileName);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "fileMarkdown";
  if (CODE_EXTENSIONS.has(ext)) return "fileCode";
  if (CONFIG_EXTENSIONS.has(ext)) return "fileConfig";
  return "fileGeneric";
}

/**
 * Tamanho humano no idioma ativo (`Intl` em vez de sufixo traduzido: a
 * unidade é universal, o separador decimal não é — pt "1,4 MB", en "1.4 MB").
 */
export function formatAttachmentSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${new Intl.NumberFormat(getLocale()).format(rounded)} ${units[unit]}`;
}

export type AttachAdmission = { ok: true } | { ok: false; reason: MessageKey };

/**
 * A MATRIZ DE ADMISSÃO. Recusar com motivo é o requisito — não existe
 * "aceita e não entrega" (que é o defeito atual: o botão era gated por
 * `kind === "chat"`, o único destino que o `bus.send` recusa).
 */
export function admitAttachment(input: {
  kind: AttachmentKind;
  targetKind: string | null;
  targetProvider: string | null;
}): AttachAdmission {
  const { kind, targetKind, targetProvider } = input;
  if (targetKind === null) return { ok: false, reason: "composer.attach.noTarget" };
  if (targetKind === "terminal") {
    if (targetProvider === SHELL_PROVIDER_ID) return { ok: false, reason: "composer.attach.shell" };
    return { ok: true };
  }
  if (targetKind === "chat") {
    // O bar global NÃO é um composer de chat: o transporte de anexo do chat é
    // `window.chat.send` com bloco de imagem, e a API do provider só aceita
    // IMAGEM — documento não tem por onde ir, nem aqui nem lá.
    return {
      ok: false,
      reason: kind === "image" ? "composer.attach.chatImage" : "composer.attach.chatDocument",
    };
  }
  if (targetKind === "browser") return { ok: false, reason: "composer.attach.browser" };
  return { ok: false, reason: "composer.attach.notTerminal" };
}

/**
 * O corpo que vai pro PTY: o texto do usuário + um caminho por anexo.
 *
 * Aspas por causa de espaço no caminho — a MESMA convenção que o paste de
 * imagem do terminal já usa (`useTerminal.ts` escreve `"<path>" `). Só o
 * caminho, sem nenhuma promessa de sintaxe: o que o app garante é que o
 * caminho chega (ver o limite honesto em `main/clipboard-image.ts`).
 */
export function buildDeliveryText(text: string, attachmentPaths: readonly string[]): string {
  const body = text.trim();
  const paths = attachmentPaths.map((path) => `"${path}"`).join(" ");
  if (paths === "") return body;
  return body === "" ? paths : `${body} ${paths}`;
}

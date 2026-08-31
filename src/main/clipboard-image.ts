import { app, clipboard, nativeImage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Pedido ao vivo (2026-08-27): "não consigo mandar foto pelo terminal".
 * Confirmado — `useTerminal.ts` nunca interceptava paste, e o paste
 * padrão do xterm.js só lida com `text/plain`; uma imagem no clipboard
 * nunca virava nada no PTY. `claude`/`codex`/`cursor-agent` esperam um
 * CAMINHO de arquivo pra anexar imagem (convenção já estabelecida
 * dessas CLIs), não bytes binários crus no stdin — então a única coisa
 * que faz sentido escrever no PTY é o caminho de um arquivo real no
 * disco. Isso é o que este módulo produz: lê a imagem do clipboard do
 * SO (via `electron.clipboard`, no processo main — a mesma fonte que um
 * app nativo de verdade leria) e grava um PNG real num diretório
 * temporário próprio.
 *
 * **Limite honesto**: escrever o caminho no terminal é tudo que esta
 * app pode garantir e verificar (é texto, chega no PTY exatamente como
 * se o usuário tivesse digitado). Se a CLI rodando ali de fato trata
 * esse caminho como anexo de imagem depende do comportamento/versão
 * dela, não é algo que dá pra confirmar aqui sem uma sessão real e paga
 * — não afirmamos isso como verificado, só que o caminho chega certo.
 */

let tmpDir: string | null = null;

function ensureTmpDir(): string {
  if (tmpDir) return tmpDir;
  tmpDir = join(app.getPath("temp"), "stellar-pastes");
  mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

export type SaveClipboardImageResult = { ok: true; path: string } | { ok: false; error: string };

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Escreve bytes de imagem já resolvidos (buffer real, não base64 cru) no
 * mesmo diretório `stellar-pastes` que o resto deste módulo usa. Extraído
 * de `saveClipboardImage` pra ser reusado por `saveImageBytes` (item 66 —
 * anexo do chatbox, que nunca passa pelo clipboard do SO). */
function writeImageBuffer(buffer: Buffer, ext: string): SaveClipboardImageResult {
  try {
    const dir = ensureTmpDir();
    const name = `paste-${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`;
    const path = join(dir, name);
    writeFileSync(path, buffer);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Lê a imagem atualmente no clipboard do SO e grava como PNG. Nunca
 * lança — toda falha vira `ok:false`, mesmo padrão de erro do resto das
 * tools deste app (chat-tools.ts, fs-tools.ts). Arquivos temporários
 * não são limpos automaticamente (mesmo trade-off aceito que os outros
 * usos de diretório temporário deste app já fazem) — o SO/reinício
 * eventualmente limpa `app.getPath("temp")`. */
export function saveClipboardImage(): SaveClipboardImageResult {
  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return { ok: false, error: "clipboard não tem imagem no momento" };
    }
    return writeImageBuffer(image.toPNG(), "png");
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Item 66 — anexo de imagem colado/arrastado no composer do chatbox. Ao
 * contrário do terminal (que só vê o clipboard do SO), o composer é um
 * `<textarea>`/drop-zone comum — `paste`/`drop` já entregam um `File` de
 * verdade pro renderer (`clipboardData.items`/`dataTransfer.files`), sem
 * precisar da API `clipboard` do Electron. O renderer só manda os bytes
 * (já em base64, veio de `File.arrayBuffer()`) — este módulo decodifica e
 * grava, mesmo diretório/convenção de nome que `saveClipboardImage`. */
export function saveImageBytes(base64: string, mediaType: string): SaveClipboardImageResult {
  const ext = EXT_BY_MEDIA_TYPE[mediaType];
  if (!ext) return { ok: false, error: `tipo de imagem não suportado: ${mediaType}` };
  try {
    return writeImageBuffer(Buffer.from(base64, "base64"), ext);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type ReadAttachmentImageResult = { ok: true; base64: string } | { ok: false; error: string };

/** Item 66 — re-lê um anexo já salvo pra renderizar a miniatura na bolha
 * do chat (`ChatCard.tsx`, tanto a mensagem recém-enviada quanto uma
 * sessão restaurada de uma sessão anterior, onde o preview em memória do
 * composer não existe mais). `mediaType` não é devolvido — o bloco
 * persistido em `messages_json` já carrega o próprio, o renderer monta o
 * data URL sozinho. Validação de path é a mesma preocupação de
 * `confine()` (fs-tools.ts) mas escopada a este diretório fixo, não a um
 * root por-card: nunca lê nada fora de `stellar-pastes`, mesmo se um
 * `messages_json` malformado/adulterado apontar pra outro lugar. Checa
 * com o separador de path incluído — um prefixo de string sozinho
 * deixaria `stellar-pastes-outra-coisa/` passar. */
export function readAttachmentImage(path: string): ReadAttachmentImageResult {
  const dir = ensureTmpDir();
  if (!path.startsWith(dir + sep)) return { ok: false, error: "path fora do diretório de anexos" };
  try {
    return { ok: true, base64: readFileSync(path).toString("base64") };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Test-only (scripts/verify) — mesmo precedente já estabelecido de
// `chat:test-simulate-tool`/`updater:test-emit-available`: o guard
// `app.isPackaged` fica no handler IPC (main/index.ts), não aqui. Escreve
// um PNG 1×1 real no clipboard do SO de verdade — o caminho real de
// `saveClipboardImage` acima nunca é mockado, só o "algo real precisa
// estar no clipboard" que normalmente viria de um screenshot manual.
// Gerado programaticamente (chunks IHDR/IDAT/IEND com CRC32 real, via
// zlib.deflateSync) e validado com um round-trip real em
// nativeImage.createFromBuffer + clipboard.writeImage/readImage nesta
// máquina antes de fixar aqui — um base64 "1×1 PNG" digitado à mão
// falhou nesse round-trip (`img.isEmpty()` `true`, tamanho 0×0): parecia
// bem-formado (assinatura PNG correta), mas o corpo estava corrompido.
const TEST_PNG_1X1_RED_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

export function testWriteClipboardImage(): void {
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(TEST_PNG_1X1_RED_BASE64, "base64")));
}

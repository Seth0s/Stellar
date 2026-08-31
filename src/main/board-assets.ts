import { app } from "electron";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * DESIGN-BACKLOG.md item 57.9 — "Mídias no Canvas com Manipulação
 * Completa". Colar/arrastar uma imagem ou PDF no canvas vazio cria um
 * card de visualização (`media`, `card-types.ts`) que é conteúdo do
 * board de LONGA duração, não contexto de conversa efêmero — por isso
 * este módulo é deliberadamente diferente de `clipboard-image.ts`
 * (`stellar-pastes`, sob `app.getPath("temp")`, que o SO pode limpar a
 * qualquer momento): a pasta de assets vive sob `app.getPath("userData")`
 * (o mesmo diretório onde o SQLite do app já mora — nunca limpo pelo
 * SO), uma sub-pasta POR BOARD.
 *
 * Trade-off aceito conscientemente (documentado, não escondido): nada
 * aqui limpa os arquivos de um board deletado ou de um card de mídia
 * individual removido — mesmo espírito de "arquivo temporário não é
 * limpo automaticamente" que `clipboard-image.ts` já aceita pro seu
 * próprio diretório. Revisitar só se acumular como problema real.
 */

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function boardAssetsDir(boardId: string): string {
  const dir = join(app.getPath("userData"), "board-assets", boardId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type SaveBoardAssetResult = { ok: true; path: string } | { ok: false; error: string };

function writeUniqueFile(dir: string, ext: string, write: (path: string) => void): SaveBoardAssetResult {
  try {
    const cleanExt = ext.replace(/^\./, "") || "bin";
    const name = `media-${Date.now()}-${randomBytes(3).toString("hex")}.${cleanExt}`;
    const path = join(dir, name);
    write(path);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Paste de imagem no canvas vazio — só temos bytes em memória (base64),
 * sem um path real de SO pra copiar diretamente. */
export function saveBoardAssetBytes(boardId: string, base64: string, mediaType: string): SaveBoardAssetResult {
  const ext = EXT_BY_MEDIA_TYPE[mediaType];
  if (!ext) return { ok: false, error: `tipo de mídia não suportado: ${mediaType}` };
  const dir = boardAssetsDir(boardId);
  return writeUniqueFile(dir, ext, (path) => writeFileSync(path, Buffer.from(base64, "base64")));
}

/** Drop de um arquivo real do SO — o renderer já resolveu o path real via
 * `webUtils.getPathForFile` (Electron 32+), então uma cópia direta em
 * disco evita o round-trip de base64 que `saveBoardAssetBytes` precisa
 * (importa pra PDFs grandes, que `saveBytes` nunca lida de qualquer
 * forma — PDF só nasce de drop, ver App.tsx). */
export function copyBoardAssetFromPath(boardId: string, sourcePath: string): SaveBoardAssetResult {
  const dir = boardAssetsDir(boardId);
  const ext = extname(sourcePath);
  return writeUniqueFile(dir, ext, (path) => copyFileSync(sourcePath, path));
}

/** Resolve `stellar-asset://<boardId>/<filename>` pro path real em disco —
 * usado pelo protocolo customizado (main/index.ts). Mesma preocupação de
 * boundary que `readAttachmentImage` (clipboard-image.ts) já tem: o
 * filename nunca pode escapar da pasta do próprio board (ex.: um
 * `../../etc/passwd` embutido), mesmo vindo de uma URL renderer-supplied
 * — `basename()` descarta qualquer separador de diretório antes de
 * juntar, então não há como o resultado apontar pra fora de `dir` nem
 * escapar via `..` (`basename("../../etc/passwd")` vira só
 * `"passwd"`). */
export function resolveBoardAsset(boardId: string, filename: string): string | null {
  const dir = boardAssetsDir(boardId);
  const safeName = basename(filename);
  if (!safeName || safeName === "." || safeName === "..") return null;
  const resolved = join(dir, safeName);
  if (!resolved.startsWith(dir + sep) && resolved !== dir) return null;
  return resolved;
}

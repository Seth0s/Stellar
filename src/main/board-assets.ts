import { app } from "electron";
import { t } from "../shared/i18n";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";

/** Item 57.9 — pasta de assets PERSISTENTE do board, separada de
 * qualquer diretório temporário do SO (ver clipboard-image.ts, que usa
 * um diretório efêmero de propósito pra anexos de chat/terminal). Mídia
 * colada/arrastada no canvas vazio é conteúdo de board de longa duração
 * — não pode sumir numa limpeza de temp. Sem limpeza automática ao
 * deletar um board/card, mesmo trade-off já aceito por clipboard-
 * image.ts pro seu próprio diretório. */
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

/** Paste de imagem — só temos os bytes em memória (clipboard/FileReader),
 * nunca um path real de SO pra copiar direto. */
export function saveBoardAssetBytes(boardId: string, base64: string, mediaType: string): SaveBoardAssetResult {
  const ext = EXT_BY_MEDIA_TYPE[mediaType];
  if (!ext) return { ok: false, error: t("error.unsupportedMedia", { type: mediaType }) };
  const dir = boardAssetsDir(boardId);
  return writeUniqueFile(dir, ext, (path) => writeFileSync(path, Buffer.from(base64, "base64")));
}

/** Drop de um arquivo real do SO (path via `webUtils.getPathForFile`) —
 * copia direto, sem round-trip de base64 pela IPC (importa pra PDFs
 * grandes). */
export function copyBoardAssetFromPath(boardId: string, sourcePath: string): SaveBoardAssetResult {
  const dir = boardAssetsDir(boardId);
  const ext = extname(sourcePath);
  return writeUniqueFile(dir, ext, (path) => copyFileSync(sourcePath, path));
}

/** `stellar-asset://<boardId>/<filename>`'s handler — `basename()` do
 * filename recebido descarta qualquer `..`/separador embutido antes de
 * juntar ao dir real, e o `resolved.startsWith(dir + sep)` confirma que o
 * resultado ainda cai dentro da pasta daquele board (mesma defesa de
 * path-traversal que `fs-tools.ts` já usa pros roots de projeto). */
export function resolveBoardAsset(boardId: string, filename: string): string | null {
  const dir = boardAssetsDir(boardId);
  const safeName = basename(filename);
  if (!safeName || safeName === "." || safeName === "..") return null;
  const resolved = join(dir, safeName);
  if (!resolved.startsWith(dir + sep) && resolved !== dir) return null;
  return resolved;
}

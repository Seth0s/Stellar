/**
 * Agent `spawn_card kind:"media"` — validate a source file BEFORE consent.
 *
 * MediaCard only loads via `stellar-asset://` → `board-assets/<boardId>/`
 * (see MediaCard.tsx + board-assets.ts). The bus therefore COPIES the
 * file into that folder after this decision accepts; a bare reference to
 * a repo/temp path would 404 inside the card even if the source still
 * existed. Same permanence trade-off as human paste/drop.
 *
 * Size: measured 2026-09-14 — `copyBoardAssetFromPath` has NO byte
 * ceiling (human drop of large PDFs is intentional). Agent path matches.
 * Chat's ~10MB cap (`MAX_CHAT_ATTACHMENT_BASE64_CHARS`) is a different
 * surface (base64 over IPC into ephemeral pastes) and is NOT applied here.
 */

import { accessSync, constants, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

export type SpawnMediaType = "image" | "pdf";

/** Extensions MediaCard can render — image set matches board-assets
 * `EXT_BY_MEDIA_TYPE`; pdf is the other MediaCard arm. */
export const SPAWN_MEDIA_EXT_TO_TYPE: Record<string, SpawnMediaType> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".pdf": "pdf",
};

/** Extensions offered by the human OS file picker (`fs:pick-media-file`) —
 * must stay in lockstep with `SPAWN_MEDIA_EXT_TO_TYPE` / MediaCard. A filter
 * that lists a type the card cannot open is a lying UI. No dots. */
export const PICK_MEDIA_EXTENSIONS: string[] = Object.keys(SPAWN_MEDIA_EXT_TO_TYPE).map((ext) =>
  ext.replace(/^\./, ""),
);

export function describeAcceptedSpawnMedia(): string {
  return "accepted types: image (.png .jpg .jpeg .gif .webp) or pdf (.pdf)";
}

/** Result of the human media picker (rail) or its test seam — `null` means
 * the human cancelled; never invent a card on cancel. */
export type PickMediaFileResult =
  | { ok: true; path: string; mediaType: SpawnMediaType }
  | { ok: false; error: string };

/** Absolute path from the OS dialog (or the test seam) → same accept/refuse
 * rules as `spawn_card kind:"media"`. Caller still copies via
 * `copyBoardAssetFromPath` / `boardAssets.copyFromPath`. */
export function resolvePickedMediaFile(filePath: string): PickMediaFileResult {
  const decision = decideSpawnMediaPath({ path: filePath, cwd: null });
  if (decision.action === "refuse") return { ok: false, error: decision.error };
  return { ok: true, path: decision.resolvedPath, mediaType: decision.mediaType };
}

export type SpawnMediaPathDecision =
  | { action: "accept"; resolvedPath: string; mediaType: SpawnMediaType }
  | { action: "refuse"; error: string };

/**
 * Absolute path as given (after resolve); relative path resolved against
 * the requester card's cwd. Outside the project root is ALLOWED — same
 * class as human OS drop (`webUtils.getPathForFile`), gated by the
 * normal spawn_card consent dialog (media is NOT in the sticky
 * auto-approve exception: copying into board-assets is a disk write).
 */
export function decideSpawnMediaPath(input: {
  path: unknown;
  cwd: string | null | undefined;
}): SpawnMediaPathDecision {
  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    return {
      action: "refuse",
      error: `kind "media" requires path (absolute, or relative to the caller's card cwd) — ${describeAcceptedSpawnMedia()}`,
    };
  }
  const trimmed = input.path.trim();
  let resolvedPath: string;
  if (isAbsolute(trimmed)) {
    resolvedPath = resolve(trimmed);
  } else {
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!cwd) {
      return {
        action: "refuse",
        error:
          'relative path requires a caller card with a cwd (terminal/chat/files/changes); pass an absolute path instead',
      };
    }
    resolvedPath = resolve(cwd, trimmed);
  }

  const ext = extname(resolvedPath).toLowerCase();
  const mediaType = SPAWN_MEDIA_EXT_TO_TYPE[ext];
  if (!mediaType) {
    return {
      action: "refuse",
      error: `unsupported media type "${ext || "(no extension)"}" — ${describeAcceptedSpawnMedia()}`,
    };
  }

  try {
    accessSync(resolvedPath, constants.R_OK);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "ENOENT") {
      return { action: "refuse", error: `file not found: ${resolvedPath}` };
    }
    if (code === "EACCES") {
      return { action: "refuse", error: `file not readable: ${resolvedPath}` };
    }
    return { action: "refuse", error: `could not access file: ${String(err)}` };
  }

  try {
    const st = statSync(resolvedPath);
    if (!st.isFile()) {
      return { action: "refuse", error: `path is not a regular file: ${resolvedPath}` };
    }
  } catch (err) {
    return { action: "refuse", error: `could not stat file: ${String(err)}` };
  }

  return { action: "accept", resolvedPath, mediaType };
}

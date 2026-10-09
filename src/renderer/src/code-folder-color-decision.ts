/**
 * Prototype Codigo.dc.html — folder stroke/fill color cycles every depth
 * level (four colors). Depth 0 is the first visible folder under the root.
 */

export const CODE_FOLDER_COLORS = ["#e8b04b", "#6fa8ff", "#b48cff", "#4fc3a1"] as const;

export type CodeFolderColor = (typeof CODE_FOLDER_COLORS)[number];

/** Returns the prototype folder color for a 0-based nesting depth. */
export function folderColorAtDepth(depth: number): CodeFolderColor {
  const i = ((depth % CODE_FOLDER_COLORS.length) + CODE_FOLDER_COLORS.length) % CODE_FOLDER_COLORS.length;
  return CODE_FOLDER_COLORS[i]!;
}

/** Fill uses the stroke color at ~20% opacity (`33` hex alpha in the prototype). */
export function folderFillAtDepth(depth: number): string {
  return `${folderColorAtDepth(depth)}33`;
}

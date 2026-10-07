/** Largest rendered size (px) of the logo that gets the small variant. */
export const SMALL_MARK_MAX_PX = 24;

/** Which artwork the logo draws at a given rendered size. */
export function markVariant(size: number): "small" | "full" {
  return size <= SMALL_MARK_MAX_PX ? "small" : "full";
}

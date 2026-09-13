/**
 * Human Design Mode "Enviar" — body formatting + one-shot delivery
 * through the existing bus `send` (`typeAndSubmit` / `deliverCard`).
 * Never a second write+Enter variant.
 */

export type DesignPick = {
  tag: string;
  className: string;
  selector: string;
  width: number;
  height: number;
};

export function designContextText(pick: DesignPick, pageUrl: string): string {
  const opening = pick.className ? `<${pick.tag} class="${pick.className}">` : `<${pick.tag}>`;
  return `${opening} — ${pick.selector}\n${pageUrl} · ${pick.width}×${pick.height}px`;
}

/** Fire-and-forget: the human already clicked. Readiness, Enter confirm
 * and composer-clear live in `deliverCard`, not here. */
export function sendDesignPick(
  sendToCard: (targetId: string, text: string) => Promise<unknown>,
  targetId: string,
  pick: DesignPick,
  pageUrl: string,
): void {
  void sendToCard(targetId, designContextText(pick, pageUrl));
}

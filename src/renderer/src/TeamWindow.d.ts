/**
 * Typing for `window.team` (teams in the app).
 *
 * Its own file, following `ProfileWindow.d.ts` / `WorkHomeWindow.d.ts`. The
 * `Window` interface is merged through the global declaration.
 */
import type { TeamApi } from "../../preload/index";

declare global {
  interface Window {
    team: TeamApi;
  }
}

export {};

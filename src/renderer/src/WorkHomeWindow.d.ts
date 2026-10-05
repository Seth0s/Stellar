/**
 * Tipagem de `window.workhome` (BACKEND_V1.md §5 — sync da casa, A3b).
 *
 * Arquivo próprio (`WorkHome*`), no mesmo padrão de `ProfileWindow.d.ts`. A
 * interface `Window` é mesclada pela declaração global.
 */
import type { WorkHomeApi } from "../../preload/index";

declare global {
  interface Window {
    workhome: WorkHomeApi;
  }
}

export {};

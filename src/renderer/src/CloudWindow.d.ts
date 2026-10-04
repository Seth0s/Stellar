/**
 * Tipagem de `window.cloud` (A2 — conta Stellar).
 *
 * Fica num arquivo `Cloud*` próprio (o território cobre `Cloud*`, não
 * `env.d.ts`); a interface `Window` é mesclada pela declaração global.
 */
import type { CloudApi } from "../../preload/index";

declare global {
  interface Window {
    cloud: CloudApi;
  }
}

export {};

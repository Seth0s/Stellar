/**
 * Tipagem de `window.profiles` (BACKEND_V1.md §3/§7.1).
 *
 * `env.d.ts` lista as outras pontes do preload; esta fica num arquivo próprio
 * `Profile*` porque o território desta task cobre `Profile*` e não `env.d.ts`.
 * A interface `Window` é mesclada pela declaração global.
 */
import type { ProfilesApi } from "../../preload/index";

declare global {
  interface Window {
    profiles: ProfilesApi;
  }
}

export {};

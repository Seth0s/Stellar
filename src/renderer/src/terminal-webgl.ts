import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/**
 * Loads the WebGL renderer into an xterm that is ALREADY open, and never takes
 * the terminal down with it.
 *
 * Loaded before `open()`, the addon creates its context inside `open()` itself,
 * and an ANGLE/libGLESv2 failure there leaves the terminal half-initialised;
 * rebuilding it would lose the replayed history, the registry entry `read_card`
 * reads and the `onData`/`onKey` handlers. Loading it after `open()` is the
 * documented order and isolates the failure: if it throws, the terminal keeps
 * its DOM renderer, its buffer, its listeners and its registration.
 *
 * Returns whether WebGL is active. `createAddon` is injectable for tests.
 */
export function attachWebglRenderer(term: Terminal, createAddon: () => WebglAddon = () => new WebglAddon()): boolean {
  let webgl: WebglAddon | null = null;
  try {
    webgl = createAddon();
    // Losing the context at runtime (driver reset, suspend/resume, GPU switch) is
    // not the same as failing to create it: without a handler xterm keeps
    // drawing with a dead texture atlas (solid blocks instead of letters).
    // Disposing the addon drops it back to the DOM renderer.
    const loaded = webgl;
    loaded.onContextLoss(() => loaded.dispose());
    term.loadAddon(loaded);
    return true;
  } catch {
    // Some GPU/driver combinations report WebGL2 as available and only fail
    // here. Release whatever half-built state the addon holds; the terminal
    // stays on the DOM renderer.
    try {
      webgl?.dispose();
    } catch {
      // nothing left to release
    }
    return false;
  }
}

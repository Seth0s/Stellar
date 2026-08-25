import type { PtyApi, StoreApi, FsApi, GitApi, BrowserApi, AiApi, WinControlsApi } from "../../preload/index";

declare global {
  interface Window {
    pty: PtyApi;
    store: StoreApi;
    fs: FsApi;
    git: GitApi;
    browser: BrowserApi;
    ai: AiApi;
    winControls: WinControlsApi;
  }
}

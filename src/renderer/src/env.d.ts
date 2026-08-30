import type {
  PtyApi,
  StoreApi,
  FsApi,
  GitApi,
  BrowserApi,
  SpawnApi,
  AiApi,
  WinControlsApi,
  SnapshotApi,
  ReadCardApi,
  RemoteInputApi,
  RemoteApi,
  UpdaterApi,
  SecretsApi,
  ChatApi,
  ClipboardImageApi,
} from "../../preload/index";

declare global {
  interface Window {
    pty: PtyApi;
    clipboardImage: ClipboardImageApi;
    store: StoreApi;
    fs: FsApi;
    git: GitApi;
    browser: BrowserApi;
    spawn: SpawnApi;
    ai: AiApi;
    winControls: WinControlsApi;
    snapshot: SnapshotApi;
    readCard: ReadCardApi;
    remoteInput: RemoteInputApi;
    remote: RemoteApi;
    updater: UpdaterApi;
    secrets: SecretsApi;
    chat: ChatApi;
  }
}

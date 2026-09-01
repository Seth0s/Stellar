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
  StickyApi,
  RemoteInputApi,
  RemoteApi,
  UpdaterApi,
  SecretsApi,
  ChatApi,
  ClipboardImageApi,
  CanvasExportApi,
  BoardAssetsApi,
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
    sticky: StickyApi;
    remoteInput: RemoteInputApi;
    remote: RemoteApi;
    updater: UpdaterApi;
    secrets: SecretsApi;
    chat: ChatApi;
    canvasExport: CanvasExportApi;
    boardAssets: BoardAssetsApi;
  }
}

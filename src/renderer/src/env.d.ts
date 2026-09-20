import type {
  PtyApi,
  StoreApi,
  FsApi,
  GitApi,
  BrowserApi,
  SpawnApi,
  TasksApi,
  AiApi,
  WinControlsApi,
  SnapshotApi,
  ReadCardApi,
  StickyApi,
  RemoteInputApi,
  RemoteApi,
  UpdaterApi,
  AgentsApi,
  SecretsApi,
  ChatApi,
  BusApi,
  ClipboardImageApi,
  CanvasExportApi,
  BoardAssetsApi,
  SystemApi,
  I18nApi,
  VoiceApi,
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
    tasks: TasksApi;
    ai: AiApi;
    winControls: WinControlsApi;
    snapshot: SnapshotApi;
    readCard: ReadCardApi;
    sticky: StickyApi;
    remoteInput: RemoteInputApi;
    remote: RemoteApi;
    updater: UpdaterApi;
    agents: AgentsApi;
    secrets: SecretsApi;
    chat: ChatApi;
    bus: BusApi;
    canvasExport: CanvasExportApi;
    boardAssets: BoardAssetsApi;
    system: SystemApi;
    i18n: I18nApi;
    /** MOTOR DE VOZ local (whisper.cpp) — `main/voice-transcription.ts`. */
    voice: VoiceApi;
  }
}

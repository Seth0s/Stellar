// Single icon library for the whole app — no more hand-drawn SVG paths.
// `lucide-react` (outline set, tree-shaken per-icon import) replaces the
// previous inline path table; the `<Icon name="..." size={..}/>` call
// convention stays identical everywhere else in the codebase so this file
// is the only thing that had to change.
import {
  ArrowLeft,
  ArrowRight,
  BotMessageSquare,
  BoxSelect,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  File,
  FileCode2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Grid2x2,
  GripHorizontal,
  Group,
  Home as HomeGlyph,
  Image,
  KeyRound,
  LayoutGrid,
  Link2,
  Maximize,
  MessageCircle,
  Minimize,
  Minus,
  MonitorSmartphone,
  MousePointer2,
  MousePointerClick,
  OctagonX,
  Pen,
  QrCode,
  RotateCw,
  Scan,
  Search,
  Sparkles,
  Square,
  StickyNote,
  TerminalSquare,
  Trash2,
  Ungroup,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

export type IconName =
  | "pointer"
  | "select"
  | "pen"
  | "link"
  | "terminal"
  | "files"
  | "changes"
  | "sticky"
  | "browser"
  | "chat"
  | "apiKey"
  | "sparkle"
  | "reorganize"
  | "zoomIn"
  | "zoomOut"
  | "fit"
  | "close"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "back"
  | "forward"
  | "reload"
  | "interrupt"
  | "winMinimize"
  | "winMaximize"
  | "winRestore"
  | "fullscreenEnter"
  | "fullscreenExit"
  | "resizeGrip"
  | "group"
  | "ungroup"
  | "check"
  | "bgStyle"
  | "remoteWindow"
  | "controlOn"
  | "controlOff"
  | "remoteControl"
  | "findCard"
  | "home"
  | "providerBash"
  | "providerClaude"
  | "providerCodex"
  | "providerCursor"
  | "folderOpen"
  | "fileImage"
  | "fileMarkdown"
  | "fileCode"
  | "fileConfig"
  | "fileGeneric"
  | "newFile"
  | "newFolder"
  | "trash";

const COMPONENTS: Record<IconName, LucideIcon> = {
  pointer: MousePointer2,
  select: BoxSelect,
  pen: Pen,
  link: Link2,
  terminal: TerminalSquare,
  files: Folder,
  changes: GitBranch,
  sticky: StickyNote,
  browser: Globe,
  chat: MessageCircle,
  apiKey: KeyRound,
  sparkle: Sparkles,
  reorganize: LayoutGrid,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fit: Scan,
  close: X,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  back: ArrowLeft,
  forward: ArrowRight,
  reload: RotateCw,
  // 2026-08-27 — plain Octagon at 12px read as a blank ring, mistaken
  // live for a "copy" icon. OctagonX keeps the stop-sign shape but adds
  // an unambiguous mark inside it.
  interrupt: OctagonX,
  winMinimize: Minus,
  winMaximize: Square,
  winRestore: Copy,
  fullscreenEnter: Maximize,
  fullscreenExit: Minimize,
  resizeGrip: GripHorizontal,
  group: Group,
  ungroup: Ungroup,
  check: Check,
  bgStyle: Grid2x2,
  remoteWindow: MonitorSmartphone,
  controlOn: MousePointerClick,
  controlOff: MousePointer2,
  remoteControl: QrCode,
  findCard: Search,
  home: HomeGlyph,
  providerBash: TerminalSquare,
  providerClaude: BotMessageSquare,
  providerCodex: Code2,
  providerCursor: MousePointerClick,
  folderOpen: FolderOpen,
  fileImage: Image,
  fileMarkdown: FileText,
  fileCode: FileCode2,
  fileConfig: Braces,
  fileGeneric: File,
  newFile: FilePlus,
  newFolder: FolderPlus,
  trash: Trash2,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Component = COMPONENTS[name];
  return <Component size={size} strokeWidth={1.75} />;
}

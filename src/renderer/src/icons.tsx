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
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  Crop,
  Eye,
  EyeOff,
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
  Monitor,
  MonitorSmartphone,
  MoreVertical,
  MousePointer2,
  MousePointerClick,
  OctagonX,
  PanelLeft,
  Pen,
  Pin,
  Plus,
  QrCode,
  Rocket,
  RotateCw,
  Scan,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Tablet,
  TerminalSquare,
  Trash2,
  Ungroup,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

export type IconName =
  | "pointer"
  | "select"
  | "exportCrop"
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
  | "chevronUp"
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
  | "copy"
  | "bgStyle"
  | "remoteWindow"
  | "controlOn"
  | "controlOff"
  | "remoteControl"
  | "findCard"
  | "chatSessionsPanel"
  | "plus"
  | "home"
  | "providerBash"
  | "providerClaude"
  | "providerCodex"
  | "providerCursor"
  | "providerAntigravity"
  | "folderOpen"
  | "fileImage"
  | "fileMarkdown"
  | "fileCode"
  | "fileConfig"
  | "fileGeneric"
  | "newFile"
  | "newFolder"
  | "trash"
  | "settings"
  | "eye"
  | "eyeOff"
  | "clock"
  | "rotate"
  | "moreVertical"
  | "devTools"
  | "viewportFluid"
  | "viewportMobile"
  | "viewportTablet"
  | "favorite"
  | "pin"
  | "checkCircle"
  | "wrench"
  | "bug";

const COMPONENTS: Record<IconName, LucideIcon> = {
  pointer: MousePointer2,
  select: BoxSelect,
  exportCrop: Crop,
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
  chevronUp: ChevronUp,
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
  copy: Copy,
  bgStyle: Grid2x2,
  remoteWindow: MonitorSmartphone,
  controlOn: MousePointerClick,
  controlOff: MousePointer2,
  remoteControl: QrCode,
  findCard: Search,
  chatSessionsPanel: PanelLeft,
  plus: Plus,
  home: HomeGlyph,
  providerBash: TerminalSquare,
  providerClaude: BotMessageSquare,
  providerCodex: Code2,
  providerCursor: MousePointerClick,
  providerAntigravity: Rocket,
  folderOpen: FolderOpen,
  fileImage: Image,
  fileMarkdown: FileText,
  fileCode: FileCode2,
  fileConfig: Braces,
  fileGeneric: File,
  newFile: FilePlus,
  newFolder: FolderPlus,
  trash: Trash2,
  settings: Settings,
  eye: Eye,
  eyeOff: EyeOff,
  clock: Clock,
  rotate: RotateCw,
  moreVertical: MoreVertical,
  devTools: Bug,
  favorite: Star,
  viewportFluid: Monitor,
  viewportMobile: Smartphone,
  viewportTablet: Tablet,
  // StickyCard.tsx's STICKY_KIND — categoria por cor (nota/feito/em
  // andamento/bug), não só um swatch de cor.
  pin: Pin,
  checkCircle: CheckCircle2,
  wrench: Wrench,
  bug: Bug,
};

export function Icon({ name, size = 18, color }: { name: IconName; size?: number; color?: string }) {
  const Component = COMPONENTS[name];
  return <Component size={size} strokeWidth={1.75} color={color} />;
}

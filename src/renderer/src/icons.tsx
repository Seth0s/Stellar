// Single icon library for the whole app — no more hand-drawn SVG paths.
// `lucide-react` (outline set, tree-shaken per-icon import) replaces the
// previous inline path table; the `<Icon name="..." size={..}/>` call
// convention stays identical everywhere else in the codebase so this file
// is the only thing that had to change.
import {
  ArrowLeft,
  ArrowRight,
  BoxSelect,
  Check,
  ChevronDown,
  Copy,
  Folder,
  GitBranch,
  Globe,
  Grid2x2,
  GripHorizontal,
  Group,
  LayoutGrid,
  Link2,
  Maximize,
  Minimize,
  Minus,
  MonitorSmartphone,
  MousePointer2,
  MousePointerClick,
  Octagon,
  Pen,
  RotateCw,
  Scan,
  Sparkles,
  Square,
  StickyNote,
  TerminalSquare,
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
  | "sparkle"
  | "reorganize"
  | "zoomIn"
  | "zoomOut"
  | "fit"
  | "close"
  | "chevronDown"
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
  | "controlOff";

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
  sparkle: Sparkles,
  reorganize: LayoutGrid,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fit: Scan,
  close: X,
  chevronDown: ChevronDown,
  back: ArrowLeft,
  forward: ArrowRight,
  reload: RotateCw,
  interrupt: Octagon,
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
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Component = COMPONENTS[name];
  return <Component size={size} strokeWidth={1.75} />;
}

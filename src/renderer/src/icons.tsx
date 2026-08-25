// Small hand-rolled inline SVG icon set — same convention already used by
// the CentralByte sibling project and by the reference artifact this phase
// ports (viewBox 0 0 20 20, stroke 1.75, fill none). A ~20-shape fixed set
// doesn't justify pulling in an icon package.

export type IconName =
  | "pointer"
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
  | "winRestore";

const PATHS: Record<IconName, string> = {
  pointer: '<path d="M4 3l12 6.5-5 1.2 2.6 5.6-1.8.8-2.6-5.6-3.4 3V3z"/>',
  pen: '<path d="M13.5 3.5l3 3L7 16l-4 1 1-4 9.5-9.5z"/>',
  link:
    '<path d="M8 12l4-4"/><path d="M6.5 13.5a3 3 0 010-4.2l2-2a3 3 0 014.2 0"/><path d="M13.5 6.5a3 3 0 010 4.2l-2 2a3 3 0 01-4.2 0"/>',
  terminal: '<rect x="2.5" y="4" width="15" height="12" rx="1.5"/><path d="M6 8l2.5 2L6 12"/><path d="M10 12h4"/>',
  files: '<path d="M3 5.5A1.5 1.5 0 014.5 4H8l1.5 2H15.5A1.5 1.5 0 0117 7.5v7A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-9z"/>',
  changes: '<path d="M4 6h5M4 10h8M4 14h5"/><path d="M15 5v4M13 7h4"/>',
  sticky: '<path d="M4 3.5h12v9l-3.5 3.5H4v-12.5z"/><path d="M12.5 16v-3.5H16"/>',
  browser:
    '<circle cx="10" cy="10" r="7"/><path d="M3 10h14"/><path d="M10 3a11 11 0 010 14"/><path d="M10 3a11 11 0 000 14"/>',
  sparkle:
    '<path d="M10 3l1.3 4.2L15.5 8.5l-4.2 1.3L10 14l-1.3-4.2L4.5 8.5l4.2-1.3L10 3z"/><path d="M16 13l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6L16 13z"/>',
  reorganize:
    '<rect x="3" y="3" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1"/>',
  zoomIn: '<circle cx="9" cy="9" r="6"/><path d="M9 6.5v5M6.5 9h5"/><path d="M13.7 13.7L17.5 17.5"/>',
  zoomOut: '<circle cx="9" cy="9" r="6"/><path d="M6.5 9h5"/><path d="M13.7 13.7L17.5 17.5"/>',
  fit: '<path d="M3 8V3h5"/><path d="M17 8V3h-5"/><path d="M3 12v5h5"/><path d="M17 12v5h-5"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  chevronDown: '<path d="M5 8l5 5 5-5"/>',
  back: '<path d="M12 4l-6 6 6 6"/>',
  forward: '<path d="M8 4l6 6-6 6"/>',
  reload: '<path d="M4 10a6 6 0 0110-4.2M16 10a6 6 0 01-10 4.2"/><path d="M14 3v3h-3M6 17v-3h3"/>',
  interrupt: '<circle cx="10" cy="10" r="7"/><path d="M10 3v7"/>',
  winMinimize: '<path d="M4 10h12"/>',
  winMaximize: '<rect x="4" y="4" width="12" height="12" rx="1"/>',
  winRestore: '<rect x="6" y="6" width="10" height="10" rx="1"/><path d="M4 14V5a1 1 0 011-1h9"/>',
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

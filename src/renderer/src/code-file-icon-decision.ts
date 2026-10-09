/**
 * Prototype Codigo.dc.html — per-language badge for the file tree and tabs.
 * Identity hex is allowed under SYSTEM_DESIGN §5.4 (language identity).
 */

export type CodeFileBadge = {
  text: string;
  background: string;
  color: string;
};

function extOf(name: string): string {
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const i = base.lastIndexOf(".");
  return i === -1 ? "" : base.slice(i).toLowerCase();
}

function isTestFile(name: string): boolean {
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return /\.(test|spec)\.[^.]+$/i.test(base) || /\.test\./i.test(base);
}

/** Pure mapping from a file name (or path) to the prototype language badge. */
export function decideCodeFileBadge(name: string): CodeFileBadge {
  if (isTestFile(name)) return { text: "✓", background: "#14301f", color: "#7ee2a0" };
  const e = extOf(name);
  switch (e) {
    case ".ts":
      return { text: "TS", background: "#3178c6", color: "#fff" };
    case ".tsx":
      return { text: "⚛", background: "#0b2a3a", color: "#61dafb" };
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return { text: "JS", background: "#f1e05a", color: "#1a1a1a" };
    case ".css":
    case ".scss":
      return { text: "#", background: "#5b3a8a", color: "#e0c7ff" };
    case ".json":
    case ".jsonc":
      return { text: "{}", background: "#4a3d10", color: "#f0c94b" };
    case ".md":
    case ".markdown":
      return { text: "M↓", background: "#2a2f3d", color: "#c9cede" };
    case ".go":
      return { text: "Go", background: "#00add8", color: "#fff" };
    case ".py":
      return { text: "Py", background: "#3572a5", color: "#fff" };
    case ".rs":
      return { text: "Rs", background: "#dea584", color: "#1a1a1a" };
    case ".sh":
    case ".bash":
    case ".zsh":
      return { text: "$", background: "#14301f", color: "#7ee2a0" };
    case ".sql":
      return { text: "SQL", background: "#e38c00", color: "#1a1a1a" };
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg":
    case ".webp":
    case ".bmp":
      return { text: "▣", background: "#2b1d35", color: "#d29bf0" };
    default:
      return { text: "·", background: "#2a2f3d", color: "#c9cede" };
  }
}

/** Maps porcelain-like git status letters to the prototype tree markers. */
export function decideGitLetter(status: string | null | undefined): "M" | "A" | "D" | null {
  if (!status) return null;
  const s = status.trim().toUpperCase();
  if (s.includes("D")) return "D";
  if (s.includes("A") || s === "??" || s.includes("?")) return "A";
  if (s.includes("M") || s.includes("R") || s.includes("C") || s.includes("U")) return "M";
  return null;
}

export function gitLetterColor(letter: "M" | "A" | "D"): string {
  if (letter === "A") return "#8fdcc0";
  if (letter === "D") return "#e0846f";
  return "#f0b25c";
}

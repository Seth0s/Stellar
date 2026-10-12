/**
 * Language name for the status bar, spelled out ("TypeScript", not "TS").
 * `null` for an extension with no known name, so the caller can fall back.
 */

const NAMES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript React",
  js: "JavaScript",
  jsx: "JavaScript React",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  md: "Markdown",
  markdown: "Markdown",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  py: "Python",
  rs: "Rust",
  go: "Go",
  rb: "Ruby",
  java: "Java",
  php: "PHP",
  sql: "SQL",
  c: "C",
  h: "C",
  cpp: "C++",
  hpp: "C++",
  sh: "Shell",
  bash: "Shell",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  ini: "INI",
  env: "Env",
  txt: "Plain text",
};

export function decideLanguageName(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return NAMES[name.slice(dot + 1).toLowerCase()] ?? null;
}

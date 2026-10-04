/**
 * CASA DE TRABALHO — a TABELA de allowlist, uma por ferramenta (A3a,
 * BACKEND_V1.md §5.1).
 *
 * REGRA DE OURO: só entra o que esta tabela DECLARA. Não existe "varrer a
 * pasta e excluir o que parece segredo" — uma allowlist que se descobre por
 * tentativa deixa passar o que ninguém lembrou de excluir. Aqui o universo é
 * fechado; o que não tem regra não é lido. Os `deny` são a SEGUNDA barreira,
 * dentro de uma árvore permitida: mesmo que um arquivo de credencial apareça
 * sob `skills/`, ele não sai.
 *
 * Os caminhos das regras são RELATIVOS à raiz da ferramenta, que é PARÂMETRO
 * (o teste passa diretórios temporários; A3c aponta para pastas por perfil).
 * Nada aqui conhece `~/.claude` de verdade.
 *
 * As chaves "de comportamento" de cada settings são declaradas na própria
 * regra do filtro — mudar a lista é mudar a tabela, e o teste prova que chave
 * fora dela não sai (§5.1).
 */

import type { WorkHomeTool } from "./work-home-manifest";

export type SettingsFilter =
  | { kind: "json"; allowKeys: readonly string[] }
  | { kind: "toml"; allowTopLevel: readonly string[] }
  | { kind: "none" };

export type WorkHomeRule =
  /** Um único arquivo na raiz da ferramenta. */
  | { id: string; kind: "file"; relPath: string; filter?: SettingsFilter; includes?: "claude-at" }
  /** Uma árvore inteira (recursiva). */
  | { id: string; kind: "tree"; relPath: string }
  /** Memória por projeto do Claude: `<relDir>/<encoded-cwd>/<subtree>/…`. */
  | { id: string; kind: "claude-project-memory"; relDir: string; subtree: string }
  /** O bundle portátil de provider que já existe (`provider-config-sync.ts`). */
  | { id: string; kind: "stellar-bundle" };

export type WorkHomeToolSpec = {
  tool: WorkHomeTool;
  /** Universo fechado: só estas raízes são lidas. */
  rules: readonly WorkHomeRule[];
  /** Segunda barreira: nunca lê estes caminhos (posix, relativo à raiz), nem
   *  dentro de uma árvore permitida. */
  deny: readonly RegExp[];
};

/** Chaves de comportamento do `settings.json` do Claude (§5.1). O `env` fica
 *  FORA de propósito — pode carregar segredo. */
export const CLAUDE_SETTINGS_BEHAVIOR_KEYS = [
  "model",
  "hooks",
  "permissions",
  "enabledPlugins",
  "marketplaces",
  "statusLine",
] as const;

/** Chaves de comportamento do `config.toml` do Codex (§5.1): modelo, perfis e
 *  projetos. `auth`, sessões e histórico não têm regra e não entram. */
export const CODEX_CONFIG_BEHAVIOR_KEYS = ["model", "model_provider", "profiles", "projects"] as const;

/** Preferências de comportamento do CLI do Cursor. `mcp.json` fica fora
 *  (tem a entrada do Stellar e pode ter token de terceiros, §5.1). */
export const CURSOR_CLI_CONFIG_BEHAVIOR_KEYS = ["model", "theme", "permissions", "rules"] as const;

/** Settings de comportamento do Gemini/Antigravity. `oauth_creds`,
 *  `trustedFolders` e `state` não têm regra. */
export const GEMINI_SETTINGS_BEHAVIOR_KEYS = ["model", "theme"] as const;

export const WORK_HOME_TOOL_SPECS: Record<WorkHomeTool, WorkHomeToolSpec> = {
  claude: {
    tool: "claude",
    rules: [
      {
        id: "claude-md",
        kind: "file",
        relPath: "CLAUDE.md",
        filter: { kind: "none" },
        includes: "claude-at",
      },
      { id: "claude-skills", kind: "tree", relPath: "skills" },
      { id: "claude-agents", kind: "tree", relPath: "agents" },
      { id: "claude-commands", kind: "tree", relPath: "commands" },
      { id: "claude-project-memory", kind: "claude-project-memory", relDir: "projects", subtree: "memory" },
      {
        id: "claude-settings",
        kind: "file",
        relPath: "settings.json",
        filter: { kind: "json", allowKeys: CLAUDE_SETTINGS_BEHAVIOR_KEYS },
      },
    ],
    deny: [
      /(^|\/)\.credentials\.json$/,
      /(^|\/)history\.jsonl$/,
      /\.jsonl$/,
      /(^|\/)cache\//,
      /(^|\/)plugins\//,
      /(^|\/)shell-snapshots\//,
      /(^|\/)statsig\//,
      /(^|\/)todos\//,
      /(^|\/)\.claude\.json$/,
    ],
  },
  codex: {
    tool: "codex",
    rules: [
      { id: "codex-agents", kind: "file", relPath: "AGENTS.md", filter: { kind: "none" } },
      { id: "codex-skills", kind: "tree", relPath: "skills" },
      {
        id: "codex-config",
        kind: "file",
        relPath: "config.toml",
        filter: { kind: "toml", allowTopLevel: CODEX_CONFIG_BEHAVIOR_KEYS },
      },
    ],
    deny: [/(^|\/)auth\.json$/, /(^|\/)history\.jsonl$/, /(^|\/)sessions\//, /(^|\/)log\//, /\.jsonl$/],
  },
  cursor: {
    tool: "cursor",
    rules: [
      { id: "cursor-agents", kind: "tree", relPath: "agents" },
      { id: "cursor-rules", kind: "tree", relPath: "rules" },
      {
        id: "cursor-cli-config",
        kind: "file",
        relPath: "cli-config.json",
        filter: { kind: "json", allowKeys: CURSOR_CLI_CONFIG_BEHAVIOR_KEYS },
      },
    ],
    deny: [/(^|\/)chats\//, /(^|\/)projects\//, /(^|\/)mcp\.json$/, /(^|\/)skills-cursor\//, /(^|\/)extensions\//],
  },
  gemini: {
    tool: "gemini",
    rules: [
      { id: "gemini-md", kind: "file", relPath: "GEMINI.md", filter: { kind: "none" } },
      { id: "gemini-skills", kind: "tree", relPath: "skills" },
      {
        id: "gemini-settings",
        kind: "file",
        relPath: "settings.json",
        filter: { kind: "json", allowKeys: GEMINI_SETTINGS_BEHAVIOR_KEYS },
      },
    ],
    deny: [
      /(^|\/)brain\//,
      /(^|\/)conversations\//,
      /(^|\/)history\.jsonl$/,
      /oauth_creds/,
      /(^|\/)trustedFolders\.json$/,
      /(^|\/)state\.json$/,
      /(^|\/)antigravity-cli\/builtin\//,
      /\.jsonl$/,
    ],
  },
  stellar: {
    tool: "stellar",
    rules: [{ id: "stellar-bundle", kind: "stellar-bundle" }],
    deny: [],
  },
};

/** Caminho relativo (posix, sem barra inicial) é negado por alguma regra? */
export function isDenied(spec: WorkHomeToolSpec, relPath: string): boolean {
  const posix = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return spec.deny.some((re) => re.test(posix));
}

/**
 * Filtra um `settings.json`: mantém SOMENTE as chaves de comportamento
 * declaradas. `null` = não sai (não é JSON-objeto, ou nenhuma chave
 * declarada está presente). Nunca devolve o conteúdo cru: um parse que falha
 * não vira "inclui tudo".
 */
export function filterJsonSettings(content: string, allowKeys: readonly string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  let kept = 0;
  for (const key of allowKeys) {
    if (Object.prototype.hasOwnProperty.call(rec, key)) {
      picked[key] = rec[key];
      kept++;
    }
  }
  if (kept === 0) return null;
  return `${JSON.stringify(picked, null, 2)}\n`;
}

/** Uma linha de header de tabela TOML: `[x]`, `[x.y]` ou `[[x]]`. */
const TOML_HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
/** Uma atribuição top-level: `chave = valor`. */
const TOML_KEY_RE = /^\s*([A-Za-z0-9_-]+)\s*=/;

/**
 * Filtra um TOML mantendo só as TABELAS e CHAVES top-level declaradas. É um
 * filtro conservador (não é um parser TOML completo): reconhece headers e
 * `chave =` top-level e descarta o resto. Um valor que abra chaves no meio
 * continua dentro do bloco a que pertence; o que importa aqui é que chave
 * FORA da lista não sai (auth/sessão/histórico).
 *
 * `null` = nada declarado foi encontrado (arquivo não entra).
 */
export function filterTomlSettings(content: string, allowTopLevel: readonly string[]): string | null {
  const allowed = new Set(allowTopLevel);
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let keepSection = true; // top-level: só chaves declaradas passam
  let inSection = false;
  let keptSomething = false;

  for (const line of lines) {
    const header = line.match(TOML_HEADER_RE);
    if (header) {
      const top = header[1].trim().split(".")[0];
      inSection = true;
      keepSection = allowed.has(top);
      if (keepSection) {
        out.push(line);
        keptSomething = true;
      }
      continue;
    }
    if (!inSection) {
      const key = line.match(TOML_KEY_RE);
      if (key) {
        if (allowed.has(key[1])) {
          out.push(line);
          keptSomething = true;
        }
        continue;
      }
      // Linha vazia/comentário top-level: só faz sentido manter se já houve
      // conteúdo; é cosmético, então só mantém quando algo declarado já saiu.
      if (keptSomething && line.trim() === "") out.push(line);
      continue;
    }
    if (keepSection) out.push(line);
  }

  if (!keptSomething) return null;
  const trimmed = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
  return `${trimmed}\n`;
}

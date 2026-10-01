/**
 * PROTÓTIPOS SERVIDOS POR HTTP LOCAL — a parte PURA (task 326b78e4).
 *
 * O DEFEITO, medido: um agente que gerava um HTML de protótipo não tinha como
 * abri-lo num BrowserCard. `file://` é RECUSADO por design
 * (`browser-registry.ts::normalizeUrl` — `file:` + `get_page_text` seria
 * leitura arbitrária do FS, ver o comentário lá), e `prototypes/` não era
 * servido por nada. A saída era subir `python3 -m http.server` à mão.
 *
 * Este módulo decide o que é seguro servir e monta as URLs; o servidor em si
 * (`prototype-server.ts`) só faz I/O encima disto. Separado porque é aqui que
 * mora a regra (confinamento de path, Content-Type, formato do manifesto) e
 * regra pura tem teste direto.
 *
 * `charset=utf-8` NÃO é preferência: é medido (task 29d8d5a1,
 * `smoke-browser-local-html-interaction.mjs`) — sem ele o Chromium decodifica
 * como latin-1 e "Ação, coração" vira mojibake. Todo tipo textual acima sai com
 * o charset; os binários (png/woff…) não levam charset nenhum.
 */

export type PrototypePreset = {
  /** Atalho declarado, citado pelo agente (ex.: "settings-modal"). */
  name: string;
  /** Caminho do arquivo RELATIVO à raiz de protótipos (ex.: "settings-modal.html"). */
  file: string;
  description?: string;
};

export type PrototypeManifest = { presets: PrototypePreset[] };

/** Um preset já resolvido para uma URL servível. */
export type PrototypePresetInfo = PrototypePreset & {
  url: string;
  /** `false` = declarado mas o arquivo não está na raiz (o agente vê a verdade). */
  exists: boolean;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Sanitiza um caminho RELATIVO para dentro da raiz. Devolve o caminho
 * normalizado (posix, sem barra inicial) ou `null` se ele escapa.
 *
 * RECUSA, não conserta: `..` em qualquer posição, caminho absoluto, byte nulo.
 * O chamador trata `null` como 404. É a fronteira de confinamento — o path
 * final ainda é conferido contra a raiz no servidor (defesa em profundidade).
 */
export function sanitizeRelPath(raw: string): string | null {
  const trimmed = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (trimmed === "" || trimmed.includes("\0")) return null;
  const parts: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * A URL de um arquivo da raiz DE UM BOARD. O `boardId` vai no caminho porque o
 * servidor é UM só para o app e a raiz é POR BOARD (ver o desenho no relatório
 * da task): `http://127.0.0.1:<porta>/p/<boardId>/<rel>`.
 */
export function presetUrl(baseUrl: string, boardId: string, rel: string): string {
  const safe = sanitizeRelPath(rel);
  if (safe === null) throw new Error(`unsafe prototype path: ${JSON.stringify(rel)}`);
  const encoded = safe.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}/p/${encodeURIComponent(boardId)}/${encoded}`;
}

/** O prefixo de caminho que o servidor reconhece. */
export function prototypePathPrefix(boardId: string): string {
  return `/p/${encodeURIComponent(boardId)}/`;
}

/**
 * Valida o manifesto DECLARADO (`<raiz>/prototypes.json`). Sem heurística: o
 * que não estiver aqui não é preset. A recusa NOMEIA o campo errado (mesmo
 * padrão de `providers-dynamic.ts::refusal`), em vez de ignorar em silêncio.
 */
export function parseManifest(raw: string): { ok: true; manifest: PrototypeManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `prototypes.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "prototypes.json must be an object like {\"presets\":[{name,file}]}" };
  }
  const presetsRaw = (parsed as { presets?: unknown }).presets;
  if (!Array.isArray(presetsRaw)) {
    return { ok: false, error: 'prototypes.json is missing a "presets" array' };
  }
  const presets: PrototypePreset[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < presetsRaw.length; i++) {
    const entry = presetsRaw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `presets[${i}] must be an object with a non-empty "name" (string) and "file" (string)` };
    }
    const name = (entry as { name?: unknown }).name;
    const file = (entry as { file?: unknown }).file;
    const description = (entry as { description?: unknown }).description;
    if (typeof name !== "string" || name.trim() === "") {
      return { ok: false, error: `presets[${i}].name must be a non-empty string` };
    }
    if (typeof file !== "string" || file.trim() === "") {
      return { ok: false, error: `presets[${i}].file must be a non-empty string` };
    }
    if (sanitizeRelPath(file) === null) {
      return { ok: false, error: `presets[${i}].file must stay inside the prototypes root, got ${JSON.stringify(file)}` };
    }
    if (seen.has(name)) {
      return { ok: false, error: `presets has a duplicate name ${JSON.stringify(name)}` };
    }
    seen.add(name);
    presets.push(description === undefined ? { name, file } : { name, file, description: String(description) });
  }
  return { ok: true, manifest: { presets } };
}

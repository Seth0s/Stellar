/**
 * O BLOCO DE CONTEXTO POR BOARD (task 04826bdc — consolidação 7+14 do sticky).
 *
 * O PROBLEMA, nas palavras do orquestrador: metade dos briefs repete as MESMAS
 * advertências de board (a worktree é a raiz, não usar `America/Sao_Paulo` em
 * teste de fuso, falhas pré-existentes) porque isso é conhecimento do BOARD,
 * não da task — e hoje depende de alguém LEMBRAR de repetir. E armadilha de
 * domínio descoberta por revisor (ex.: `America/Sao_Paulo` é fallback do
 * ChurchTimezoneResolver, então um teste de fuso escrito com ele PASSA com a
 * resolução quebrada) vira parágrafo avulso no próximo brief manual — já
 * enganou uma rodada inteira de review.
 *
 * DUAS PARTES, e a diferença é o que as torna reutilizáveis:
 *   - ESTÁTICA (`rules`): regras do board, escritas por quem conhece o board.
 *   - ALIMENTADA (`traps`): armadilhas registradas AO CONCLUIR uma task (o
 *     revisor é quem descobre a armadilha, e o relatório é o momento natural) —
 *     persistidas e reaproveitadas nos spawns seguintes.
 *
 * POR QUE UM ARQUIVO POR BOARD, e não uma tabela nova: o bloco é lido no
 * CAMINHO DO SPAWN. Um arquivo por board em `userData`
 * (`board-context/<boardId>.json`), escrito com rename atômico, é lido sem
 * IPC, sem round-trip e sem tocar o schema do banco — e um arquivo corrompido
 * degrada para "board vazio" em vez de derrubar todo spawn (ver
 * `readBoardContext`).
 *
 * PURA de propósito nas duas funções que o spawn usa (`composeBoardContextBlock`
 * e `attachBoardContext`): o ponto onde o brief é montado não deve ganhar I/O
 * para ganhar contexto.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * O marcador que diz, dentro do brief, que o texto abaixo NÃO é a task. É
 * também o que torna o anexo IDEMPOTENTE: um texto que já o carrega não ganha
 * um segundo bloco (o caminho do auto-dispatch reusa o mesmo brief em retry).
 */
export const BOARD_CONTEXT_MARKER =
  "── CONTEXTO DO BOARD (anexado automaticamente — não é a task) ──";

const BOARD_CONTEXT_DIR = "board-context";

export type BoardContextEntry = {
  text: string;
  at: number;
  /** Quem registrou (card id, "human", ou o id de quem reportou). */
  addedBy?: string;
  /** A task em cujo encerramento a armadilha foi medida. */
  taskId?: string;
};

export type BoardContext = { rules: BoardContextEntry[]; traps: BoardContextEntry[] };

export const EMPTY_BOARD_CONTEXT: BoardContext = { rules: [], traps: [] };

export function boardContextPath(userDataDir: string, boardId: string): string {
  return join(userDataDir, BOARD_CONTEXT_DIR, `${boardId}.json`);
}

/** Comparação por texto NORMALIZADO: a mesma armadilha registrada por outro
 *  revisor, com espaço ou caixa diferentes, é a MESMA armadilha. */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A parte ALIMENTADA cresce por aqui — e é aqui que ela é contida: entrada
 * repetida não entra de novo, senão o bloco vira o que ele veio substituir
 * (texto que ninguém lê). A PRIMEIRA entrada de um texto fica, com a
 * procedência de quem a registrou primeiro.
 */
export function appendBoardContextEntry(
  ctx: BoardContext,
  kind: "rules" | "traps",
  entry: BoardContextEntry,
): BoardContext {
  const text = entry.text.trim();
  if (text === "") return ctx;
  const key = normalizeText(text);
  if (ctx[kind].some((existing) => normalizeText(existing.text) === key)) return ctx;
  return { ...ctx, [kind]: [...ctx[kind], { ...entry, text }] };
}

function parseEntries(raw: unknown): BoardContextEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardContextEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.text !== "string" || candidate.text.trim() === "") continue;
    out.push({
      text: candidate.text,
      at: typeof candidate.at === "number" ? candidate.at : 0,
      ...(typeof candidate.addedBy === "string" ? { addedBy: candidate.addedBy } : {}),
      ...(typeof candidate.taskId === "string" ? { taskId: candidate.taskId } : {}),
    });
  }
  return out;
}

/** Tolerante por contrato: forma errada vira seção vazia, nunca exceção. */
export function parseBoardContext(raw: unknown): BoardContext {
  if (typeof raw !== "object" || raw === null) return { rules: [], traps: [] };
  const obj = raw as Record<string, unknown>;
  return { rules: parseEntries(obj.rules), traps: parseEntries(obj.traps) };
}

/**
 * Lido em TODO spawn: por isso nunca lança. Arquivo ausente é board vazio;
 * arquivo corrompido é board vazio; permissão negada é board vazio. Um erro
 * aqui derrubaria o spawn inteiro por causa de um arquivo de contexto.
 */
export function readBoardContext(userDataDir: string, boardId: string): BoardContext {
  const path = boardContextPath(userDataDir, boardId);
  try {
    if (!existsSync(path)) return { rules: [], traps: [] };
    return parseBoardContext(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { rules: [], traps: [] };
  }
}

/** Escrita atômica (tmp + rename): um spawn lendo no meio da escrita vê o
 *  arquivo antigo inteiro, nunca um JSON pela metade. */
export function writeBoardContext(userDataDir: string, boardId: string, ctx: BoardContext): void {
  const path = boardContextPath(userDataDir, boardId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ctx, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function provenance(entry: BoardContextEntry): string {
  const bits: string[] = [];
  if (entry.addedBy) bits.push(`de ${entry.addedBy}`);
  if (entry.taskId) bits.push(`task ${entry.taskId}`);
  return bits.length > 0 ? ` [${bits.join(", ")}]` : "";
}

/**
 * O TEXTO anexado. Board sem nada registrado devolve `""` — "não inventar
 * bloco" é requisito, não detalhe: o brief de toda task ganharia um rodapé
 * vazio em boards novos.
 */
export function composeBoardContextBlock(ctx: BoardContext | null | undefined): string {
  if (!ctx) return "";
  const rules = ctx.rules ?? [];
  const traps = ctx.traps ?? [];
  if (rules.length === 0 && traps.length === 0) return "";
  const lines: string[] = [BOARD_CONTEXT_MARKER];
  if (rules.length > 0) {
    lines.push("REGRAS DO BOARD (valem para qualquer task deste board)");
    for (const rule of rules) lines.push(`- ${rule.text}`);
  }
  if (traps.length > 0) {
    lines.push("ARMADILHAS JÁ MEDIDAS (registradas ao concluir tasks anteriores — não repita o erro)");
    for (const trap of traps) lines.push(`- ${trap.text}${provenance(trap)}`);
  }
  return lines.join("\n");
}

/**
 * Anexa o bloco AO FINAL do texto entregue: a task continua sendo a primeira
 * coisa que o card lê.
 *
 * Dois casos que NÃO recebem o bloco, e são decisão:
 *   - texto ausente/vazio: um spawn sem brief nasce MUDO de propósito
 *     (`briefMode: "none"`), e inventar texto aqui transformaria esse estado
 *     deliberado em outro;
 *   - texto que já contém o marcador: idempotente (retry/redespacho).
 */
export function attachBoardContext(brief: string | undefined, block: string): string | undefined {
  if (typeof block !== "string" || block === "") return brief;
  if (typeof brief !== "string" || brief === "") return brief;
  if (brief.includes(BOARD_CONTEXT_MARKER)) return brief;
  return `${brief}\n\n${block}`;
}

/**
 * O conteúdo ESTÁTICO vem de um DADO versionado (`data/board-context.seed.json`),
 * nunca de um literal em TypeScript: é o protocolo de brief que o dono repetia à
 * mão, e ele tem de ser editável sem tocar código (o teste do módulo varre os
 * fontes e recusa uma regra do protocolo fora do arquivo de dados).
 *
 * Armadilhas NÃO são semeadas: `traps` é a parte que a prática alimenta
 * (`report.boardTraps`). Semear armadilha seria inventar medição.
 */
export function seedBoardContext(raw: unknown): BoardContext {
  const rules = parseEntries(
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).rules : undefined,
  );
  return { rules, traps: [] };
}

/**
 * O arquivo do board NASCE do seed e depois MANDA: só escreve quando o arquivo
 * não existe. Um board cujo arquivo foi editado (inclusive esvaziado de
 * propósito) nunca é sobrescrito — senão a edição humana não teria efeito, que é
 * exatamente o problema de ter o protocolo dentro do binário.
 *
 * Devolve o contexto que o spawn vai usar: se a escrita falhar, ainda devolve o
 * seed (o bloco vale nesta sessão; perde-se a persistência, não o contexto).
 */
export function ensureBoardContext(
  userDataDir: string,
  boardId: string,
  seed: BoardContext,
): BoardContext {
  const existing = readBoardContext(userDataDir, boardId);
  if (existsSync(boardContextPath(userDataDir, boardId))) return existing;
  try {
    writeBoardContext(userDataDir, boardId, seed);
    return seed;
  } catch {
    return seed;
  }
}

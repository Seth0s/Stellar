/**
 * A LINGUAGEM em que um provider DECLARA onde guarda as suas sessões.
 *
 * POR QUE ESTE MÓDULO EXISTE SEPARADO DA FERRAMENTA: estes tipos são o
 * CONTRATO entre as duas camadas que declaram (as specs nativas em
 * `providers.ts` e as do `providers.json`/catálogo embutido em
 * `providers-dynamic.ts`) e o único leitor (o tool em `session-watch.ts`, que
 * interpreta a declaração). Se eles morassem no leitor, o registro de
 * providers teria de importar de um consumidor do próprio registro; aqui não
 * há direção nenhuma — só forma, sem runtime, sem import de ninguém.
 *
 * O QUE É MEDIÇÃO E O QUE É GRAMÁTICA: cada VALOR declarado (o caminho, o que
 * identifica a sessão, o carimbo de tempo, como o cwd aparece) é uma medição
 * da CLI, feita com o store na mão. A FORMA abaixo é o que sobrou de comum
 * entre os cinco nativos depois de escrevê-los lado a lado — o levantamento
 * que a produziu está documentado em `session-watch.ts`, junto do leitor.
 *
 * O QUE A AUSÊNCIA DE UM `store` SIGNIFICA: nada a declarar, e portanto nada
 * a procurar. O provider não é observável — honestamente: sem âncora medida de
 * cwd e de tempo, varrer o disco às cegas acharia o arquivo de outro card.
 * Um store pode declarar só a DESCOBERTA (`read` ausente) e a resposta de
 * leitura dele continua saindo da declaração do provider, nunca de uma
 * evidência inventada: são canais diferentes e podem ter respostas diferentes.
 *
 * QUEM ESCREVE ISTO À MÃO (o `providers.json`): o campo é publicado no schema
 * ao lado do arquivo (`providers.schema.json`), com descrição, e os dois CLIs
 * embutidos aparecem em `examples` — a receita copiável. Escreva pensando em
 * quem vai ler no editor.
 */

/** De onde sai o ID de uma sessão, num store em arquivos. */
export type SessionIdSource =
  /** Nome do próprio registro, sem o sufixo: `<id>.jsonl` → `<id>`.
   *
   * `afterLast` corta mais fundo, e é o que um nome COMPOSTO exige
   * (medido, task 99f4f263): o `omp` grava
   * `2026-09-22T12-34-19-909Z_<id>.jsonl`, e o id é só a parte depois do
   * `_`. A ordem é DECLARADA e fixa — `strip` primeiro, `afterLast` depois —
   * para o resultado não depender de qual ponta se corta primeiro. Um nome
   * sem o separador não rende id nenhum (`null`): ausência, nunca um palpite
   * com o nome inteiro. Separador DECLARADO, e não uma regex: ver
   * `parseIdSource` para o que foi recusado e por quê. */
  | { from: "fileName"; strip: string; afterLast?: string }
  /** Nome do diretório que CONTÉM o registro: `chats/<hash>/<id>/meta.json`. */
  | { from: "dirName" }
  /** O JSON da primeira das PRIMEIRAS linhas não-vazias do registro em que o
   * `path` resolve (`valueAt(linha, path) !== undefined`), navegado.
   *
   * "Primeiras" e não "a primeira" (medido, task 99f4f263): o cabeçalho de um
   * log JSONL não é necessariamente a linha 1 — o `omp` grava um `title` de
   * PREENCHIMENTO na 1ª e o `session` com `id` e `cwd` na 2ª. Quem decide
   * onde parar é o `path` declarado: a busca é por ELE, e a primeira linha
   * que o tem ganha (determinístico). Nenhuma linha do prefixo varrido com o
   * caminho ⇒ ausência, nunca a última linha lida como se fosse a certa. */
  | { from: "jsonLine"; path: string[] };

/** Como um registro prova que é DESTE cwd — sem isso o watcher premia o
 * candidato errado (há histórico real de dois cards no mesmo store). */
export type SessionCwdSource =
  /** A raiz já carrega o cwd (o diretório É o cwd codificado): nada a checar. */
  | { from: "root" }
  /** O MESMO mecanismo do id (ver `SessionIdSource`): o JSON da primeira das
   * primeiras linhas em que o `path` resolve. É o que permite tirar o cwd da
   * LINHA em vez do nome da pasta — medido no `omp`, cuja pasta codifica o
   * cwd por `dashes` (o encoding que nunca foi medido para espaço, acento e
   * ponto) enquanto a linha 2 diz o cwd literal. */
  | { from: "jsonLine"; path: string[] }
  /** O próprio registro, lido como JSON e navegado. */
  | { from: "json"; path: string[] }
  /** O CASO ESPECIAL NOMEADO: o cwd do antigravity mora dentro de um blob
   * protobuf (campo length-delimited com uma URI `file://<cwd>`), sem caminho
   * de texto para apontar. Um caso nomeado com motivo é aceitável; cinco
   * seriam a tabela de funções por provider que esta linguagem substitui. */
  | { from: "binaryWorkspaceUri" };

/** O carimbo que a descoberta usa como "criada depois de". */
export type SessionTimeSource = { from: "mtime" } | { from: "json"; path: string[] };

/** A evidência do canal de LEITURA. Os dois padrões são globs com `{id}`. */
export type FileReadSpec = {
  /** O registro existe? (No cursor é o DIRETÓRIO da sessão.) */
  exists: string;
  /** Onde há conteúdo real. `minBytes` mede o próprio `exists` (arquivo);
   * `file` procura um arquivo DENTRO dele (o `store.db` do cursor) — é
   * essa diferença que produz o par exists/hasContent do cursor. */
  content: { minBytes: number } | { file: string };
};

export type SqliteReadSpec = {
  table: string;
  idColumn: string;
  timeColumn: string;
  contentTable: string;
  contentColumn: string;
};

/**
 * Como o carimbo de tempo está GRAVADO na coluna — DECLARADO, nunca
 * adivinhado. Um `>` numérico contra uma coluna TEXT compara TEXT com
 * INTEGER no SQLite e devolve TODA linha (medido no cline:
 * `WHERE started_at > 1780000000000` → 1 de 1), ou seja a varredura cega com
 * outro nome: acharia candidato sempre e premiaria a sessão errada. O leitor
 * compara na forma declarada; não coage em silêncio nem converte por
 * heurística de tamanho do número.
 *
 * `epoch-seconds` foi NOMEADO como candidato e NÃO entrou: nenhum store
 * medido o usa, e um ramo sem consumidor é adivinhação, não gramática.
 */
export type SqliteTimeFormat = "epoch-ms" | "iso-8601";

/** O store de uma CLI que grava UM REGISTRO POR ARQUIVO/DIRETÓRIO. */
export type FileStore = {
  kind: "files";
  /** `~` = home; `{cwd}` = o cwd do card; `{cwd:dashes}` = `/` → `-`
   * (claude); `{cwd:slug}` = `/` → `-`, sem o `-` inicial, MINÚSCULAS
   * (commandcode) — cada encoding com a sua amostra medida no leitor
   * (`expandRoot`, em `session-watch.ts`). */
  root: string;
  /** Glob relativo à raiz; `*` é UM segmento (nunca atravessa `/`). O
   * último segmento é o REGISTRO. */
  pattern: string;
  id: SessionIdSource;
  cwd: SessionCwdSource;
  time: SessionTimeSource;
  /** Ausente = a LEITURA deste provider não foi medida (ver `SqliteStore`). */
  read?: FileReadSpec;
};

/** O store de uma CLI cujo índice de sessões é um BANCO que ela mesma mantém
 * (o opencode; o cline). */
export type SqliteStore = {
  kind: "sqlite";
  /** Caminho do banco (mesmos placeholders de `root`). Lido sempre
   * readonly: é de outro app, que pode estar com ele aberto em WAL. */
  db: string;
  /** Default `epoch-ms` (a forma do opencode); o cline grava ISO-8601. */
  timeFormat?: SqliteTimeFormat;
  discovery: { table: string; idColumn: string; cwdColumn: string; timeColumn: string };
  /** Ausente = a LEITURA deste store não foi medida — e aí a resposta sai da
   * DECLARAÇÃO do provider (`null` × `{exists:false}`, ver
   * `getResumeTargetEvidence`), nunca de uma evidência inventada.
   * DESCOBERTA e LEITURA são canais diferentes e podem ter respostas
   * diferentes: é o caso do cline hoje. */
  read?: SqliteReadSpec;
};

/** Onde a CLI guarda sessão. A PRESENÇA de um store para o provider é o
 * que define se existe canal de descoberta. */
export type SessionStore = FileStore | SqliteStore;

/** O piso de bytes que a LEITURA usa por padrão em `content: {minBytes}`: o
 * mesmo sinal de "não é um stub vazio" que as funções à mão usavam, e
 * deliberadamente minúsculo (bem abaixo do menor stub real medido — ~268
 * bytes no primeiro write do claude), porque a pergunta é só "tem QUALQUER
 * conteúdo?", nunca "é uma conversa boa?".
 *
 * Mora aqui porque é VALOR DE DECLARAÇÃO: os stores declaram o seu piso e é
 * ele que o leitor aplica (não uma constante paralela dentro do leitor — a
 * diferença entre os dois seria um campo que mente). */
export const MIN_CONTENT_BYTES = 16;

/** A forma que um NOME DE COLUNA/TABELA precisa ter para entrar numa consulta.
 *
 * Existe aqui (e não só dentro do leitor) porque as duas pontas precisam da
 * MESMA régua: o validador recusa na ENTRADA o que o leitor recusaria na
 * saída. Duas cópias divergiriam — e o modo de falhar dessa divergência é uma
 * declaração aceita que nunca acha nada, em silêncio. */
export const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

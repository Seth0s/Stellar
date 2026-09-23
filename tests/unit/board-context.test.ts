import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BOARD_CONTEXT_MARKER,
  appendBoardContextEntry,
  attachBoardContext,
  boardContextPath,
  composeBoardContextBlock,
  parseBoardContext,
  readBoardContext,
  writeBoardContext,
  ensureBoardContext,
  seedBoardContext,
  type BoardContext,
} from "../../src/main/board-context";
import seedJson from "../../src/main/data/board-context.seed.json";

/**
 * O BLOCO DE CONTEXTO POR BOARD (task 04826bdc, consolidação 7+14 do sticky).
 *
 * O PROBLEMA MEDIDO, dito pelo orquestrador: metade dos briefs repete as MESMAS
 * advertências de board (a worktree é a raiz, não usar `America/Sao_Paulo` em
 * teste de fuso, falhas pré-existentes) porque isso é conhecimento do BOARD, não
 * da task — e hoje depende de alguém LEMBRAR de repetir. Pior: armadilha de
 * domínio descoberta por revisor (ex.: `America/Sao_Paulo` é fallback do
 * ChurchTimezoneResolver, então um teste de fuso escrito com ele passa com a
 * resolução quebrada) vira parágrafo avulso no próximo brief manual — e já
 * enganou uma rodada inteira de review.
 *
 * A decisão deste módulo: DUAS PARTES, uma ESTÁTICA (regras do board) e uma
 * ALIMENTADA (armadilhas registradas ao concluir tasks), as duas anexadas
 * automaticamente ao brief entregue.
 */

const NOW = 1_760_000_000_000;

function ctx(): BoardContext {
  return {
    rules: [{ text: "A worktree é a raiz do repo: rode os gates de dentro dela.", at: NOW }],
    traps: [
      {
        text: "ChurchTimezoneResolver cai em America/Sao_Paulo: teste de fuso escrito com ele passa com a resolução quebrada.",
        at: NOW,
        addedBy: "97924099",
        taskId: "531f8631",
      },
    ],
  };
}

describe("composeBoardContextBlock", () => {
  it("board sem nada registrado não inventa bloco (nada é anexado)", () => {
    expect(composeBoardContextBlock({ rules: [], traps: [] })).toBe("");
    expect(composeBoardContextBlock(null)).toBe("");
    expect(composeBoardContextBlock(undefined)).toBe("");
  });

  it("traz as DUAS partes, com o marcador que denuncia que não é a task", () => {
    const block = composeBoardContextBlock(ctx());
    expect(block).toContain(BOARD_CONTEXT_MARKER);
    expect(block).toContain("REGRAS DO BOARD");
    expect(block).toContain("A worktree é a raiz do repo");
    expect(block).toContain("ARMADILHAS JÁ MEDIDAS");
    expect(block).toContain("ChurchTimezoneResolver");
  });

  it("a armadilha diz DE ONDE veio (sem procedência ela é só mais um parágrafo)", () => {
    const block = composeBoardContextBlock(ctx());
    expect(block).toContain("531f8631");
    expect(block).toContain("97924099");
  });

  it("só regras, ou só armadilhas, rende bloco (a seção vazia some, não vira título solto)", () => {
    const soRegras = composeBoardContextBlock({ rules: ctx().rules, traps: [] });
    expect(soRegras).toContain("REGRAS DO BOARD");
    expect(soRegras).not.toContain("ARMADILHAS JÁ MEDIDAS");
    const soTraps = composeBoardContextBlock({ rules: [], traps: ctx().traps });
    expect(soTraps).toContain("ARMADILHAS JÁ MEDIDAS");
    expect(soTraps).not.toContain("REGRAS DO BOARD");
  });
});

describe("attachBoardContext", () => {
  const block = composeBoardContextBlock(ctx());

  it("anexa depois do texto entregue (a task continua sendo a primeira coisa)", () => {
    const out = attachBoardContext("FAÇA X", block)!;
    expect(out.startsWith("FAÇA X")).toBe(true);
    expect(out).toContain(BOARD_CONTEXT_MARKER);
  });

  it("spawn SEM brief continua MUDO (o bloco não inventa uma task)", () => {
    // `briefMode: "none"` é um estado DELIBERADO (card nasce mudo e recebe
    // ordem por send_to_card). Anexar contexto aqui o transformaria em "argv".
    expect(attachBoardContext(undefined, block)).toBeUndefined();
    expect(attachBoardContext("", block)).toBe("");
  });

  it("bloco vazio não toca no texto (nem um \\n a mais)", () => {
    expect(attachBoardContext("FAÇA X", "")).toBe("FAÇA X");
  });

  it("IDEMPOTENTE: texto que já carrega o bloco não ganha um segundo", () => {
    const uma = attachBoardContext("FAÇA X", block)!;
    expect(attachBoardContext(uma, block)).toBe(uma);
  });
});

describe("appendBoardContextEntry — a parte ALIMENTADA", () => {
  it("registra e preserva a ordem de chegada", () => {
    let ctx0: BoardContext = { rules: [], traps: [] };
    ctx0 = appendBoardContextEntry(ctx0, "traps", { text: "primeira", at: NOW });
    ctx0 = appendBoardContextEntry(ctx0, "traps", { text: "segunda", at: NOW });
    expect(ctx0.traps.map((t) => t.text)).toEqual(["primeira", "segunda"]);
  });

  it("a MESMA armadilha registrada de novo (outro revisor, outra rodada) não vira duas", () => {
    // Sem isto, o bloco cresce com repetição e vira o que ele veio substituir:
    // texto que ninguém lê.
    let ctx0: BoardContext = { rules: [], traps: [] };
    ctx0 = appendBoardContextEntry(ctx0, "traps", { text: "America/Sao_Paulo é fallback", at: NOW });
    ctx0 = appendBoardContextEntry(ctx0, "traps", { text: "  America/Sao_Paulo   é fallback ", at: NOW + 1 });
    expect(ctx0.traps).toHaveLength(1);
    expect(ctx0.traps[0]!.at).toBe(NOW); // a primeira fica
  });

  it("regras e armadilhas são seções separadas (a mesma frase nos dois não colide)", () => {
    let ctx0: BoardContext = { rules: [], traps: [] };
    ctx0 = appendBoardContextEntry(ctx0, "rules", { text: "mesma frase", at: NOW });
    ctx0 = appendBoardContextEntry(ctx0, "traps", { text: "mesma frase", at: NOW });
    expect(ctx0.rules).toHaveLength(1);
    expect(ctx0.traps).toHaveLength(1);
  });

  it("texto vazio é recusado em silêncio (não entra linha em branco)", () => {
    const ctx0 = appendBoardContextEntry({ rules: [], traps: [] }, "traps", { text: "   ", at: NOW });
    expect(ctx0.traps).toHaveLength(0);
  });
});

describe("persistência por board", () => {
  it("round-trip no arquivo do board", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-ctx-"));
    try {
      writeBoardContext(dir, "board-1", ctx());
      expect(readBoardContext(dir, "board-1")).toEqual(ctx());
      // Boards diferentes não compartilham contexto.
      expect(readBoardContext(dir, "board-2")).toEqual({ rules: [], traps: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo ausente é board VAZIO, não erro (todo spawn lê isto)", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-ctx-vazio-"));
    try {
      expect(readBoardContext(dir, "nunca-escrito")).toEqual({ rules: [], traps: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo CORROMPIDO não derruba o spawn: vira board vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-ctx-corrompido-"));
    try {
      mkdirSync(join(dir, "board-context"), { recursive: true });
      writeFileSync(boardContextPath(dir, "board-3"), "{ isto não é json");
      expect(readBoardContext(dir, "board-3")).toEqual({ rules: [], traps: [] });
      // E entradas de forma errada também não passam.
      expect(parseBoardContext({ rules: "nope", traps: [{ text: 7 }] })).toEqual({ rules: [], traps: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o caminho do arquivo é por board, dentro do userData", () => {
    expect(boardContextPath("/tmp/u", "board-9")).toBe("/tmp/u/board-context/board-9.json");
  });
});

/**
 * O PROTOCOLO DE BRIEF É DADO, NÃO CÓDIGO (task 04826bdc, adendo do dono).
 *
 * O conteúdo ESTÁTICO que o orquestrador repetia à mão (allowCommit false,
 * mutação só em cópia, nunca abrir o banco vivo, smoke isolado, nada de grep
 * recursivo no $HOME, nada de git destrutivo na árvore compartilhada, relatório
 * uma vez em inglês) tem de viver num ARQUIVO editável — e o teste abaixo cobra
 * isso LITERALMENTE: se alguém colar uma dessas regras em TypeScript, ele fica
 * vermelho. Um bloco que o humano não consegue editar não substitui o hábito de
 * repetir no brief: vira uma segunda fonte de verdade dentro do binário.
 */
describe("o protocolo é DADO (arquivo), não literal em código", () => {
  const RULES = seedBoardContext(seedJson);

  it("o seed carrega as regras do protocolo, e nenhuma armadilha inventada", () => {
    expect(RULES.rules.length).toBeGreaterThanOrEqual(7);
    expect(RULES.traps).toEqual([]);
    const joined = RULES.rules.map((r) => r.text).join(" | ");
    for (const must of [
      "allowCommit",
      "CÓPIA",
      "banco vivo",
      "Smoke",
      "grep recursivo",
      "git reset",
      "inglês",
    ]) {
      expect(joined).toContain(must);
    }
  });

  it("nenhuma regra do protocolo aparece em TypeScript (o dado mora no .json)", () => {
    // Varredura de FONTE, não de runtime: é isto que impede a regra de voltar
    // para dentro do binário na próxima pressa.
    const srcDir = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const text = readFileSync(full, "utf8");
          for (const rule of RULES.rules) {
            // A regra inteira, e um fragmento longo dela: regra copiada costuma
            // vir com o texto colado, não idêntico caractere a caractere.
            const fragment = rule.text.slice(0, 40);
            if (text.includes(rule.text) || text.includes(fragment)) offenders.push(`${full}: ${fragment}…`);
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe("ensureBoardContext — o arquivo do board nasce do seed, e depois MANDA", () => {
  it("board sem arquivo recebe o protocolo (uma vez)", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-ctx-seed-"));
    try {
      const ctx = ensureBoardContext(dir, "board-novo", seedBoardContext(seedJson));
      expect(ctx.rules.length).toBeGreaterThanOrEqual(7);
      // E ficou no disco: o humano edita DAQUI em diante.
      expect(readBoardContext(dir, "board-novo").rules.length).toBe(ctx.rules.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quem EDITOU o arquivo manda: o seed nunca sobrescreve", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-ctx-editado-"));
    try {
      writeBoardContext(dir, "board-x", { rules: [], traps: [] });
      const ctx = ensureBoardContext(dir, "board-x", seedBoardContext(seedJson));
      expect(ctx.rules).toEqual([]);
      expect(readBoardContext(dir, "board-x").rules).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

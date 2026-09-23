import { describe, it, expect } from "vitest";
import {
  SHELL_PROVIDER_IDS,
  decideCardStatus,
  hasAgentReadingLine,
  isShellProvider,
  type CardStatusFacts,
} from "../../src/main/card-status-decision";

/**
 * "TEM AGENTE LENDO ESTA LINHA?" — a pergunta que faltava (task 14b8b224).
 *
 * O DEFEITO, medido no board em 2026-09-22: quatro cards `provider: bash`
 * VAZIOS (tela em branco, nem prompt desenhado) foram vinculados a tasks e,
 * minutos depois, os quatro foram acusados de "idle without calling report" — por
 * um agente que nunca existiu. No mesmo instante, o aviso de vínculo respondia
 * `"skipped: bash has no agent reading the line"`, ou seja: o app SABIA que não
 * havia leitor e mesmo assim cobrou o report dele. Duas respostas opostas para
 * a mesma pergunta, no mesmo boot.
 *
 * A RESPOSTA ÚNICA (este módulo, ao lado de `SHELL_PROVIDER_IDS`, que é onde o
 * vocabulário de shell já morava): `hasAgentReadingLine`. Assimetria
 * DELIBERADA — só a PROVA de ausência conta como ausência:
 *
 *   - provider de AGENTE (`claude`, `cursor`, `cline`, …): o processo do card
 *     É o agente → `true`, sempre;
 *   - provider de SHELL (`bash`): `true` a não ser que o app tenha a prova de
 *     um prompt de shell livre (`at-prompt`, o fato publicado por
 *     `decideCardStatus`). Um card bash COM um TUI dentro repinta (medido,
 *     ver o cabeçalho de `card-status-decision.ts`) → bytes chegando → NÃO é
 *     `at-prompt` → tem leitor → alarme legítimo.
 *
 * E os dois lados da balança, declarados: um card bash rodando um comando
 * comum (`cargo build`) é INDISTINGUÍVEL de um TUI por estes fatos — o repo já
 * declara isso — e por isso mantém o alarme (erro BARULHENTO, nunca silêncio);
 * um TUI que fique quieto além do limiar lê `at-prompt` e é silenciado (erro
 * MUDO, herdado do modelo que o `card_status` já publica).
 */

const shell = (over: Partial<CardStatusFacts> = {}): CardStatusFacts => ({
  provider: "bash",
  alive: true,
  waitingOnConsent: false,
  lastActivityAt: 1_000_000,
  turnEndedAt: null,
  hasPendingHumanInput: false,
  now: 1_000_000 + 300_000,
  idleThresholdMs: 5_000,
  ...over,
});

describe("hasAgentReadingLine — a pergunta 'tem agente lendo?'", () => {
  it("provider de agente → true, sem olhar a tela (o processo do card É o agente)", () => {
    for (const provider of ["claude", "cursor", "codex", "opencode", "antigravity", "cline"]) {
      expect(hasAgentReadingLine(provider, () => "unknown"), provider).toBe(true);
      expect(hasAgentReadingLine(provider, () => "idle"), provider).toBe(true);
    }
  });

  it("card bash VAZIO (prompt livre, tela em branco) → NÃO tem agente lendo", () => {
    // Exatamente os quatro cards do relato: shell quieto, nada rodando dentro.
    const facts = shell();
    expect(decideCardStatus(facts)).toBe("at-prompt");
    expect(hasAgentReadingLine("bash", () => decideCardStatus(facts))).toBe(false);
  });

  it("card bash COM agente dentro (TUI repintando) → TEM agente lendo", () => {
    // O outro lado da balança, e o motivo de a distinção não ser "é bash":
    // o TUI dentro de um card bash repinta → não é prompt livre.
    const facts = shell({ lastActivityAt: 1_000_000 + 299_000 });
    expect(decideCardStatus(facts)).toBe("unknown");
    expect(hasAgentReadingLine("bash", () => decideCardStatus(facts))).toBe(true);
  });

  it("a lista de shell é UMA, e `isShellProvider` responde por ela (sem literal no call site)", () => {
    expect([...SHELL_PROVIDER_IDS]).toEqual(["bash"]);
    expect(isShellProvider("bash")).toBe(true);
    expect(isShellProvider("cline")).toBe(false);
    expect(isShellProvider(null)).toBe(false);
  });

  it("a resposta só é 'sem leitor' com PROVA: status de shell desconhecido não silencia", () => {
    // Salvaguarda contra o pior erro possível deste sinal: silenciar por falta
    // de fato. `unknown` (que é o que um bash com bytes devolve) NÃO é prova de
    // ausência — e `at-prompt` é o ÚNICO estado que prova prompt livre.
    expect(hasAgentReadingLine("bash", () => "unknown")).toBe(true);
    expect(hasAgentReadingLine("bash", () => "running")).toBe(true);
    expect(hasAgentReadingLine("bash", () => "idle")).toBe(true);
    expect(hasAgentReadingLine("bash", () => "at-prompt")).toBe(false);
  });
});

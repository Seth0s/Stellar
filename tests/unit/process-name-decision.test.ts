import { describe, it, expect } from "vitest";
import { agentProcessName, sanitizeNameToken, LINUX_COMM_MAX, AGENT_PROC_PREFIX } from "../../src/main/process-name-decision";

/** Os ids que existem hoje (nativos em `providers.ts` + dinâmicos em
 * `providers.builtin.json`). É a lista contra a qual o teto de 15 chars é
 * afirmado — um provider NOVO com id > 12 chars entra no caso de truncamento. */
const PROVIDERS_ATUAIS = ["bash", "claude", "codex", "cursor", "antigravity", "opencode", "cline", "commandcode"];

describe("process-name-decision — nome de processo por agente (task 817daa3e)", () => {
  it("prefixa o provider com `st:` — a chave de agrupamento por TIPO", () => {
    expect(agentProcessName("commandcode")).toBe("st:commandcode");
    expect(agentProcessName("claude")).toBe("st:claude");
  });

  it("cabe no teto de 15 do `comm` para TODOS os providers atuais, SEM truncar", () => {
    for (const provider of PROVIDERS_ATUAIS) {
      const nome = agentProcessName(provider);
      expect(nome.length).toBeLessThanOrEqual(LINUX_COMM_MAX);
      expect(nome).toBe(`${AGENT_PROC_PREFIX}${provider}`); // inteiro — o teto não morde hoje
    }
  });

  it("providers diferentes dão nomes diferentes (o monitor agrupa por igualdade)", () => {
    const nomes = new Set(PROVIDERS_ATUAIS.map(agentProcessName));
    expect(nomes.size).toBe(PROVIDERS_ATUAIS.length);
  });

  it("trunca no teto quando o provider passa de 12 chars — é AQUI que os 15 mordem", () => {
    const nome = agentProcessName("a".repeat(20));
    expect(nome.length).toBe(LINUX_COMM_MAX);
    expect(nome).toBe("st:aaaaaaaaaaaa"); // 3 do prefixo + 12 de provider
  });

  it("normaliza caixa/espaço/símbolo para um token determinístico", () => {
    expect(agentProcessName("Command Code!")).toBe("st:commandcode");
    expect(agentProcessName("  CLAUDE  ")).toBe("st:claude");
    expect(sanitizeNameToken("Agy")).toBe("agy");
  });

  it("provider ausente/vazio vira `st:unknown` — nunca um nome vazio", () => {
    expect(agentProcessName(null)).toBe("st:unknown");
    expect(agentProcessName(undefined)).toBe("st:unknown");
    expect(agentProcessName("")).toBe("st:unknown");
    expect(agentProcessName("!!!")).toBe("st:unknown");
  });

  it("nunca ultrapassa o teto, qualquer que seja a entrada", () => {
    for (const raw of ["", "x", "x".repeat(100), "Provider Com Espaço E Acento ção", "\0\t\n", "a.b/c\\d"]) {
      expect(agentProcessName(raw).length).toBeLessThanOrEqual(LINUX_COMM_MAX);
    }
  });
});

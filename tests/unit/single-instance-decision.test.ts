import { describe, it, expect } from "vitest";
import { decideSingleInstancePolicy, describeSingleInstanceRefusal } from "../../src/main/single-instance-decision";

describe("decideSingleInstancePolicy", () => {
  it("pede o lock em packaged e em dev — userData é compartilhado", () => {
    expect(decideSingleInstancePolicy(true)).toEqual({
      requestLock: true,
      quitIfLost: true,
    });
    expect(decideSingleInstancePolicy(false)).toEqual({
      requestLock: true,
      quitIfLost: true,
    });
  });

  it("não ramifica no isPackaged (o gate antigo era o furo)", () => {
    expect(decideSingleInstancePolicy(true)).toEqual(decideSingleInstancePolicy(false));
  });
});

describe("describeSingleInstanceRefusal", () => {
  // Achado do dono (2026-09-14): um agente subiu o app para testar, perdeu
  // o lock e o processo saiu com código 0 e stderr vazio. Quem leu a saída
  // concluiu que o TESTE estava quebrado. Estes casos travam as três
  // coisas que faltavam na mensagem.
  const msg = describeSingleInstanceRefusal("/home/u/.config/stellar");

  it("nomeia o userData disputado — é o que identifica QUAL instância", () => {
    expect(msg).toContain("/home/u/.config/stellar");
  });

  it("desfaz a leitura errada: não é falha do teste de quem chamou", () => {
    expect(msg).toMatch(/NÃO é falha do seu teste/);
  });

  it("diz POR QUE um processo por banco, com os dois recursos que colidem", () => {
    expect(msg).toContain("socket");
    expect(msg).toContain("seed de ids");
  });

  it("diz O QUE FAZER, incluindo a saída para quem só quer testar", () => {
    expect(msg).toContain("--user-data-dir");
    expect(msg).toContain("cdp-client.mjs");
  });
});

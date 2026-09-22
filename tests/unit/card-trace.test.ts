import { describe, it, expect } from "vitest";
import {
  CARD_TRACE_TAIL_MAX,
  decideTraceTailForStorage,
  redactTraceTail,
} from "../../src/main/card-trace";

/**
 * A TELA SÓ QUANDO LIGADA (decisão do dono, 2026-09-22). Estes testes são o
 * default EXECUTÁVEL: sem pedido explícito, nenhum texto de tela entra no banco —
 * nem redigido, nem cru. O que é guardado por default é a identidade do card e os
 * FATOS do registry, que não carregam texto nenhum.
 */
describe("decideTraceTailForStorage — default é NÃO guardar a tela", () => {
  it("sem `screenEnabled`, o texto sai VAZIO e a linha diz que não guardou tela", () => {
    const out = decideTraceTailForStorage({
      tail: "npx vitest run\n 220 passed\n",
    });
    expect(out.text).toBe("");
    expect(out.screenStored).toBe(false);
    expect(out.redacted).toBe(false);
  });

  it("nem um segredo em texto faz o default guardar alguma coisa", () => {
    const out = decideTraceTailForStorage({
      tail: "export ANTHROPIC_API_KEY=sk-live-9f8e7d6c5b4a3210",
    });
    expect(out.screenStored).toBe(false);
    expect(out.text).not.toContain("9f8e7d6c5b4a3210");
    expect(out.text).toBe("");
  });

  it("ligada explicitamente: guarda a cauda REDIGIDA e marca que redigiu", () => {
    const out = decideTraceTailForStorage({
      tail: "token: sk-abcdefghijklmnopqrstuvwxyz012345",
      screenEnabled: true,
    });
    expect(out.screenStored).toBe(true);
    expect(out.text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(out.redacted).toBe(true);
  });

  it("ligada e sem segredo: guarda o texto como está", () => {
    const out = decideTraceTailForStorage({ tail: "make build", screenEnabled: true });
    expect(out.text).toBe("make build");
    expect(out.screenStored).toBe(true);
    expect(out.redacted).toBe(false);
  });
});

/**
 * O QUE NÃO PODE SER GUARDADO (task 4e4ec327) — a redação do rastro.
 *
 * Estes testes são o limite EXECUTÁVEL do desenho: guardar a tela de um card de
 * trabalho é aceitável só se os segredos que atravessam essa tela não virarem
 * linha durável no banco do board. O que a redação NÃO alcança está declarado no
 * cabeçalho do módulo (prosa livre, PII em geral, e a tela que o main nem lê) — e
 * o teste do e-mail abaixo existe para isso ficar REGISTRADO como decisão, não
 * como esquecimento.
 */
describe("redactTraceTail — o rastro não guarda segredo", () => {
  it("mascara chave de API no formato sk- e diz que redigiu", () => {
    const out = redactTraceTail("encontrado sk-abcdefghijklmnopqrstuvwxyz012345 fim");
    expect(out.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(out.text).toContain("[REDIGIDO]");
    expect(out.redacted).toBe(true);
    expect(out.rules).toContain("openai/anthropic");
  });

  it("quando duas regras casam no mesmo trecho, o valor sai redigido igual (o que importa)", () => {
    // Medido: `token: sk-...` casa a regra do `sk-` E a de campo sensível; a
    // segunda reescreve por cima e o `sk-` some do texto. O VALOR continua
    // redigido (que é o limite que importa) e as DUAS regras ficam registradas.
    const out = redactTraceTail("token: sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(out.text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(out.rules).toEqual(expect.arrayContaining(["openai/anthropic", "campo sensível"]));
  });

  it("mascara o VALOR de um campo sensível e preserva o NOME do campo", () => {
    const out = redactTraceTail("export ANTHROPIC_API_KEY=sk-live-9f8e7d6c5b4a3210");
    expect(out.text).not.toContain("9f8e7d6c5b4a3210");
    expect(out.text).toContain("ANTHROPIC_API_KEY");
    expect(out.text).toContain("[REDIGIDO]");
  });

  it("mascara bloco de chave privada inteiro", () => {
    const out = redactTraceTail(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n",
    );
    expect(out.text).toBe("[CHAVE PRIVADA REDIGIDA]\n");
    expect(out.text).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("mascara credencial embutida em URI", () => {
    const out = redactTraceTail("postgres://admin:s3nh4-secreta@10.0.0.5:5432/app");
    expect(out.text).not.toContain("s3nh4-secreta");
    expect(out.text).toContain("postgres://[REDIGIDO]@");
  });

  it("texto limpo passa INTACTO e diz que não redigiu nada", () => {
    const clean = "npx vitest run tests/unit/store.test.ts\n 220 passed (220)";
    const out = redactTraceTail(clean);
    expect(out.text).toBe(clean);
    expect(out.redacted).toBe(false);
    expect(out.rules).toEqual([]);
  });

  it("capa em CARD_TRACE_TAIL_MAX mantendo o FIM (é a cauda que conta)", () => {
    const out = redactTraceTail("A".repeat(CARD_TRACE_TAIL_MAX + 5000) + "ULTIMA-LINHA");
    expect(out.text.length).toBe(CARD_TRACE_TAIL_MAX);
    expect(out.text.endsWith("ULTIMA-LINHA")).toBe(true);
  });

  it("o teto do rastro É o precedente que o app já declarou, não um número novo", () => {
    // RENDERER_GONE_PTY_HOLD.maxBytesPerCard — "scrollback is the agents' work
    // record". Se alguém trocar o teto por outro número, este teste conta.
    expect(CARD_TRACE_TAIL_MAX).toBe(512_000);
  });

  it("LIMITE DECLARADO: e-mail/PII NÃO é mascarado (decisão, não esquecimento)", () => {
    const out = redactTraceTail("autor: lucas@exemplo.com escreveu o commit");
    expect(out.text).toContain("lucas@exemplo.com");
    expect(out.redacted).toBe(false);
  });
});

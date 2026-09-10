import { describe, it, expect } from "vitest";
import { ipv4Octets, isLocalHostname, normalizeUrl } from "../../src/main/browser-registry";

/**
 * Relatado ao vivo (2026-09-08): "o navegador não resolve para http".
 * `normalizeUrl` só dava `http` para `localhost` e `127.` literais — todo
 * outro endereço local sem esquema ia para `https`, falhava no handshake
 * TLS e parecia bug do navegador. Ver o doc de `isLocalHostname`.
 *
 * A função não tinha teste nenhum até aqui, e é a fronteira de segurança
 * da navegação (rejeita `javascript:`/`file:`/`data:`), então os dois
 * lados entram: o palpite de esquema E o que continua sendo recusado.
 */

describe("normalizeUrl: endereços locais recebem http", () => {
  const locais = [
    "localhost:5173",
    "app.localhost",
    "127.0.0.1:8080",
    "127.1.2.3",
    "0.0.0.0:3000",
    "192.168.1.50:8080",
    "10.0.0.5:3000",
    "172.16.0.1",
    "172.31.255.254",
    "169.254.1.1",
    "meumac.local:8080",
    "host.docker.internal:8080",
    "[::1]:5173",
    "[fe80::1]:8080",
    "[fd00::1]",
    "buun:8080",
    "raspberrypi",
  ];

  for (const alvo of locais) {
    it(`${alvo} → http`, () => {
      expect(normalizeUrl(alvo)).toBe(`http://${alvo}`);
    });
  }
});

describe("normalizeUrl: host público continua indo para https", () => {
  const publicos = ["example.com", "example.com:8080", "sub.example.co.uk/path?a=1", "172.32.0.1", "192.169.0.1", "8.8.8.8"];

  for (const alvo of publicos) {
    it(`${alvo} → https`, () => {
      expect(normalizeUrl(alvo)).toBe(`https://${alvo}`);
    });
  }
});

describe("normalizeUrl: esquema explícito é respeitado tal e qual", () => {
  it("http:// não é promovido para https", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("https:// é preservado", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("about:blank continua sendo o vazio aceito", () => {
    expect(normalizeUrl("")).toBe("about:blank");
    expect(normalizeUrl("  ")).toBe("about:blank");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });
});

describe("normalizeUrl: a fronteira de segurança não mudou", () => {
  for (const perigoso of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/abc",
    "vbscript:msgbox",
    "about:config",
    "ftp://example.com",
  ]) {
    it(`recusa ${perigoso.slice(0, 28)}`, () => {
      expect(() => normalizeUrl(perigoso)).toThrow();
    });
  }
});

describe("isLocalHostname: partes que não são o host não confundem a decisão", () => {
  it("ignora credenciais na autoridade", () => {
    expect(isLocalHostname("user:senha@192.168.0.9:8080")).toBe(true);
    expect(isLocalHostname("user:senha@example.com")).toBe(false);
  });

  it("ignora caminho, query e fragmento", () => {
    expect(isLocalHostname("192.168.0.9/example.com")).toBe(true);
    expect(isLocalHostname("example.com/192.168.0.9")).toBe(false);
    expect(isLocalHostname("example.com?h=localhost")).toBe(false);
    expect(isLocalHostname("example.com#localhost")).toBe(false);
  });

  it("não confunde um domínio público que só CONTÉM o texto de um local", () => {
    // O `startsWith("localhost")` anterior classificaria estes como locais.
    expect(isLocalHostname("localhost.example.com")).toBe(false);
    expect(isLocalHostname("localhost-cdn.net")).toBe(false);
    expect(isLocalHostname("127.evil.com")).toBe(false);
  });

  it("host vazio não é tratado como local", () => {
    expect(isLocalHostname("")).toBe(false);
    expect(isLocalHostname("/caminho")).toBe(false);
  });
});

/**
 * Casos trazidos por um review adversarial (2026-09-08) e confirmados
 * medindo antes de corrigir. O primeiro bloco é um downgrade de segurança
 * de verdade: a regra "rótulo único é local" tratava `16843009` como
 * local, e ele é `1.1.1.1` — IP público — carregado por `http://`.
 */
describe("regressão: IPv4 em notação não decimal não escapa da checagem de faixa", () => {
  it("inteiro de 32 bits de IP PÚBLICO não vira http (era downgrade)", () => {
    expect(normalizeUrl("16843009")).toBe("https://16843009"); // 1.1.1.1
    expect(normalizeUrl("134744072")).toBe("https://134744072"); // 8.8.8.8
  });

  it("inteiro de 32 bits de loopback continua http", () => {
    expect(normalizeUrl("2130706433")).toBe("http://2130706433"); // 127.0.0.1
  });

  it("hexadecimal e octal de endereço local viram http", () => {
    expect(normalizeUrl("0x7f.1")).toBe("http://0x7f.1"); // 127.0.0.1
    expect(normalizeUrl("0177.0.0.1")).toBe("http://0177.0.0.1"); // 127.0.0.1
    expect(normalizeUrl("0xc0a80001")).toBe("http://0xc0a80001"); // 192.168.0.1
  });

  it("hexadecimal de endereço público continua https", () => {
    expect(normalizeUrl("0x08080808")).toBe("https://0x08080808"); // 8.8.8.8
  });

  it("notação curta resolve como o Chromium (última parte cobre o resto)", () => {
    expect(ipv4Octets("1.1")).toEqual([1, 0, 0, 1]);
    expect(ipv4Octets("16843009")).toEqual([1, 1, 1, 1]);
    expect(ipv4Octets("127.1")).toEqual([127, 0, 0, 1]);
    expect(normalizeUrl("127.1")).toBe("http://127.1");
    expect(normalizeUrl("10.1")).toBe("http://10.1");
  });

  it("o que não é IPv4 não é forçado a virar um", () => {
    expect(ipv4Octets("example.com")).toBeNull();
    expect(ipv4Octets("1.2.3.4.5")).toBeNull();
    expect(ipv4Octets("256.0.0.1")).toBeNull();
    expect(ipv4Octets("1.2.3.")).toBeNull();
    expect(ipv4Octets("09")).toBeNull(); // octal inválido
  });
});

describe("regressão: FQDN com ponto final e IPv4 embutido em IPv6", () => {
  it("ponto final não muda o host (localhost. é localhost)", () => {
    expect(normalizeUrl("localhost.")).toBe("http://localhost.");
    expect(normalizeUrl("meumac.local.")).toBe("http://meumac.local.");
    expect(normalizeUrl("example.com.")).toBe("https://example.com.");
  });

  it("IPv4-mapped privado em IPv6 é decidido pelo IPv4 do fim", () => {
    expect(isLocalHostname("[::ffff:192.168.0.1]")).toBe(true);
    expect(isLocalHostname("[::ffff:127.0.0.1]:8080")).toBe(true);
    expect(isLocalHostname("[::ffff:8.8.8.8]")).toBe(false);
  });

  it("IPv6 link-local com zona continua local", () => {
    expect(isLocalHostname("[fe80::1%en0]:8080")).toBe(true);
  });
});

/**
 * Pergunta do usuário (2026-09-08): "não terá problema em abrir http para
 * testes locais?". Tinha — só `localhost` e `.local` eram reconhecidos.
 * Cada sufixo aqui tem fonte, ver o doc de `LOCAL_SUFFIXES`.
 */
describe("sufixos internos não delegáveis recebem http", () => {
  const internos = [
    "servidor.lan:8080",
    "nas.home:8080",
    "box.internal:3000",
    "api.test:8080",
    "dev.home.arpa:8080",
    "maquina.localdomain",
    "app.intranet:9000",
    "srv.corp:8080",
    "host.private",
    "algo.invalid",
    "doc.example",
    "meumac.local:8080",
    "app.localhost",
  ];

  for (const alvo of internos) {
    it(`${alvo} → http`, () => {
      expect(normalizeUrl(alvo)).toBe(`http://${alvo}`);
    });
  }

  it("o sufixo sozinho, sem subdomínio, também conta", () => {
    expect(normalizeUrl("lan")).toBe("http://lan");
    expect(normalizeUrl("home.arpa")).toBe("http://home.arpa");
  });

  it("um domínio público que só TERMINA parecido continua https", () => {
    // `.lan` é local; `notlan.com` e `mylan.net` não são.
    expect(normalizeUrl("notlan.com")).toBe("https://notlan.com");
    expect(normalizeUrl("mylan.net")).toBe("https://mylan.net");
    expect(normalizeUrl("internal.example.com")).toBe("https://internal.example.com");
    expect(normalizeUrl("test.com")).toBe("https://test.com");
    expect(normalizeUrl("corp.google.com")).toBe("https://corp.google.com");
  });
});

describe("limite conhecido e aceito, documentado em vez de escondido", () => {
  it("rótulo único que também é TLD público recebe http", () => {
    // Trocar isto exigiria embutir a lista de public suffixes — ver o doc
    // de isLocalHostname. Fica registrado como decisão, não como descuido.
    expect(normalizeUrl("ai")).toBe("http://ai");
    expect(normalizeUrl("buun:8080")).toBe("http://buun:8080");
  });
});

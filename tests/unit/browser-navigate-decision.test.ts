import { describe, expect, it } from "vitest";
import {
  decideNavigateArrival,
  decideNavigatePrecheck,
  INAPP_NAV_MARKER,
  navigateInAppSource,
  normalizeRoute,
  viewFingerprintSource,
  type NavigateArrivalFacts,
  type ViewFingerprint,
} from "../../src/main/browser-navigate-decision";

/**
 * `browser_navigate` (task 18df327e) na camada que decide.
 *
 * O relato do dono: `open_url` para `/estudante/curriculo` fez a aplicação
 * reescrever a URL para `/` e renderizar uma página de 78 caracteres — a troca
 * de `location` REMONTA a SPA e o route guard rejeita a rota. A correção é a
 * navegação in-app, e o que este módulo decide é o que o smoke sozinho não
 * consegue cobrar barato: QUANDO recusar sem tocar na página, e o que conta
 * como CHEGADA (nunca "a função foi chamada").
 */
function fingerprint(overrides: Partial<ViewFingerprint> = {}): ViewFingerprint {
  return {
    href: "https://app.exemplo.com/estudante/inicio",
    origin: "https://app.exemplo.com",
    title: "Início",
    textHash: "aaaa",
    textLen: 120,
    nodeCount: 40,
    expectFound: null,
    expectError: null,
    markerSurvived: null,
    ...overrides,
  };
}

function arrivalFacts(overrides: Partial<NavigateArrivalFacts> = {}): NavigateArrivalFacts {
  const before = fingerprint();
  return {
    requestedRoute: "/estudante/curriculo",
    probes: 1,
    before,
    now: fingerprint({
      href: "https://app.exemplo.com/estudante/curriculo",
      title: "Currículo",
      textHash: "bbbb",
      textLen: 400,
      markerSurvived: true,
    }),
    markerSurvived: true,
    expectSelector: null,
    elapsedMs: 130,
    timeoutMs: 4000,
    ...overrides,
  };
}

describe("decideNavigatePrecheck — o que se recusa SEM tocar na página", () => {
  const doc = "https://app.exemplo.com/estudante/inicio";

  it("recusa outra ORIGEM sem allowDocumentNav (trocar de site é troca de documento)", () => {
    const decision = decideNavigatePrecheck({
      requested: "https://outro-site.com/estudante/curriculo",
      documentHref: doc,
      expectSelectorError: null,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.code).toBe("cross-origin");
    expect(decision.error).toContain("open_url");
    expect(decision.error).toContain("Nothing was navigated");
  });

  it("permite document-load cross-origin quando allowDocumentNav (card próprio)", () => {
    const decision = decideNavigatePrecheck({
      requested: "https://outro-site.com/path",
      documentHref: doc,
      expectSelectorError: null,
      allowDocumentNav: true,
    });
    expect(decision.action).toBe("document-load");
    if (decision.action !== "document-load") return;
    expect(decision.href).toBe("https://outro-site.com/path");
  });

  it("recusa esquema não-http(s)", () => {
    const decision = decideNavigatePrecheck({
      requested: "javascript:alert(1)",
      documentHref: doc,
      expectSelectorError: null,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.code).toBe("unsupported-scheme");
  });

  it("recusa card sem site carregado — não há sessão de SPA para preservar", () => {
    const decision = decideNavigatePrecheck({
      requested: "/estudante/curriculo",
      documentHref: "about:blank",
      expectSelectorError: null,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") expect(decision.code).toBe("blank-document");
  });

  it("recusa `expectSelector` inválido ANTES de navegar (a página não é tocada)", () => {
    const decision = decideNavigatePrecheck({
      requested: "/estudante/curriculo",
      documentHref: doc,
      expectSelectorError: "is not a valid selector",
    });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.code).toBe("invalid-expect-selector");
      expect(decision.error).toContain("Nothing was navigated");
    }
  });

  it("rota relativa resolve contra o documento; barra final NÃO é outra rota", () => {
    expect(
      decideNavigatePrecheck({ requested: "/estudante/curriculo", documentHref: doc, expectSelectorError: null }),
    ).toEqual({
      action: "navigate",
      href: "https://app.exemplo.com/estudante/curriculo",
      route: "/estudante/curriculo",
    });
    expect(
      decideNavigatePrecheck({
        requested: "https://app.exemplo.com/estudante/curriculo/",
        documentHref: doc,
        expectSelectorError: null,
      }).action,
    ).toBe("navigate");
  });

  it("já estar na rota é `already-there`: nenhum pushState, nenhuma chegada afirmada", () => {
    const decision = decideNavigatePrecheck({
      requested: "/estudante/inicio",
      documentHref: doc,
      expectSelectorError: null,
    });
    expect(decision.action).toBe("already-there");
  });

  it("normalizeRoute mantém search e hash (rota é a URL inteira, não o path)", () => {
    expect(normalizeRoute("https://x.com/a/b/?q=1#h")).toBe("/a/b?q=1#h");
    expect(normalizeRoute("não é url")).toBe("não é url");
  });
});

describe("decideNavigateArrival — chegada MEDIDA, nunca presumida", () => {
  it("a view mudou: sucesso com o sinal que provou", () => {
    const verdict = decideNavigateArrival(arrivalFacts());
    expect(verdict.settled).toBe(true);
    if (!verdict.settled || !verdict.ok) throw new Error("esperava chegada");
    expect(verdict.arrival).toBe("dom-changed");
    expect(verdict.weak).toBe(false);
    expect(verdict.signal.titleChanged).toBe(true);
  });

  it("só a contagem de nós mudou: chega, mas MARCADO como sinal fraco", () => {
    const before = fingerprint();
    const verdict = decideNavigateArrival(
      arrivalFacts({
        before,
        now: { ...before, href: "https://app.exemplo.com/estudante/curriculo", nodeCount: 41, markerSurvived: true },
      }),
    );
    if (!verdict.settled || !verdict.ok) throw new Error("esperava chegada fraca");
    expect(verdict.weak).toBe(true);
  });

  it("a aplicação reescreveu a URL de volta para `/`: FALHA nomeada (o incidente do CIEE)", () => {
    const verdict = decideNavigateArrival(
      arrivalFacts({ now: fingerprint({ href: "https://app.exemplo.com/", textHash: "cc", markerSurvived: true }) }),
    );
    expect(verdict.settled).toBe(true);
    if (!verdict.settled || verdict.ok) throw new Error("esperava recusa");
    expect(verdict.code).toBe("navigation-refused-by-app");
    expect(verdict.observedUrl).toBe("https://app.exemplo.com/");
    expect(verdict.error).toContain("/estudante/curriculo");
    expect(verdict.error).toContain("browser_click");
  });

  it("a URL ficou e a página NÃO reagiu: `no-arrival-signal`, e nada de `ok:true`", () => {
    const before = fingerprint();
    const now = { ...before, href: "https://app.exemplo.com/estudante/curriculo", markerSurvived: true };
    const verdict = decideNavigateArrival(arrivalFacts({ before, now, elapsedMs: 4000, probes: 33 }));
    expect(verdict.settled).toBe(true);
    if (!verdict.settled || verdict.ok) throw new Error("esperava recusa");
    expect(verdict.code).toBe("no-arrival-signal");
    expect(verdict.error).toContain("popstate");
  });

  it("mesma situação ANTES do limite: ainda não decide (router pode navegar por microtask)", () => {
    const before = fingerprint();
    const now = { ...before, href: "https://app.exemplo.com/estudante/curriculo", markerSurvived: true };
    expect(decideNavigateArrival(arrivalFacts({ before, now, elapsedMs: 130 })).settled).toBe(false);
  });

  it("o marcador sumiu: o documento foi TROCADO — a promessa de in-app não vale", () => {
    const verdict = decideNavigateArrival(
      arrivalFacts({
        markerSurvived: false,
        now: fingerprint({
          href: "https://app.exemplo.com/estudante/curriculo",
          textHash: "zz",
          markerSurvived: false,
        }),
      }),
    );
    if (!verdict.settled || verdict.ok) throw new Error("esperava recusa");
    expect(verdict.code).toBe("document-reloaded");
  });

  it("`expectSelector` é o sinal FORTE: casa, e a chegada é essa", () => {
    const verdict = decideNavigateArrival(
      arrivalFacts({
        expectSelector: "#curriculo-form",
        now: fingerprint({
          href: "https://app.exemplo.com/estudante/curriculo",
          expectFound: true,
          markerSurvived: true,
        }),
      }),
    );
    if (!verdict.settled || !verdict.ok) throw new Error("esperava chegada por seletor");
    expect(verdict.arrival).toBe("expect-selector");
    expect(verdict.weak).toBe(false);
  });

  it("a página reagiu mas a view esperada não apareceu: `expect-selector-missing`, não `ok`", () => {
    const verdict = decideNavigateArrival(
      arrivalFacts({
        expectSelector: "#curriculo-form",
        now: fingerprint({
          href: "https://app.exemplo.com/estudante/curriculo",
          textHash: "dd",
          expectFound: false,
          markerSurvived: true,
        }),
        elapsedMs: 4000,
      }),
    );
    if (!verdict.settled || verdict.ok) throw new Error("esperava recusa");
    expect(verdict.code).toBe("expect-selector-missing");
  });
});

describe("fontes que rodam na página", () => {
  it("a navegação in-app é pushState + popstate (+ hashchange quando o hash mudou)", () => {
    const source = navigateInAppSource("https://app.exemplo.com/estudante/curriculo", "tok-1");
    expect(source).toContain("history.pushState");
    expect(source).toContain("new PopStateEvent");
    expect(source).toContain("new HashChangeEvent");
    // Só a URL NÃO basta: sem o evento, router nenhum se mexe.
    expect(source).toContain(INAPP_NAV_MARKER);
    expect(source).toContain("tok-1");
  });

  it("a amostra carrega o token do marcador quando um é dado (document reload é detectável)", () => {
    expect(viewFingerprintSource(null)).toContain("markerSurvived");
    expect(viewFingerprintSource("#x", "tok-9")).toContain("tok-9");
    expect(viewFingerprintSource("#x", "tok-9")).toContain("querySelector");
  });
});

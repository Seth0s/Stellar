/**
 * `browser_navigate` — navegação IN-APP (`history.pushState` + `popstate`) em
 * vez de troca de DOCUMENTO (`location`), e o que a ferramenta pode AFIRMAR
 * depois de tentar.
 *
 * RELATO DO DONO (task 18df327e): no CIEE, abrir `/estudante/curriculo` e
 * `/estudante/inicio` por `open_url` fez a aplicação reescrever a URL para `/`
 * e renderizar uma página de 78 caracteres. A sessão estava viva; a navegação
 * EXTERNA é que era o problema: `open_url` troca `location`, o que REMONTA a
 * SPA, e o route guard corre num estado recém-nascido que não reconhece a
 * sessão em memória. Clicar no menu funciona porque é navegação in-app: o
 * router troca a view sem recarregar. "Isso me tirou completamente da
 * automação — dali em diante [só dava para ir] item do menu."
 *
 * A FRASE DO RELATO É HIPÓTESE, NÃO MEDIÇÃO. "pushState + popstate resolve
 * Angular Router, React Router e Vue Router" é o palpite do dono. O que este
 * módulo faz é NÃO PROMETER ISSO: ele decide o que medir, mede, e devolve um
 * erro NOMEADO quando a aplicação não reagiu. Uma navegação que aparenta ter
 * acontecido e deixa a tela na rota antiga é o defeito que esta casa mais
 * combate — `pushState` muda a URL SEM garantir que a view mudou.
 *
 * Três decisões que o formato exige:
 *
 *  1. **Só rota do MESMO site.** URL de outra origem (ou esquema não-http) é
 *     recusada ANTES de mexer na página, nomeando `open_url` — lá a troca de
 *     documento é a coisa certa. Esta é a regra de escolha entre as duas
 *     ferramentas, escrita na descrição delas.
 *  2. **Chegada é MEDIDA, não presumida.** O sinal padrão é a view mudar
 *     (título, texto, estrutura); o chamador pode dar um sinal mais forte
 *     (`expectSelector`). Sem nenhum dos dois dentro do limite, a resposta é
 *     `ok:false` com `no-arrival-signal` — e a frase diz o que fazer.
 *  3. **URL reescrita pela aplicação é FALHA, não sucesso.** É literalmente o
 *     incidente do CIEE: o guard reage ao `popstate` e devolve a URL para `/`.
 *     Isso é medido como `navigation-refused-by-app`, com a URL observada.
 *
 * Puro — sem Electron, sem I/O. As fontes que rodam DENTRO da página moram
 * aqui do lado (mesmo padrão de `browser-type-mode-decision.ts`), mas a
 * decisão nunca olha para o navegador: recebe fatos.
 */

/** Marcador posto em `window` ANTES do `pushState`. Se ele não sobreviver, o
 * documento foi TROCADO (a aplicação respondeu à rota com uma navegação de
 * documento, ou o card recarregou) — e aí a promessa de navegação in-app não
 * vale, mesmo com a URL certa no fim. */
export const INAPP_NAV_MARKER = "__stellarInAppNavMark";

/** O que a página responde numa amostra. Tudo barato e determinístico: um
 * `innerText` + contagem de nós é o mesmo custo que `get_page_text` já paga. */
export type ViewFingerprint = {
  href: string;
  origin: string;
  title: string;
  /** FNV-1a do `document.body.innerText` — muda quando a VIEW muda de
   * conteúdo, que é o sinal que interessa. Hash e não o texto: medir chegada
   * não deve carregar a página inteira pelo IPC a cada amostra. */
  textHash: string;
  textLen: number;
  /** Contagem de elementos. Sinal FRACO de propósito marcado como fraco: um
   * spinner ou um relógio mexe nisto sem trocar de rota. */
  nodeCount: number;
  /** `expectSelector` casou nesta amostra; `null` quando o chamador não deu
   * nenhum. */
  expectFound: boolean | null;
  /** Seletor inválido: `querySelector` lança, e "nunca vai aparecer" é uma
   * resposta diferente de "lançou". Recusa ANTES de navegar (nada muda na
   * página por causa de uma expectativa quebrada). */
  expectError: string | null;
  /** O marcador de `navigateInAppSource` ainda está na `window`? `null` na
   * amostra "antes", quando ainda não há marcador a procurar. `false` é o
   * sinal de que o documento foi TROCADO no meio. */
  markerSurvived: boolean | null;
};

/** Rota comparável: `pathname`+`search`+`hash`, com uma barra final
 * normalizada. Um router que normaliza `/x/` → `/x` NÃO é uma recusa; `/` no
 * lugar de `/estudante/curriculo` é. */
export function normalizeRoute(href: string): string {
  try {
    const u = new URL(href);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return path + u.search + u.hash;
  } catch {
    // String que não é URL absoluta: compara cru, sem inventar normalização.
    return href;
  }
}


export type NavigatePrecheckInput = {
  /** O que o chamador pediu — rota relativa (`/estudante/curriculo`) ou URL
   * absoluta. */
  requested: string;
  /** `location.href` do documento AGORA (amostra "antes"). */
  documentHref: string;
  /** Erro do `querySelector` do `expectSelector`, se houve — chega da mesma
   * amostra, então a recusa acontece sem ter mexido na página. */
  expectSelectorError: string | null;
  /**
   * When true (caller owns this browser card), a different origin is
   * allowed as a full document load on the SAME card — not pushState.
   * Foreign cards still refuse cross-origin (use open_url / your own card).
   */
  allowDocumentNav?: boolean;
};

export type NavigatePrecheck =
  | { action: "navigate"; href: string; route: string }
  | { action: "document-load"; href: string; route: string }
  | { action: "already-there"; href: string; route: string }
  | {
      action: "refuse";
      code: "cross-origin" | "unsupported-scheme" | "blank-document" | "invalid-expect-selector";
      error: string;
    };

/**
 * PRÉ-CHECAGEM — tudo o que pode ser recusado sem tocar na página. Nada aqui
 * chama `pushState`: a régua é "recusar antes do efeito colateral", a mesma do
 * `browser_click`.
 */
export function decideNavigatePrecheck(input: NavigatePrecheckInput): NavigatePrecheck {
  if (input.expectSelectorError !== null) {
    return {
      action: "refuse",
      code: "invalid-expect-selector",
      error:
        `browser_navigate refused before touching the page: the expectSelector is not valid CSS ` +
        `(${input.expectSelectorError}). Nothing was navigated — fix the selector, or drop it and let the tool ` +
        `measure arrival by the view changing.`,
    };
  }

  let doc: URL | null;
  try {
    doc = new URL(input.documentHref);
  } catch {
    doc = null;
  }
  if (!doc || doc.protocol === "about:" || doc.origin === "null") {
    return {
      action: "refuse",
      code: "blank-document",
      error:
        `browser_navigate refused: the card has no site loaded yet (${input.documentHref}) — there is no SPA ` +
        `whose session could survive an in-app route change. Load the site first with open_url, then use ` +
        `browser_navigate for routes INSIDE it.`,
    };
  }

  let resolved: URL;
  try {
    resolved = new URL(input.requested, input.documentHref);
  } catch {
    return {
      action: "refuse",
      code: "unsupported-scheme",
      error:
        `browser_navigate refused: ${JSON.stringify(input.requested)} is not a URL or path this card can resolve ` +
        `against ${JSON.stringify(input.documentHref)}. Give a path like "/estudante/curriculo", or a full ` +
        `same-site http(s) URL.`,
    };
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return {
      action: "refuse",
      code: "unsupported-scheme",
      error:
        `browser_navigate refused: only http(s) routes can be navigated in-app (got ${resolved.protocol}). ` +
        `Nothing was navigated.`,
    };
  }

  if (resolved.origin !== doc.origin) {
    if (input.allowDocumentNav === true) {
      // Same card, caller owns it: full document navigation (loadURL), not
      // pushState — SPA session will remount, which is expected when the
      // origin changes.
      return {
        action: "document-load",
        href: resolved.href,
        route: normalizeRoute(resolved.href),
      };
    }
    return {
      action: "refuse",
      code: "cross-origin",
      error:
        `browser_navigate refused: ${resolved.origin} is a DIFFERENT site from the page already loaded ` +
        `(${doc.origin}). On a browser card YOU own, pass the same target and browser_navigate will ` +
        `document-load the new origin on that card; otherwise use open_url. Cross-origin on someone ` +
        `else's card is still refused. Nothing was navigated.`,
    };
  }

  const route = normalizeRoute(resolved.href);
  if (route === normalizeRoute(input.documentHref)) {
    return { action: "already-there", href: resolved.href, route };
  }
  return { action: "navigate", href: resolved.href, route };
}

export type NavigateSignal = {
  title: string;
  titleChanged: boolean;
  textChanged: boolean;
  nodesChanged: boolean;
  selectorFound: boolean | null;
};

export function navigateSignal(before: ViewFingerprint, now: ViewFingerprint): NavigateSignal {
  return {
    title: now.title,
    titleChanged: before.title !== now.title,
    textChanged: before.textHash !== now.textHash,
    nodesChanged: before.nodeCount !== now.nodeCount,
    selectorFound: now.expectFound,
  };
}

export type NavigateArrivalFacts = {
  requestedRoute: string;
  /** Quantas amostras já foram feitas (1 = a primeira, logo após o
   * `pushState`) — diagnóstico honesto de "não esperei nada". */
  probes: number;
  before: ViewFingerprint;
  now: ViewFingerprint;
  /** O marcador da `window` sobreviveu até esta amostra. */
  markerSurvived: boolean;
  expectSelector: string | null;
  elapsedMs: number;
  timeoutMs: number;
};

export type NavigateArrival =
  | {
      settled: true;
      ok: true;
      arrival: "expect-selector" | "dom-changed";
      /** `true` quando o único sinal foi a CONTAGEM DE NÓS — o sinal mais
       * fraco (uma animação mexe nisso). Vai na resposta para o chamador
       * poder julgar em vez de confiar. */
      weak: boolean;
      signal: NavigateSignal;
    }
  | {
      settled: true;
      ok: false;
      code: "document-reloaded" | "navigation-refused-by-app" | "no-arrival-signal" | "expect-selector-missing";
      error: string;
      observedUrl?: string;
    }
  | { settled: false };

/**
 * A CHEGADA — a única pergunta que importa: "a view mudou mesmo?". A ordem das
 * checagens é a ordem da gravidade:
 *
 *  1. o documento foi TROCADO (marcador sumiu) — a promessa de in-app não vale;
 *  2. a aplicação reescreveu a URL para outra rota — o route guard do relato;
 *  3. o sinal forte (`expectSelector`) casou — chegada;
 *  4. sem sinal forte: a view mudou — chegada (fraca se só a estrutura mexeu);
 *  5. estourou o limite — `no-arrival-signal` (nada mudou) ou
 *     `expect-selector-missing` (mudou, mas não para a view esperada);
 *  6. senão, continua amostrando (um router que navega por microtask, como o
 *     do Angular, não termina dentro do mesmo tick do `popstate`).
 */
export function decideNavigateArrival(facts: NavigateArrivalFacts): NavigateArrival {
  const signal = navigateSignal(facts.before, facts.now);

  if (!facts.markerSurvived) {
    return {
      settled: true,
      ok: false,
      code: "document-reloaded",
      observedUrl: facts.now.href,
      error:
        `browser_navigate: the route ended up loaded, but as a DOCUMENT load, not as an in-app route change ` +
        `(the marker set in \`window\` before the pushState is gone). The SPA was rebuilt from scratch — which is ` +
        `exactly what open_url does, and the reason it drops an in-memory session.`,
    };
  }

  const observedRoute = normalizeRoute(facts.now.href);
  if (observedRoute !== facts.requestedRoute) {
    return {
      settled: true,
      ok: false,
      code: "navigation-refused-by-app",
      observedUrl: facts.now.href,
      error:
        `browser_navigate: the application itself rewrote the URL — asked for ${facts.requestedRoute}, ` +
        `${facts.probes} probe(s) later the page is at ${observedRoute}. That is the route guard rejecting an ` +
        `in-app route (it rebuilt its state and does not recognise the session). No navigation happened: the ` +
        `page is at ${facts.now.href}. Do NOT retry the same route with open_url — it remounts the SPA and hits ` +
        `the same guard. Reach this view the way a human does: browser_snapshot then browser_click on the menu ` +
        `item/link.`,
    };
  }

  if (facts.expectSelector !== null && facts.now.expectFound === true) {
    return { settled: true, ok: true, arrival: "expect-selector", weak: false, signal };
  }

  if (facts.expectSelector === null && (signal.titleChanged || signal.textChanged || signal.nodesChanged)) {
    // "Só nós mudaram" é o sinal fraco: pode ser um spinner, não a view nova.
    return {
      settled: true,
      ok: true,
      arrival: "dom-changed",
      weak: !signal.titleChanged && !signal.textChanged,
      signal,
    };
  }

  if (facts.elapsedMs >= facts.timeoutMs) {
    const changed = signal.titleChanged || signal.textChanged || signal.nodesChanged;
    if (facts.expectSelector !== null && changed) {
      return {
        settled: true,
        ok: false,
        code: "expect-selector-missing",
        observedUrl: facts.now.href,
        error:
          `browser_navigate: the page DID react (title/text/structure changed) but never showed the view you ` +
          `expected — ${JSON.stringify(facts.expectSelector)} did not match after ${facts.elapsedMs}ms. The route ` +
          `is loaded; what you expected from it is not there. Check the selector, or read the page with ` +
          `browser_query/snapshot before acting on it.`,
      };
    }
    return {
      settled: true,
      ok: false,
      code: "no-arrival-signal",
      observedUrl: facts.now.href,
      error:
        `browser_navigate: the URL was set to ${facts.requestedRoute} and the application did NOT react — title, ` +
        `text and structure are identical after ${facts.elapsedMs}ms (${facts.probes} probes). pushState changes ` +
        `the address bar without rendering anything: a router that does not listen to popstate (some Angular ` +
        `setups, hash strategies, a page that is not a SPA at all) leaves the old view on screen while the URL ` +
        `lies. Nothing changed on screen. Use browser_snapshot + browser_click on the link/menu item — that is ` +
        `in-app navigation done the way the site itself does it — or open_url if a full document load of that ` +
        `route is acceptable (it remounts the SPA and loses in-memory session state).`,
    };
  }

  return { settled: false };
}
/**
 * Corpo que roda DENTRO da página: a amostra "antes" e as amostras de
 * acompanhamento. Uma única fonte para as duas coisas — se "antes" e "depois"
 * fossem medidas por códigos diferentes, a comparação seria entre duas
 * definições de sinal, não entre dois instantes.
 */
export function viewFingerprintSource(expectSelector: string | null, markerToken: string | null = null): string {
  const sel = expectSelector === null ? "null" : JSON.stringify(expectSelector);
  const token = markerToken === null ? "null" : JSON.stringify(markerToken);
  return `(() => {
    try {
      const markerToken = ${token};
      const body = document.body;
      const text = body ? String(body.innerText || "") : "";
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
      }
      const sel = ${sel};
      let expectFound = null;
      let expectError = null;
      if (sel !== null) {
        try {
          expectFound = document.querySelector(sel) !== null;
        } catch (err) {
          expectFound = false;
          expectError = String((err && err.message) || err);
        }
      }
      return {
        __value: {
          href: String(location.href),
          origin: String(location.origin),
          title: String(document.title || ""),
          textHash: hash.toString(16),
          textLen: text.length,
          nodeCount: document.querySelectorAll("*").length,
          expectFound: expectFound,
          expectError: expectError,
          markerSurvived:
            markerToken === null
              ? null
              : window[${JSON.stringify(INAPP_NAV_MARKER)}] === markerToken,
        },
      };
    } catch (err) {
      return { __selectorError: String((err && err.message) || err) };
    }
  })()`;
}

/**
 * Corpo que roda DENTRO da página: a navegação in-app em si.
 *
 * `pushState` sozinho NÃO avisa router nenhum — o evento que o browser dispara
 * numa navegação de verdade (voltar/avançar, ou clique num link do próprio
 * site) é o `popstate`, então é ele que disparamos, com o `state` que o
 * `history.state` passou a ter. Se a rota pedida mexeu no `hash`, o browser
 * real dispara TAMBÉM `hashchange` (é o que routers por hash escutam), então
 * ele é disparado junto: reproduzir os DOIS eventos é reproduzir o que uma
 * navegação real faz, não inventar um atalho.
 *
 * O marcador é posto ANTES do `pushState`: se ele não estiver lá na amostra
 * seguinte, o documento foi trocado e a decisão sabe disso.
 */
/**
 * SPA soft-404 detection after an in-app route change.
 *
 * Heuristic (documented, ordered):
 *  1. document HTTP status is 404 (when the main-frame load reported it);
 *  2. caller-supplied `notFoundMarker` — CSS selector that matches, or a
 *     literal substring found in title/visible text;
 *  3. title matches a common 404 pattern;
 *  4. visible text (first ~800 chars) matches a common 404 pattern.
 *
 * A matched route URL alone is NEVER proof the view rendered — that was the
 * measured miss (`route:"/configuracoes"` on a SPA 404 page).
 */
const SPA_NOT_FOUND_TITLE_RE = /\b404\b|not\s*found|página\s+não\s+encontrad|pagina\s+nao\s+encontrad|page\s+not\s+found/i;
const SPA_NOT_FOUND_TEXT_RE =
  /\b404\b|not\s*found|página\s+não\s+encontrad|pagina\s+nao\s+encontrad|page\s+not\s+found|não\s+encontramos|nao\s+encontramos/i;

export type SpaNotFoundDecision = {
  notFound: boolean;
  reason: string | null;
};

export function decideSpaNotFound(input: {
  title: string;
  visibleText: string;
  /** Main-document HTTP status when known; null if unknown (pushState never loads). */
  documentStatus: number | null;
  /** Optional: CSS selector (starts with `.`/`#`/`[`/`letter`) or plain text needle. */
  notFoundMarker?: string | null;
  /** True when notFoundMarker was a selector and matched in the page. */
  markerSelectorMatched?: boolean | null;
}): SpaNotFoundDecision {
  if (input.documentStatus === 404) {
    return { notFound: true, reason: "document HTTP status is 404" };
  }
  const marker = typeof input.notFoundMarker === "string" ? input.notFoundMarker.trim() : "";
  if (marker) {
    if (input.markerSelectorMatched === true) {
      return { notFound: true, reason: `notFoundMarker selector matched: ${marker}` };
    }
    // When the marker was not a failed selector probe, also treat it as a text needle.
    if (input.markerSelectorMatched !== false) {
      const m = marker.toLowerCase();
      if (input.title.toLowerCase().includes(m) || input.visibleText.toLowerCase().includes(m)) {
        return { notFound: true, reason: `notFoundMarker text found: ${marker}` };
      }
    }
  }
  if (SPA_NOT_FOUND_TITLE_RE.test(input.title)) {
    return { notFound: true, reason: `document title looks like a 404 (${JSON.stringify(input.title.slice(0, 80))})` };
  }
  const head = input.visibleText.slice(0, 800);
  if (SPA_NOT_FOUND_TEXT_RE.test(head)) {
    return { notFound: true, reason: "visible text looks like a 404 page" };
  }
  return { notFound: false, reason: null };
}

export function navigateInAppSource(href: string, token: string): string {
  const marker = JSON.stringify(INAPP_NAV_MARKER);
  const tokenJson = JSON.stringify(token);
  return `(() => {
    try {
      window[${marker}] = ${tokenJson};
      const before = String(location.href);
      const beforeHash = String(location.hash);
      history.pushState({ stellarInAppNavigate: ${tokenJson} }, "", ${JSON.stringify(href)});
      let state = null;
      try {
        state = history.state;
      } catch (err) {}
      window.dispatchEvent(new PopStateEvent("popstate", { state: state }));
      if (String(location.hash) !== beforeHash) {
        try {
          window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: before, newURL: String(location.href) }));
        } catch (err) {}
      }
      return {
        __value: {
          pushed: true,
          href: String(location.href),
          marker: window[${marker}] === ${tokenJson},
        },
      };
    } catch (err) {
      return {
        __value: {
          pushed: false,
          href: String(location.href),
          marker: window[${marker}] === ${tokenJson},
          error: String((err && err.message) || err),
        },
      };
    }
  })()`;
}

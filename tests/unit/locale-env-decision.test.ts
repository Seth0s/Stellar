import { describe, it, expect } from "vitest";
import {
  applyLocaleEnvWrites,
  composeSystemLanguageHint,
  decideLocaleEnv,
  isExplicitCOrAsciiLocale,
  isUtf8LocaleName,
  localeEncodingWinner,
  localeLanguageSearchKeys,
  pickAvailableUtf8Locale,
} from "../../src/main/locale-env-decision";

/** Names `locale -a` actually returned on the measured Mac (subset). */
const MAC_AVAILABLE = ["C", "POSIX", "C.UTF-8", "en_US.UTF-8", "pt_BR.UTF-8", "en_US.US-ASCII"];

/** Typical glibc listing — the write form is `utf8`, not `UTF-8`. */
const LINUX_AVAILABLE = ["C", "POSIX", "C.utf8", "en_US.utf8", "pt_BR.utf8", "pt_BR.iso88591"];

describe("isUtf8LocaleName / isExplicitCOrAsciiLocale", () => {
  it("reconhece as formas UTF-8 que locale -a devolve", () => {
    expect(isUtf8LocaleName("pt_BR.UTF-8")).toBe(true);
    expect(isUtf8LocaleName("pt_BR.utf8")).toBe(true);
    expect(isUtf8LocaleName("C.UTF-8")).toBe(true);
    expect(isUtf8LocaleName("C.utf8")).toBe(true);
    expect(isUtf8LocaleName("en_US.utf-8")).toBe(true);
  });

  it("C / POSIX / US-ASCII sem sufixo UTF-8 são o caso medido", () => {
    expect(isExplicitCOrAsciiLocale("C")).toBe(true);
    expect(isExplicitCOrAsciiLocale("POSIX")).toBe(true);
    expect(isExplicitCOrAsciiLocale("en_US.US-ASCII")).toBe(true);
    expect(isExplicitCOrAsciiLocale("C.UTF-8")).toBe(false);
    expect(isExplicitCOrAsciiLocale("pt_BR.UTF-8")).toBe(false);
  });
});

describe("a — env sem locale nenhum (caso medido no Mac)", () => {
  it("escreve um LANG UTF-8 que existe na lista, na língua pedida", () => {
    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LANG: "pt_BR.UTF-8" });
  });

  it("LANG vazio e LC_* ausentes contam como ausente, não como valor", () => {
    const { writes } = decideLocaleEnv({
      env: { LANG: "", LC_ALL: "  ", LC_CTYPE: undefined },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LANG: "pt_BR.UTF-8" });
  });

  it("no Linux escreve o nome que locale -a listou (pt_BR.utf8), não um UTF-8 inventado", () => {
    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: LINUX_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LANG: "pt_BR.utf8" });
    expect(LINUX_AVAILABLE).toContain(writes.LANG);
  });
});

describe("b — LANG=C / LC_ALL=POSIX / charmap US-ASCII", () => {
  it("LANG=C → escreve LANG UTF-8", () => {
    const { writes } = decideLocaleEnv({
      env: { LANG: "C" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LANG: "pt_BR.UTF-8" });
  });

  it("LC_ALL=POSIX → UNSET do LC_ALL e escreve LANG", () => {
    // Was: writes.LC_ALL = pt_BR.UTF-8. That treated an explicit
    // override as a defect and locked every category. POSIX ch. 8 /
    // Debian: LANG is persistent; LC_ALL is a one-shot. We unset
    // LC_ALL and write LANG so the card can still set LC_TIME.
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "POSIX", LANG: "C" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LC_ALL: null, LANG: "pt_BR.UTF-8" });
  });

  it("LANG=en_US.US-ASCII → corrige para o UTF-8 da mesma língua", () => {
    const { writes } = decideLocaleEnv({
      env: { LANG: "en_US.US-ASCII" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LANG: "en_US.UTF-8" });
  });
});

describe("c — LANG=pt_BR.UTF-8 já definido → não mexe", () => {
  it("respeita o LANG UTF-8 do usuário", () => {
    const { writes } = decideLocaleEnv({
      env: { LANG: "pt_BR.UTF-8" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "en-US",
    });
    expect(writes).toEqual({});
  });

  it("C.UTF-8 já no env também é UTF-8 — não substitui", () => {
    const { writes } = decideLocaleEnv({
      env: { LANG: "C.UTF-8" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({});
  });

  it("ISO-8859-1 do usuário não é C/ASCII — não sobrescreve", () => {
    const { writes } = decideLocaleEnv({
      env: { LANG: "pt_BR.iso88591" },
      availableLocales: LINUX_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({});
  });
});

describe("d — precedência LC_ALL > LC_CTYPE > LANG", () => {
  it("LC_ALL UTF-8 ganha de LANG=C e LC_CTYPE=C — não escreve", () => {
    expect(localeEncodingWinner({ LC_ALL: "en_US.UTF-8", LC_CTYPE: "C", LANG: "C" })).toEqual({
      key: "LC_ALL",
      value: "en_US.UTF-8",
    });
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "en_US.UTF-8", LC_CTYPE: "C", LANG: "C" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({});
  });

  it("sem LC_ALL, LC_CTYPE UTF-8 ganha de LANG=C — não escreve", () => {
    expect(localeEncodingWinner({ LC_CTYPE: "pt_BR.UTF-8", LANG: "C" })).toEqual({
      key: "LC_CTYPE",
      value: "pt_BR.UTF-8",
    });
    const { writes } = decideLocaleEnv({
      env: { LC_CTYPE: "pt_BR.UTF-8", LANG: "C" },
      availableLocales: MAC_AVAILABLE,
    });
    expect(writes).toEqual({});
  });

  it("LC_ALL=C com LANG UTF-8 — UNSET do LC_ALL, LANG já está certo", () => {
    // Was: LC_ALL=pt_BR.UTF-8. An explicit C override is no longer
    // rewritten into a translated lock; we drop it so LANG wins.
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "C", LANG: "pt_BR.UTF-8" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "en-US",
    });
    expect(writes).toEqual({ LC_ALL: null });
    expect(writes.LANG).toBeUndefined();
  });

  it("LC_CTYPE=C com LANG UTF-8 — só corrige LC_CTYPE, preserva LANG", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_CTYPE: "C", LANG: "pt_BR.UTF-8" },
      availableLocales: MAC_AVAILABLE,
    });
    expect(writes).toEqual({ LC_CTYPE: "pt_BR.UTF-8" });
    expect(writes.LANG).toBeUndefined();
  });
});

describe("e — desejado indisponível → cai para um nome que existe", () => {
  it("sem pt_BR, usa C.UTF-8 da lista — nunca inventa pt_BR.UTF-8", () => {
    const available = ["C", "POSIX", "C.UTF-8", "en_US.UTF-8"];
    const chosen = pickAvailableUtf8Locale(available, ["pt_br", "pt"]);
    expect(chosen).toBe("C.UTF-8");
    expect(available).toContain(chosen);

    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: available,
      preferredLanguage: "pt-BR",
    });
    expect(writes.LANG).toBe("C.UTF-8");
    expect(writes.LANG).not.toBe("pt_BR.UTF-8");
  });

  it("lista sem nenhum UTF-8 → não escreve nome algum", () => {
    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: ["C", "POSIX", "en_US", "en_US.US-ASCII"],
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({});
  });

  it("lista vazia (locale -a falhou / Windows) → não inventa", () => {
    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: [],
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({});
  });

  it("o nome escrito é sempre um elemento da lista recebida", () => {
    const available = ["C", "ja_JP.UTF-8", "de_DE.utf8"];
    const { writes } = decideLocaleEnv({
      env: { LANG: "C" },
      availableLocales: available,
      preferredLanguage: "fr-FR",
    });
    expect(Object.values(writes).every((name) => name === null || available.includes(name))).toBe(true);
    expect(writes.LANG).toBe("ja_JP.UTF-8");
  });
});

describe("síntese de língua — env + hint do SO, sem copiar a login shell", () => {
  it("preferredLanguage pt-BR escolhe pt_BR, não C.UTF-8 (o LANG da login shell medida)", () => {
    const keys = localeLanguageSearchKeys({}, "pt-BR");
    expect(keys[0]).toBe("pt_br");
    expect(pickAvailableUtf8Locale(MAC_AVAILABLE, keys)).toBe("pt_BR.UTF-8");
  });

  it("sem hint e sem língua no env, o fallback é C.UTF-8 da lista", () => {
    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: MAC_AVAILABLE,
    });
    expect(writes).toEqual({ LANG: "C.UTF-8" });
  });
});

describe("fonte do idioma — preferred languages, não app.getLocale()", () => {
  it("preferred [pt-BR] vence um getLocale()-style en-US (o .app sem pt.lproj)", () => {
    expect(composeSystemLanguageHint(["pt-BR"], "en-US")).toBe("pt-BR");
    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: composeSystemLanguageHint(["pt-BR"], "en-US"),
    });
    expect(writes).toEqual({ LANG: "pt_BR.UTF-8" });
    expect(writes.LANG).not.toBe("en_US.UTF-8");
  });

  it("tag só com língua casa a região de getSystemLocale() quando o idioma bate", () => {
    expect(composeSystemLanguageHint(["pt"], "pt-BR")).toBe("pt-BR");
  });

  it("não inventa pt-US quando a região do sistema é outra língua", () => {
    expect(composeSystemLanguageHint(["pt"], "en-US")).toBe("pt");
    const { writes } = decideLocaleEnv({
      env: {},
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: composeSystemLanguageHint(["pt"], "en-US"),
    });
    expect(writes).toEqual({ LANG: "pt_BR.UTF-8" });
  });

  it("sem preferred language, cai no system locale (NSLocale currentLocale)", () => {
    expect(composeSystemLanguageHint([], "pt-BR")).toBe("pt-BR");
    expect(composeSystemLanguageHint(undefined, "pt-BR")).toBe("pt-BR");
    expect(composeSystemLanguageHint(null, null)).toBeNull();
  });
});

describe("LC_ALL=C explícito — UNSET, não reescrever", () => {
  it("LC_ALL=C sozinho → unset + LANG na língua do hint", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "C" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LC_ALL: null, LANG: "pt_BR.UTF-8" });
  });

  it("LC_ALL=C.UTF-8 já é UTF-8 — não mexe (override explícito com encoding)", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "C.UTF-8" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({});
  });

  it("LC_ALL=en_US.US-ASCII → unset + LANG UTF-8 da mesma língua", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "en_US.US-ASCII" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LC_ALL: null, LANG: "en_US.UTF-8" });
  });

  it("lista vazia + LANG já UTF-8 → UNSET do LC_ALL, sem inventar nome", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "C", LANG: "pt_BR.UTF-8" },
      availableLocales: [],
    });
    expect(writes).toEqual({ LC_ALL: null });
  });

  it("lista vazia + LC_ALL=C sem LANG UTF-8 → não escreve nem unset (não há nome)", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "C" },
      availableLocales: [],
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({});
  });
});

describe("writes null = unset", () => {
  it("applyLocaleEnvWrites remove LC_ALL e não stringify null", () => {
    const applied = applyLocaleEnvWrites(
      { LC_ALL: "C", LANG: "C", PATH: "/bin" },
      { LC_ALL: null, LANG: "pt_BR.UTF-8" },
    );
    expect(applied).toEqual({ LANG: "pt_BR.UTF-8", PATH: "/bin" });
    expect(applied).not.toHaveProperty("LC_ALL");
    expect(Object.values(applied).includes("null")).toBe(false);
  });

  it("applyLocaleEnvWrites com writes vazio preserva o env herdado", () => {
    expect(applyLocaleEnvWrites({ LANG: "pt_BR.UTF-8" }, {})).toEqual({ LANG: "pt_BR.UTF-8" });
  });
});

import { describe, it, expect } from "vitest";
import {
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

  it("LC_ALL=POSIX → corrige LC_ALL (é ele quem ganha)", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "POSIX", LANG: "C" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "pt-BR",
    });
    expect(writes).toEqual({ LC_ALL: "pt_BR.UTF-8" });
    expect(writes.LANG).toBeUndefined();
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

  it("LC_ALL=C ganha de LANG UTF-8 — corrige LC_ALL na língua do LANG", () => {
    const { writes } = decideLocaleEnv({
      env: { LC_ALL: "C", LANG: "pt_BR.UTF-8" },
      availableLocales: MAC_AVAILABLE,
      preferredLanguage: "en-US",
    });
    expect(writes).toEqual({ LC_ALL: "pt_BR.UTF-8" });
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
    expect(Object.values(writes).every((name) => available.includes(name))).toBe(true);
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

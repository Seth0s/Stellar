import { describe, it, expect } from "vitest";
import {
  UPDATE_FEED_FILENAME,
  UPDATE_FEED_OVERRIDE_ENV,
  decideUpdateFeed,
} from "../../src/main/update-feed-decision";

/**
 * O FEED TEM UMA FONTE SÓ (task 5fb0c21b): `build.publish` no package.json é
 * materializado pelo electron-builder em `resources/app-update.yml`, e o app
 * pergunta por ESSE arquivo — não por um literal TypeScript que podia divergir
 * da build sem ninguém notar (era `FEED_PUBLISH_CONFIG = undefined`).
 *
 * E "sem feed" continua sendo um ESTADO PRÓPRIO com motivo, nunca um sucesso
 * vazio: a lição de 2026-09-15, quando o app dizia "sem novidades" para sempre.
 */
describe("decideUpdateFeed — a pergunta é sobre o pacote em execução", () => {
  it("o arquivo que o builder escreve É a fonte: presente -> configurado", () => {
    expect(decideUpdateFeed({ appUpdateYmlPresent: true, overrideUrl: null })).toEqual({
      configured: true,
      source: "app-update.yml",
    });
  });

  it("sem o arquivo e sem override -> estado DECLARADO de sem-feed (nunca 'sem novidades')", () => {
    const state = decideUpdateFeed({ appUpdateYmlPresent: false, overrideUrl: null });
    expect(state.configured).toBe(false);
    if (state.configured) throw new Error("unreachable");
    expect(state.reason).toBe("no-feed");
    expect(state.message).toContain("baixe a versão nova");
  });

  it("o override (verificação) vence e DIZ que é override — feed de prova não se confunde com o de produção", () => {
    expect(decideUpdateFeed({ appUpdateYmlPresent: false, overrideUrl: "http://127.0.0.1:9/feed" })).toEqual({
      configured: true,
      source: "override",
    });
    // E com o arquivo presente também: o override é o que manda na prova.
    expect(decideUpdateFeed({ appUpdateYmlPresent: true, overrideUrl: "http://127.0.0.1:9/feed" })).toEqual({
      configured: true,
      source: "override",
    });
  });

  it("override em branco não conta como feed", () => {
    expect(decideUpdateFeed({ appUpdateYmlPresent: false, overrideUrl: "   " })).toMatchObject({ configured: false });
  });

  it("os nomes do arquivo e da variável são os que o resto do main usa (uma fonte, sem literal espalhado)", () => {
    expect(UPDATE_FEED_FILENAME).toBe("app-update.yml");
    expect(UPDATE_FEED_OVERRIDE_ENV).toBe("STELLAR_UPDATE_FEED_URL");
  });
});

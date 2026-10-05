import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_BACKGROUND_SESSIONS,
  computeBackgroundStatus,
  decideStopSessionConfirm,
  decideUnmountKill,
  resolveMaxBackgroundSessions,
} from "../../src/main/session-background";

/**
 * The background-session ceiling WARNS, never terminates. This file proves the
 * projection and the warning; the absence of any kill side effect is structural
 * (no function here kills), which is why the tests measure counts/booleans, not
 * processes.
 */
describe("session-background: projeção e teto", () => {
  it("conta como fundo só as sessões vivas que NÃO são a aberta", () => {
    const status = computeBackgroundStatus(
      [
        { boardId: "a", alive: true, agents: 2, awaiting: 1 },
        { boardId: "b", alive: true, agents: 1, awaiting: 0 },
        { boardId: "c", alive: false, agents: 0, awaiting: 0 },
      ],
      "a",
      4,
    );
    expect(status.backgroundCount).toBe(1);
    expect(status.overCap).toBe(false);
    expect(status.boards.b).toEqual({ alive: true, agents: 1, awaiting: 0 });
    // A aberta continua projetada (a Home pode querer o indicador dela).
    expect(status.boards.a.alive).toBe(true);
  });

  it("passa do teto = avisa (overCap), nunca some com a sessão", () => {
    const facts = ["a", "b", "c", "d", "e", "f"].map((id) => ({ boardId: id, alive: true, agents: 1, awaiting: 0 }));
    const status = computeBackgroundStatus(facts, "a", 4);
    expect(status.backgroundCount).toBe(5);
    expect(status.overCap).toBe(true);
    // Nothing was removed from the projection: the warning is not a purge.
    expect(Object.keys(status.boards)).toHaveLength(6);
  });

  it("exatamente no teto NÃO avisa", () => {
    const facts = ["a", "b", "c", "d"].map((id) => ({ boardId: id, alive: true, agents: 1, awaiting: 0 }));
    const status = computeBackgroundStatus(facts, "a", 4);
    expect(status.backgroundCount).toBe(3);
    expect(status.overCap).toBe(false);
  });

  it("teto configurável por env, com default e recusa de lixo", () => {
    expect(resolveMaxBackgroundSessions({})).toBe(DEFAULT_MAX_BACKGROUND_SESSIONS);
    expect(resolveMaxBackgroundSessions({ STELLAR_MAX_BACKGROUND_SESSIONS: "2" })).toBe(2);
    expect(resolveMaxBackgroundSessions({ STELLAR_MAX_BACKGROUND_SESSIONS: "0" })).toBe(0);
    expect(resolveMaxBackgroundSessions({ STELLAR_MAX_BACKGROUND_SESSIONS: "no" })).toBe(
      DEFAULT_MAX_BACKGROUND_SESSIONS,
    );
  });

  it("kill do desmonte da UI é pulado num card retido, e mata num card normal", () => {
    expect(decideUnmountKill(true)).toBe("skip");
    expect(decideUnmountKill(false)).toBe("kill");
  });

  it("parar sessão pede confirmação só quando há agente rodando", () => {
    expect(decideStopSessionConfirm(2)).toBe(true);
    expect(decideStopSessionConfirm(0)).toBe(false);
  });
});

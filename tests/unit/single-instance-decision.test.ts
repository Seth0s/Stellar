import { describe, it, expect } from "vitest";
import { decideSingleInstancePolicy } from "../../src/main/single-instance-decision";

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

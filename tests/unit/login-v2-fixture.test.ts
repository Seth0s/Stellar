import { describe, expect, it, vi } from "vitest";
import { loadLoginV2Fixture } from "../../src/main/login-v2-fixture";

const SAMPLE = JSON.stringify({
  boot: { sessionCount: 4, homeSynced: true, hold: true },
});

describe("loadLoginV2Fixture", () => {
  it("packaged: ignores STELLAR_LOGIN_V2_FIXTURE and never reads the file", () => {
    const readFile = vi.fn(() => SAMPLE);
    const result = loadLoginV2Fixture({
      isPackaged: true,
      envPath: "/tmp/should-not-be-read.json",
      readFile,
    });
    expect(result).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("unpackaged: reads the fixture path and returns the JSON", () => {
    const readFile = vi.fn(() => SAMPLE);
    const result = loadLoginV2Fixture({
      isPackaged: false,
      envPath: "/tmp/login-v2-boot.json",
      readFile,
    });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("/tmp/login-v2-boot.json", "utf8");
    expect(result).toEqual({ boot: { sessionCount: 4, homeSynced: true, hold: true } });
  });
});

import { describe, expect, it, vi } from "vitest";
import { loadRadialFixture } from "../../src/main/radial-fixture";
import { acceptLooseRadialFixture } from "../../src/renderer/src/radial-mock";

const SAMPLE = JSON.stringify({
  defaultProviderId: "claude",
  providers: [{ id: "claude", label: "Claude", quota: "77% semana", tone: "ok", dim: false, stats: {} }],
});

describe("loadRadialFixture", () => {
  it("packaged: ignores STELLAR_RADIAL_FIXTURE and never reads the file", () => {
    const readFile = vi.fn(() => SAMPLE);
    const result = loadRadialFixture({
      isPackaged: true,
      envPath: "/tmp/should-not-be-read.json",
      readFile,
    });
    expect(result).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("unpackaged: reads the fixture path and returns the JSON", () => {
    const readFile = vi.fn(() => SAMPLE);
    const result = loadRadialFixture({
      isPackaged: false,
      envPath: "/tmp/radial-v3.json",
      readFile,
    });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("/tmp/radial-v3.json", "utf8");
    expect(result).toEqual({
      defaultProviderId: "claude",
      providers: [{ id: "claude", label: "Claude", quota: "77% semana", tone: "ok", dim: false, stats: {} }],
    });
  });

  it("unpackaged with empty path: returns null without reading", () => {
    const readFile = vi.fn(() => SAMPLE);
    const result = loadRadialFixture({
      isPackaged: false,
      envPath: "",
      readFile,
    });
    expect(result).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("acceptLooseRadialFixture (renderer)", () => {
  const loose = {
    defaultProviderId: "evil",
    providers: [{ id: "evil", label: "Evil", quota: "", tone: "muted", dim: false, stats: {} }],
  };

  it("production renderer: discards loose window global", () => {
    expect(acceptLooseRadialFixture(false, loose)).toBeNull();
  });

  it("dev renderer: accepts a well-formed loose global", () => {
    expect(acceptLooseRadialFixture(true, loose)?.defaultProviderId).toBe("evil");
  });
});

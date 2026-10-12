import { describe, it, expect } from "vitest";
import { classifyUpdateError, firstLine, isUpdateCancellation } from "../../src/main/update-error-decision";

describe("classifyUpdateError", () => {
  it("tells a full disk first, even inside a download error", () => {
    expect(classifyUpdateError({ code: "ENOSPC", message: "ENOSPC: no space left on device, write" })).toBe("disk");
    expect(classifyUpdateError({ message: "net::ERR_FAILED while writing: no space left on device" })).toBe("disk");
  });

  it("tells a checksum or signature failure", () => {
    expect(classifyUpdateError({ message: "sha512 checksum mismatch, expected 7f3a, got 02bd" })).toBe("signature");
    expect(classifyUpdateError({ code: "ERR_UPDATER_CHECKSUM_MISMATCH", message: "x" })).toBe("signature");
  });

  it("tells a network failure", () => {
    expect(classifyUpdateError({ message: "net::ERR_INTERNET_DISCONNECTED" })).toBe("network");
    expect(classifyUpdateError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND github.com" })).toBe("network");
    expect(classifyUpdateError({ message: "socket hang up" })).toBe("network");
  });

  it("does not guess when nothing matches", () => {
    expect(classifyUpdateError({ message: "Command dnf exited with code 1" })).toBe("unknown");
  });
});

describe("isUpdateCancellation", () => {
  it("recognises the library's cancellation, and only that", () => {
    const err = new Error("cancelled");
    err.name = "CancellationError";
    expect(isUpdateCancellation(err)).toBe(true);
    expect(isUpdateCancellation(new Error("cancelled"))).toBe(true);
    expect(isUpdateCancellation(new Error("net::ERR_ABORTED"))).toBe(false);
    expect(isUpdateCancellation("cancelled")).toBe(false);
  });
});

describe("firstLine", () => {
  it("keeps the first line and caps it", () => {
    expect(firstLine("boom\n    at stack")).toBe("boom");
    expect(firstLine("x".repeat(300), 10)).toBe("xxxxxxxxx…");
  });
});

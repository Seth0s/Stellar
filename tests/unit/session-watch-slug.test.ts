import { describe, it, expect } from "vitest";
import { kebabSlug } from "../../src/main/session-watch";

/**
 * The commandcode project-directory encoding. The names checked as observed
 * are the ones the real `~/.commandcode/projects/` holds; the camelCase split
 * is the part a plain `toLowerCase()` missed, leaving `resume_id` null.
 */
describe("kebabSlug — the commandcode project-directory encoding", () => {
  it("lowercases path separators for an all-lowercase path", () => {
    expect(kebabSlug("/home/lucas/Workplace/Projects")).toBe("home-lucas-workplace-projects");
    expect(kebabSlug("/tmp")).toBe("tmp");
  });

  it("splits a camelCase segment with a dash (Stellar -> stellar, StellarCloud -> stellar-cloud)", () => {
    expect(kebabSlug("/home/lucas/Workplace/Projects/Stellar")).toBe("home-lucas-workplace-projects-stellar");
    expect(kebabSlug("/home/lucas/Workplace/Projects/StellarCloud")).toBe(
      "home-lucas-workplace-projects-stellar-cloud",
    );
    expect(kebabSlug("/home/lucas/Workplace/Projects/StellarPage")).toBe(
      "home-lucas-workplace-projects-stellar-page",
    );
  });

  it("keeps an existing dash and splits an all-caps run", () => {
    expect(kebabSlug("/home/lucas/Workplace/Projects/IDY-Platform")).toBe(
      "home-lucas-workplace-projects-idy-platform",
    );
  });

  it("does not leave a leading/trailing/double dash", () => {
    expect(kebabSlug("/tmp//A//B/").startsWith("-")).toBe(false);
    expect(kebabSlug("/tmp//A//B/").includes("--")).toBe(false);
  });
});

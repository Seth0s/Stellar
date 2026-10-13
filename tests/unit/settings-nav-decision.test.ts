import { describe, it, expect } from "vitest";
import {
  SETTINGS_NAV,
  decideSettingsPageAfterFilter,
  filterSettingsNav,
  normalizeSettingsPage,
  settingsNavEntry,
  settingsNavForScope,
  settingsScopeLabel,
} from "../../src/renderer/src/settings-nav-decision";

import { PROFILE_NAME_MAX } from "../../src/renderer/src/SettingsProfilesPage";
import { MAX_PROFILE_NAME_LENGTH } from "../../src/main/profiles-decision";

describe("Perfis page", () => {
  it("shows the same name limit the registry enforces", () => {
    expect(PROFILE_NAME_MAX).toBe(MAX_PROFILE_NAME_LENGTH);
  });
});

describe("settings-nav-decision", () => {
  it("maps legacy maestro/agents onto mode", () => {
    expect(normalizeSettingsPage("maestro")).toBe("mode");
    expect(normalizeSettingsPage("agents")).toBe("mode");
    expect(normalizeSettingsPage("providers")).toBe("providers");
  });

  it("splits Aplicativo × Este board in prototype order", () => {
    expect(settingsNavForScope("app").map((e) => e.id)).toEqual([
      "account",
      "profiles",
      "providers",
      "shortcuts",
      "keys",
      "devices",
      "appearance",
      "performance",
      "general",
    ]);
    expect(settingsNavForScope("board").map((e) => e.id)).toEqual(["mode", "rules", "team"]);
  });

  it("marks new pages from the prototype", () => {
    const news = SETTINGS_NAV.filter((e) => e.isNew).map((e) => e.id);
    expect(news).toEqual(["account", "profiles", "appearance", "performance", "rules", "team"]);
  });

  it("filters by search token without moving scope", () => {
    const app = settingsNavForScope("app");
    const hit = filterSettingsNav("cota", app, (e) => e.id);
    expect(hit.map((e) => e.id)).toEqual(["providers"]);
    const miss = filterSettingsNav("zzzz-no-match", app, (e) => e.id);
    expect(miss).toEqual([]);
  });

  it("finds the Perfis page by its own words", () => {
    const app = settingsNavForScope("app");
    expect(filterSettingsNav("renomear", app, (e) => e.id).map((e) => e.id)).toEqual(["profiles"]);
    expect(filterSettingsNav("perfil", app, (e) => e.id).map((e) => e.id)).toEqual(["profiles"]);
  });

  it("empty query keeps the full list", () => {
    const all = settingsNavForScope("board");
    expect(filterSettingsNav("  ", all, (e) => e.labelKey)).toEqual([...all]);
  });

  it("scope chip uses board name when present", () => {
    expect(settingsScopeLabel("app", null)).toEqual({ key: "settings.scope.app" });
    expect(settingsScopeLabel("board", { id: "64", name: "Board 64" })).toEqual({
      key: "settings.scope.boardNamed",
      params: { name: "Board 64" },
    });
  });

  it("after filter, keeps current when still visible else first hit", () => {
    const visible = [settingsNavEntry("account"), settingsNavEntry("providers")];
    expect(decideSettingsPageAfterFilter("providers", visible)).toBe("providers");
    expect(decideSettingsPageAfterFilter("shortcuts", visible)).toBe("account");
    expect(decideSettingsPageAfterFilter("shortcuts", [])).toBeNull();
  });
});

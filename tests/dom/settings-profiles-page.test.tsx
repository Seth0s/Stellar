/**
 * Settings › Perfis (Configuracoes.dc.html #perfis): the machine's profiles can
 * be renamed here; the account's are read-only. Geometry is measured against
 * the prototype in the app by scripts/verify/smoke-profile-settings.mjs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { ProfilesPage } from "@renderer/SettingsProfilesPage";
import { PROFILES_CHANGED_EVENT } from "@renderer/settings-nav-decision";
import { setLocale } from "../../src/shared/i18n";
import type { ProfileView, ProfilesState } from "../../src/preload/index";

let cloud: unknown = null;
let accountProfiles: { id: string; name: string; kind: "personal" | "team"; teamId: string | null }[] = [];
vi.mock("@renderer/PlanHooks", () => ({
  useCloudPlan: () => ({ status: cloud, plan: null, loggedIn: cloud !== null }),
}));
vi.mock("@renderer/account-scope", () => ({
  useAccountProfiles: () => ({ profiles: accountProfiles, status: "ok", savedAtMs: null, reload: () => {} }),
}));

const profile = (over: Partial<ProfileView>): ProfileView => ({
  id: "p1",
  name: "Pessoal",
  kind: "personal",
  createdAt: 1,
  homeMode: "system",
  isDefault: true,
  isActive: true,
  openable: true,
  teamId: null,
  teamSlug: null,
  detached: false,
  ...over,
});
const stateOf = (profiles: ProfileView[]): ProfilesState => ({ registryPath: "/x/profiles.json", activeProfileId: "p1", profiles });
const base = [profile({}), profile({ id: "p2", name: "Idy Platform", kind: "team", homeMode: "isolated", isActive: false, isDefault: false })];

let current: ProfileView[];
let list: ReturnType<typeof vi.fn>;
let rename: ReturnType<typeof vi.fn>;

async function mount() {
  const view = render(<ProfilesPage />);
  await act(async () => {});
  return view;
}
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-part="profile-row"]'));
const q = (sel: string) => document.querySelector<HTMLElement>(sel);

beforeEach(() => {
  setLocale("pt-BR");
  cloud = null;
  accountProfiles = [];
  current = base;
  // The registry is the source of truth: a rename is visible to the next list() too.
  list = vi.fn(async () => stateOf(current));
  rename = vi.fn(async (id: string, name: string) => {
    current = current.map((p) => (p.id === id ? { ...p, name } : p));
    return { ok: true as const, state: stateOf(current) };
  });
  Object.assign(window, { profiles: { list, rename } });
});

describe("Perfis page", () => {
  it("lists the machine's profiles with the kind, the folders and the active mark", async () => {
    await mount();
    expect(rows().map((r) => r.querySelector('[data-part="profile-name"]')?.textContent)).toEqual(["Pessoal", "Idy Platform"]);
    expect(rows()[0]!.textContent).toContain("ativo");
    expect(rows()[0]!.textContent).toContain("Pessoal · pastas do sistema");
    expect(rows()[1]!.textContent).toContain("Empresa · pastas do perfil");
    expect(rows()[1]!.textContent).not.toContain("ativo");
    expect(document.querySelectorAll('[data-part="rename-btn"]').length).toBe(2);
    expect(q('[data-part="profiles-account"]')).toBeNull();
  });

  it("'Renomear' turns the row into a field with the current name, Salvar and Cancelar", async () => {
    await mount();
    fireEvent.click(q('[data-part="rename-btn"]')!);
    const input = q('[data-part="rename-input"]') as HTMLInputElement;
    expect(input.value).toBe("Pessoal");
    expect(document.activeElement).toBe(input);
    expect(q('[data-part="rename-save"]')!.textContent).toBe("Salvar");
    expect(q('[data-part="rename-cancel"]')!.textContent).toBe("Cancelar");
    expect(rows()[0]!.textContent).toContain("Só o nome muda");
    // the other profile keeps its Renomear button
    expect(rows()[1]!.querySelector('[data-part="rename-btn"]')).toBeTruthy();
  });

  it("Salvar renames through profiles:rename, shows the new name and announces the change", async () => {
    await mount();
    const changed = vi.fn();
    window.addEventListener(PROFILES_CHANGED_EVENT, changed);
    fireEvent.click(q('[data-part="rename-btn"]')!);
    fireEvent.change(q('[data-part="rename-input"]')!, { target: { value: "  Ana  " } });
    await act(async () => void fireEvent.click(q('[data-part="rename-save"]')!));
    expect(rename).toHaveBeenCalledWith("p1", "Ana");
    expect(rows()[0]!.querySelector('[data-part="profile-name"]')?.textContent).toBe("Ana");
    expect(q('[data-part="rename-input"]')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(PROFILES_CHANGED_EVENT, changed);
  });

  it("Enter saves and an unchanged name just leaves the edit", async () => {
    await mount();
    fireEvent.click(q('[data-part="rename-btn"]')!);
    await act(async () => void fireEvent.keyDown(q('[data-part="rename-input"]')!, { key: "Enter" }));
    expect(rename).not.toHaveBeenCalled();
    expect(q('[data-part="rename-input"]')).toBeNull();
  });

  it("a repeated name stays in edit with the reason under the field and the red border", async () => {
    rename.mockResolvedValue({ ok: false as const, reason: "duplicate-name", state: stateOf(base) });
    await mount();
    fireEvent.click(q('[data-part="rename-btn"]')!);
    fireEvent.change(q('[data-part="rename-input"]')!, { target: { value: "Idy Platform" } });
    await act(async () => void fireEvent.click(q('[data-part="rename-save"]')!));
    expect(q('[data-part="rename-error"]')!.textContent).toBe("Já existe um perfil com esse nome nesta máquina.");
    expect(q('[data-part="rename-input"]')!.getAttribute("aria-invalid")).toBe("true");
    expect(q('[data-part="rename-input"]')!.className).toMatch(/profileInputError/);
    // typing again clears the message
    fireEvent.change(q('[data-part="rename-input"]')!, { target: { value: "Idy" } });
    expect(q('[data-part="rename-error"]')).toBeNull();
  });

  it("the modal's first close request (Esc) only leaves the edit; the next one closes", async () => {
    const closeInterceptorRef = { current: null as (() => boolean) | null };
    render(<ProfilesPage closeInterceptorRef={closeInterceptorRef} />);
    await act(async () => {});
    expect(closeInterceptorRef.current!()).toBe(false);
    fireEvent.click(q('[data-part="rename-btn"]')!);
    expect(q('[data-part="rename-input"]')).toBeTruthy();
    act(() => void expect(closeInterceptorRef.current!()).toBe(true));
    expect(q('[data-part="rename-input"]')).toBeNull();
    expect(closeInterceptorRef.current!()).toBe(false);
  });

  describe("account profiles", () => {
    const accountSession = () => {
      cloud = { state: "logged-in", account: { displayName: "Ana Exemplo", identities: [{ kind: "email", login: "ana@example.com" }] } };
      accountProfiles = [
        { id: "a1", name: "Pessoal", kind: "personal", teamId: null },
        { id: "a2", name: "Idy Platform", kind: "team", teamId: "t1" },
      ];
    };
    let renameAccountProfile: ReturnType<typeof vi.fn>;
    let role: "owner" | "admin" | "member";
    const accountRows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-part="account-profile-row"]'));

    beforeEach(() => {
      role = "owner";
      accountSession();
      renameAccountProfile = vi.fn(async (id: string, name: string) => ({ ok: true as const, profile: { id, name } }));
      Object.assign(window, {
        profiles: { list, rename, renameAccountProfile },
        team: {
          overview: vi.fn(async () => ({ ok: true, view: { accountId: "me", displayName: "Ana", teams: [], profiles: [], identitySubjects: [] } })),
          detail: vi.fn(async () => ({ ok: true, detail: { team: {}, members: [{ accountId: "me", role }], seats: null } })),
        },
      });
    });

    it("lists them with the note and a Renomear button each", async () => {
      await mount();
      const section = q('[data-part="profiles-account"]')!;
      expect(section.textContent).toContain("ana@example.com");
      expect(accountRows().length).toBe(2);
      expect(section.textContent).toContain("Pessoal · sincronizada");
      expect(section.querySelectorAll('[data-part="rename-btn"]').length).toBe(2);
      expect(q('[data-part="account-name-note"]')!.textContent).toContain("owner ou admin");
    });

    it("the personal profile is always renamable; the team's is for its owner or admin", async () => {
      await mount();
      const buttons = accountRows().map((r) => r.querySelector<HTMLButtonElement>('[data-part="rename-btn"]')!);
      expect(buttons[0]!.disabled).toBe(false);
      expect(buttons[1]!.disabled).toBe(false);
      expect(accountRows()[1]!.querySelector('[data-part="rename-blocked"]')).toBeNull();
    });

    it("a plain member sees the team profile's button disabled, with the reason as text and as the tip", async () => {
      role = "member";
      await mount();
      const [personalRow, teamRow] = accountRows();
      expect(personalRow!.querySelector<HTMLButtonElement>('[data-part="rename-btn"]')!.disabled).toBe(false);
      const button = teamRow!.querySelector<HTMLButtonElement>('[data-part="rename-btn"]')!;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("owner ou admin");
      expect(teamRow!.querySelector('[data-part="rename-blocked"]')?.getAttribute("data-reason")).toBe("role");
    });

    it("renames through the main process, then announces the change so the lists reload", async () => {
      await mount();
      const changed = vi.fn();
      window.addEventListener(PROFILES_CHANGED_EVENT, changed);
      fireEvent.click(accountRows()[0]!.querySelector('[data-part="rename-btn"]')!);
      const input = q('[data-part="rename-input"]') as HTMLInputElement;
      expect(input.value).toBe("Pessoal");
      expect(accountRows()[0]!.textContent).toContain("Só o nome muda");
      fireEvent.change(input, { target: { value: "  Casa  " } });
      await act(async () => void fireEvent.click(q('[data-part="rename-save"]')!));
      expect(renameAccountProfile).toHaveBeenCalledWith("a1", "Casa");
      expect(rename).not.toHaveBeenCalled();
      expect(q('[data-part="rename-input"]')).toBeNull();
      expect(changed).toHaveBeenCalledTimes(1);
      window.removeEventListener(PROFILES_CHANGED_EVENT, changed);
    });

    it("a repeated name (409) stays in edit with the account's own text under the field", async () => {
      renameAccountProfile.mockResolvedValue({ ok: false as const, reason: "duplicate-name" });
      await mount();
      fireEvent.click(accountRows()[0]!.querySelector('[data-part="rename-btn"]')!);
      fireEvent.change(q('[data-part="rename-input"]')!, { target: { value: "Idy Platform" } });
      await act(async () => void fireEvent.click(q('[data-part="rename-save"]')!));
      expect(q('[data-part="rename-error"]')!.textContent).toBe("Já existe um perfil com esse nome nesta conta.");
      expect(q('[data-part="rename-input"]')!.getAttribute("aria-invalid")).toBe("true");
      expect(q('[data-part="rename-input"]')!.className).toMatch(/profileInputError/);
      fireEvent.change(q('[data-part="rename-input"]')!, { target: { value: "Idy" } });
      expect(q('[data-part="rename-error"]')).toBeNull();
    });

    it("a refusal for permission or connection says so, and the unchanged name never calls the server", async () => {
      renameAccountProfile.mockResolvedValue({ ok: false as const, reason: "forbidden" });
      await mount();
      fireEvent.click(accountRows()[1]!.querySelector('[data-part="rename-btn"]')!);
      await act(async () => void fireEvent.click(q('[data-part="rename-save"]')!));
      expect(renameAccountProfile).not.toHaveBeenCalled();
      expect(q('[data-part="rename-input"]')).toBeNull();
      fireEvent.click(accountRows()[1]!.querySelector('[data-part="rename-btn"]')!);
      fireEvent.change(q('[data-part="rename-input"]')!, { target: { value: "Outro" } });
      await act(async () => void fireEvent.click(q('[data-part="rename-save"]')!));
      expect(q('[data-part="rename-error"]')!.textContent).toBe("Você não tem permissão para renomear este perfil.");
    });

    it("only one name is edited at a time, and Esc leaves the account edit too", async () => {
      const closeInterceptorRef = { current: null as (() => boolean) | null };
      render(<ProfilesPage closeInterceptorRef={closeInterceptorRef} />);
      await act(async () => {});
      fireEvent.click(accountRows()[0]!.querySelector('[data-part="rename-btn"]')!);
      expect(document.querySelectorAll('[data-part="rename-input"]').length).toBe(1);
      fireEvent.click(rows()[0]!.querySelector('[data-part="rename-btn"]')!);
      expect(document.querySelectorAll('[data-part="rename-input"]').length).toBe(1);
      expect(rows()[0]!.getAttribute("data-editing")).toBe("true");
      expect(accountRows()[0]!.getAttribute("data-editing")).toBeNull();
      act(() => void expect(closeInterceptorRef.current!()).toBe(true));
      expect(q('[data-part="rename-input"]')).toBeNull();
    });
  });
});

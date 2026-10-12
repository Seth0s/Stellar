import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setLocale } from "../../src/shared/i18n";
import type { CloudPlanInfo, CloudStatusInfo, TeamInviteInfo, TeamMemberInfo, TeamRole, TeamSeatsInfo } from "../../src/preload/index";
import { TeamPage } from "@renderer/TeamPage";
import { InviteDialog } from "@renderer/InviteDialog";

/**
 * Team administration on the canonical team page and the invite dialog,
 * driven through a fake `window.team` / `window.cloud`: seats, the member row
 * rules (last owner), the invite modal (link once, email, 503, no seat), the
 * settings (rename, delete with the slug), the beta create screen, and the
 * guest's path through the invite dialog.
 */

const ME = "33333333-3333-4333-8333-333333333333";
const RIO = "44444444-4444-4444-8444-444444444444";
const SAM = "55555555-5555-4555-8555-555555555555";
const TEAM = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Nebula Labs", slug: "nebula-labs", shareFilePaths: false };
const LINK = "https://stellar.example.test/invite#t=ex_tok_7f3a9c2e1b4d5e6f";

function m(accountId: string, role: TeamRole, name: string, email: string | null): TeamMemberInfo {
  return { accountId, role, joinedAt: null, displayName: name, avatarInitials: name.slice(0, 2).toUpperCase(), email };
}

const MEMBERS = [m(ME, "owner", "Maya Chen", "maya@example.com"), m(RIO, "admin", "Rio Alvarez", "rio@example.com"), m(SAM, "member", "Sam Okonkwo", null)];

const GRANTED: CloudPlanInfo = {
  accountPlan: "free",
  accountExpiresAt: null,
  rights: {
    sync: { granted: false, state: "none", plan: "pro", source: null, teamId: null, expiresAt: null },
    team: { granted: true, state: "active", plan: "team", source: "team", teamId: TEAM.id, expiresAt: null },
  },
};
const NO_TEAM_PLAN: CloudPlanInfo = {
  ...GRANTED,
  rights: { ...GRANTED.rights, team: { granted: false, state: "none", plan: "team", source: null, teamId: null, expiresAt: null } },
};

type Mock = ReturnType<typeof vi.fn>;
type TeamMock = Record<string, Mock>;

function cloudStatus(plan: CloudPlanInfo | null, identities: { kind: string; subject: string; login: string | null }[] = []): CloudStatusInfo {
  return { state: "logged-in", apiBaseUrl: "https://api.example.test", account: { displayName: "Maya", identities }, plan, expiresAtMs: Date.now() + 60000 };
}

function install(opts: {
  plan?: CloudPlanInfo | null;
  teams?: (typeof TEAM)[];
  members?: TeamMemberInfo[];
  seats?: TeamSeatsInfo | null;
  invites?: TeamInviteInfo[];
  team?: Partial<TeamMock>;
}): TeamMock {
  const state = { teams: opts.teams ?? [TEAM], members: opts.members ?? MEMBERS, seats: opts.seats === undefined ? { used: 3, total: 5, expiresAt: null } : opts.seats };
  const team: TeamMock = {
    overview: vi.fn(async () => ({ ok: true, view: { accountId: ME, displayName: "Maya", teams: state.teams, profiles: [], identitySubjects: [] } })),
    detail: vi.fn(async () => ({ ok: true, detail: { team: state.teams[0] ?? TEAM, members: state.members, seats: state.seats } })),
    sprints: vi.fn(async () => ({ ok: true, sprints: [] })),
    listInvites: vi.fn(async () => ({ ok: true, invites: opts.invites ?? [] })),
    tasks: vi.fn(async () => ({ ok: true, list: { tasks: [], total: 0, limit: 50, offset: 0 } })),
    changeRole: vi.fn(async () => ({ ok: true, member: state.members[1] })),
    removeMember: vi.fn(async () => ({ ok: true })),
    leave: vi.fn(async () => ({ ok: true })),
    invite: vi.fn(async () => ({ ok: false, reason: "error", error: "not stubbed" })),
    renameTeam: vi.fn(async (_id: string, name: string) => ({ ok: true, team: { id: TEAM.id, name, slug: TEAM.slug } })),
    deleteTeam: vi.fn(async () => ({ ok: true })),
    create: vi.fn(async () => ({ ok: false, error: "plan_required" })),
    revokeInvite: vi.fn(async () => ({ ok: true })),
    ...opts.team,
  };
  const w = window as unknown as Record<string, unknown>;
  w.team = team;
  w.cloud = {
    status: async () => cloudStatus(opts.plan === undefined ? GRANTED : opts.plan),
    onStatusChanged: () => () => {},
    plansUrl: async () => "https://example.test/planos",
  };
  return team;
}

beforeEach(() => {
  setLocale("pt-BR");
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => cleanup());

const part = (name: string) => document.querySelector(`[data-part="${name}"]`) as HTMLElement | null;
/** Waits for a part to exist (a bare `waitFor(() => part(..))` resolves on null). */
const found = (name: string) =>
  waitFor(() => {
    const el = part(name);
    if (!el) throw new Error(`no [data-part="${name}"] yet`);
    return el;
  });

describe("TeamPage overview: header, seats, members", () => {
  it("shows N de M assentos, the slug and the seats stat", async () => {
    install({});
    render(<TeamPage boards={[]} />);
    await waitFor(() => expect(part("seats-pill")?.textContent).toBe("3 de 5 assentos"));
    expect(part("seats-pill")?.getAttribute("data-seats")).toBe("open");
    expect(part("team-title")?.textContent).toBe("Nebula Labs");
    expect(screen.getByText("nebula-labs")).toBeTruthy();
    expect(within(part("stat-seats")!).getByText("3 / 5")).toBeTruthy();
    expect(part("seats-full-banner")).toBeNull();
  });

  it("full: red pill and the banner, and the invite opens blocked with the reason", async () => {
    const team = install({ seats: { used: 5, total: 5, expiresAt: null } });
    render(<TeamPage boards={[]} />);
    await waitFor(() => expect(part("seats-pill")?.getAttribute("data-seats")).toBe("full"));
    expect(part("seats-pill")?.textContent).toBe("5 de 5 assentos");
    expect(part("seats-full-banner")?.textContent).toMatch(/Todos os 5 assentos estão ocupados/);
    fireEvent.click(part("team-open-invite")!);
    expect(part("invite-full")?.textContent).toMatch(/Sem assento livre\. O plano deste time tem 5 assentos/);
    expect((screen.getByRole("button", { name: "Enviar por e-mail" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copiar link" }) as HTMLButtonElement).disabled).toBe(true);
    expect(team.invite).not.toHaveBeenCalled();
  });

  it("a team with no plan shows no pill and says there is no seat limit", async () => {
    install({ seats: null });
    render(<TeamPage boards={[]} />);
    await screen.findByText("Nebula Labs");
    // The seats come with the team detail: until it answers the figure is a skeleton, not "no limit".
    expect(screen.queryByText("sem limite de assentos")).toBeNull();
    expect(await screen.findByText("sem limite de assentos")).toBeTruthy();
    expect(part("seats-pill")).toBeNull();
  });

  it("the sole owner cannot be demoted or leave, and the page says why", async () => {
    const team = install({ members: [MEMBERS[0], MEMBERS[2]] });
    render(<TeamPage boards={[]} />);
    const leave = (await screen.findByRole("button", { name: "Sair" })) as HTMLButtonElement;
    expect(leave.disabled).toBe(true);
    expect(leave.title).toMatch(/único owner\. Promova outra pessoa a owner antes de sair/);
    const select = screen.getByLabelText("Papel de Maya Chen") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.title).toMatch(/Único owner — não dá para rebaixar/);
    expect(part("last-owner-hint")?.textContent).toMatch(/Único owner: o select e “Sair” ficam bloqueados/);
    fireEvent.click(leave);
    expect(team.leave).not.toHaveBeenCalled();
  });

  it("changes a role through the existing IPC and reloads the members", async () => {
    const team = install({});
    render(<TeamPage boards={[]} />);
    const select = (await screen.findByLabelText("Papel de Sam Okonkwo")) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: "admin" } });
    await waitFor(() => expect(team.changeRole).toHaveBeenCalledWith(TEAM.id, SAM, "admin"));
    await waitFor(() => expect(screen.getByText("Papel atualizado.")).toBeTruthy());
  });

  it("removes another member only after the confirmation", async () => {
    const team = install({});
    const confirm = vi.spyOn(window, "confirm");
    render(<TeamPage boards={[]} />);
    await screen.findByLabelText("Papel de Sam Okonkwo");
    const row = document.querySelector(`[data-member="${SAM}"]`) as HTMLElement;
    confirm.mockReturnValueOnce(false);
    fireEvent.click(within(row).getByRole("button", { name: "Remover" }));
    expect(team.removeMember).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(within(row).getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(team.removeMember).toHaveBeenCalledWith(TEAM.id, SAM));
    confirm.mockRestore();
  });

  it("leaving goes back to the team list (the create screen when it was the last team)", async () => {
    const state: { teams: (typeof TEAM)[] } = { teams: [TEAM] };
    const team = install({
      team: {
        overview: vi.fn(async () => ({ ok: true, view: { accountId: ME, displayName: "Maya", teams: state.teams, profiles: [], identitySubjects: [] } })),
        leave: vi.fn(async () => {
          state.teams = [];
          return { ok: true };
        }),
      },
      // Two owners, so the person may leave.
      members: [MEMBERS[0], { ...MEMBERS[1], role: "owner" as const }],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TeamPage boards={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sair" }));
    await waitFor(() => expect(team.leave).toHaveBeenCalledWith(TEAM.id));
    await found("team-create");
    expect(screen.getByText("Você saiu do time.")).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("pending invites show how many days are left and can be revoked", async () => {
    const team = install({
      invites: [{ id: "i1", teamId: TEAM.id, target: "kai@example.com", role: "member", expiresAt: new Date(Date.now() + 4.5 * 24 * 3600 * 1000).toISOString() }],
    });
    render(<TeamPage boards={[]} />);
    const row = await waitFor(() => {
      const r = part("pending-row");
      expect(r).toBeTruthy();
      return r!;
    });
    expect(row.textContent).toMatch(/kai@example\.com/);
    expect(row.textContent).toMatch(/convite pendente · expira em 5 dias/);
    fireEvent.click(within(row).getByRole("button", { name: "Revogar" }));
    await waitFor(() => expect(team.revokeInvite).toHaveBeenCalledWith(TEAM.id, "i1"));
  });
});

describe("Invite modal", () => {
  async function openInvite(team: Partial<TeamMock>) {
    const mock = install({ team });
    render(<TeamPage boards={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /Convidar pessoa/ }));
    return mock;
  }

  it("copy link: creates a link invite, shows the URL once with the nominal 7-day notice", async () => {
    const clip = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clip }, configurable: true });
    const invite = vi.fn(async () => ({
      ok: true,
      invite: { id: "i1", teamId: TEAM.id, target: "kai@example.com", role: "member", expiresAt: null, delivery: "link", inviteUrl: LINK },
    }));
    const team = await openInvite({ invite });
    fireEvent.change(screen.getByPlaceholderText("nome@empresa.com ou login"), { target: { value: " kai@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Copiar link" }));
    await waitFor(() => expect(part("invite-url")?.textContent).toBe(LINK));
    expect(team.invite).toHaveBeenCalledWith(TEAM.id, { target: "kai@example.com", role: "member", delivery: "link" });
    expect(part("invite-link-warn")?.textContent).toMatch(/Só esta pessoa consegue usar este link\. Vale 7 dias\. Não reaparece/);
    const copy = part("invite-copy")!;
    expect(copy.textContent).toBe("Copiar");
    fireEvent.click(copy);
    await waitFor(() => expect(copy.textContent).toBe("Copiado"));
    expect(clip).toHaveBeenCalledWith(LINK);
    // The pending row appeared on the page behind the modal; closing drops the URL for good.
    fireEvent.click(part("invite-done")!);
    expect(part("invite-modal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Convidar pessoa/ }));
    expect(part("invite-url")).toBeNull();
  });

  it("send by email: invites with email delivery, closes and notes who got it", async () => {
    const invite = vi.fn(async () => ({
      ok: true,
      invite: { id: "i2", teamId: TEAM.id, target: "kai@example.com", role: "admin", expiresAt: null, delivery: "email", inviteUrl: null },
    }));
    const team = await openInvite({ invite });
    fireEvent.change(screen.getByPlaceholderText("nome@empresa.com ou login"), { target: { value: "kai@example.com" } });
    fireEvent.change(screen.getByLabelText("Papel"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar por e-mail" }));
    await waitFor(() => expect(team.invite).toHaveBeenCalledWith(TEAM.id, { target: "kai@example.com", role: "admin", delivery: "email" }));
    await waitFor(() => expect(part("invite-modal")).toBeNull());
    expect(screen.getByText("convite enviado para kai@example.com")).toBeTruthy();
  });

  it("email unavailable (503): shows the server message and keeps Copiar link available", async () => {
    const invite = vi.fn(async () => ({ ok: false, reason: "email-unavailable", error: "o serviço de e-mail está indisponível" }));
    await openInvite({ invite });
    fireEvent.change(screen.getByPlaceholderText("nome@empresa.com ou login"), { target: { value: "kai@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar por e-mail" }));
    await waitFor(() => expect(part("invite-error")?.textContent).toMatch(/o serviço de e-mail está indisponível/));
    expect(part("invite-error")?.textContent).toMatch(/Use “Copiar link”/);
    expect((screen.getByRole("button", { name: "Copiar link" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a seats refusal from the server turns the modal into the blocked state", async () => {
    const invite = vi.fn(async () => ({ ok: false, reason: "seats-exceeded", error: "seats" }));
    await openInvite({ invite });
    fireEvent.change(screen.getByPlaceholderText("nome@empresa.com ou login"), { target: { value: "kai@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Copiar link" }));
    await waitFor(() => expect(part("invite-full")).toBeTruthy());
  });

  it("both actions stay off until there is a target", async () => {
    await openInvite({});
    expect((screen.getByRole("button", { name: "Enviar por e-mail" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copiar link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a plain member does not get the invite or settings buttons", async () => {
    install({ members: [{ ...MEMBERS[0], role: "member" }] });
    render(<TeamPage boards={[]} />);
    await screen.findByText("Nebula Labs");
    expect(part("team-open-invite")).toBeNull();
    expect(part("team-open-settings")).toBeNull();
  });
});

describe("Team settings", () => {
  async function openSettings(team: Partial<TeamMock> = {}, members: TeamMemberInfo[] = MEMBERS) {
    const mock = install({ team, members });
    render(<TeamPage boards={[]} />);
    await screen.findByText("Nebula Labs");
    fireEvent.click(await found("team-open-settings"));
    await screen.findByText("Configurações do time");
    return mock;
  }

  it("renames and keeps the slug", async () => {
    const team = await openSettings();
    const input = part("rename-input") as HTMLInputElement;
    const save = part("rename-save") as HTMLButtonElement;
    // Saving the unchanged name is a no-op, not a request.
    fireEvent.click(save);
    expect(team.renameTeam).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Nebula" } });
    fireEvent.click(save);
    await waitFor(() => expect(team.renameTeam).toHaveBeenCalledWith(TEAM.id, "Nebula"));
    await waitFor(() => expect(part("team-title")?.textContent).toBe("Nebula"));
    expect(part("settings-rename")?.textContent).toMatch(/O slug nebula-labs não muda ao renomear\./);
  });

  it("delete stays locked until the exact slug, then deletes and goes back to the list", async () => {
    const state: { teams: (typeof TEAM)[] } = { teams: [TEAM, { ...TEAM, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Outro", slug: "outro" }] };
    const team = await (async () => {
      const mock = install({
        team: {
          overview: vi.fn(async () => ({ ok: true, view: { accountId: ME, displayName: "Maya", teams: state.teams, profiles: [], identitySubjects: [] } })),
          deleteTeam: vi.fn(async () => {
            state.teams = state.teams.slice(1);
            return { ok: true };
          }),
        },
      });
      render(<TeamPage boards={[]} />);
      await waitFor(() => expect(part("team-title")?.textContent).toBe("Nebula Labs"));
      fireEvent.click(await found("team-open-settings"));
      await screen.findByText("Configurações do time");
      return mock;
    })();
    const del = part("delete-team") as HTMLButtonElement;
    const slug = part("delete-slug") as HTMLInputElement;
    expect(del.disabled).toBe(true);
    fireEvent.change(slug, { target: { value: "nebula" } });
    expect(del.disabled).toBe(true);
    fireEvent.change(slug, { target: { value: "nebula-labs" } });
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    await waitFor(() => expect(team.deleteTeam).toHaveBeenCalledWith(TEAM.id, "nebula-labs"));
    await waitFor(() => expect(part("team-title")?.textContent).toBe("Outro"));
    expect(part("team-settings")).toBeNull();
    expect(screen.getByText("Time Nebula Labs apagado.")).toBeTruthy();
  });

  it("an admin can rename but the delete is explained as owner-only", async () => {
    const admin = MEMBERS.map((x) => (x.accountId === ME ? { ...x, role: "admin" as const } : x.accountId === RIO ? { ...x, role: "owner" as const } : x));
    await openSettings({}, admin);
    expect((part("rename-input") as HTMLInputElement).disabled).toBe(false);
    expect(part("delete-team")).toBeNull();
    expect(screen.getByText("Só o owner pode apagar o time.")).toBeTruthy();
  });

  it("a delete refused by the server shows the error and keeps the page", async () => {
    await openSettings({ deleteTeam: vi.fn(async () => ({ ok: false, error: "só o owner apaga" })) });
    fireEvent.change(part("delete-slug")!, { target: { value: "nebula-labs" } });
    fireEvent.click(part("delete-team")!);
    await screen.findByText("só o owner apaga");
    expect(part("team-settings")).toBeTruthy();
  });
});

describe("Create team without a team plan", () => {
  it("states the beta, offers no upsell, locks the form", async () => {
    install({ plan: NO_TEAM_PLAN, teams: [] });
    render(<TeamPage boards={[]} />);
    const notice = await waitFor(() => {
      const n = part("beta-notice");
      expect(n).toBeTruthy();
      return n!;
    });
    expect(notice.textContent).toMatch(/Times são liberados pelo Stellar durante o beta/);
    expect(screen.queryByRole("link", { name: /upgrade/i })).toBeNull();
    expect(screen.queryByText(/Faça upgrade/)).toBeNull();
    expect((part("create-name") as HTMLInputElement).disabled).toBe(true);
    expect((part("create-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/no beta o assento vem do operador/)).toBeTruthy();
  });

  it("with the right granted, a failed create shows the server error", async () => {
    const team = install({ teams: [], team: { create: vi.fn(async () => ({ ok: false, error: "este plano não inclui times" })) } });
    render(<TeamPage boards={[]} />);
    const name = (await waitFor(() => {
      const n = part("create-name");
      expect(n).toBeTruthy();
      return n;
    })) as HTMLInputElement;
    expect(part("beta-notice")).toBeNull();
    fireEvent.change(name, { target: { value: "Nebula Labs" } });
    fireEvent.click(part("create-submit")!);
    await waitFor(() => expect(team.create).toHaveBeenCalledWith({ name: "Nebula Labs" }));
    await waitFor(() => expect(part("create-error")?.textContent).toBe("este plano não inclui times"));
  });
});

describe("InviteDialog", () => {
  const PREVIEW = { teamName: "Nebula Labs", invitedByName: "Maya Chen", role: "member" as const, targetMasked: "k***@example.com", expiresAt: "2026-10-18T00:00:00Z" };
  const KAI = [{ kind: "email", subject: "kai@example.com", login: null }];
  const JORDAN = [{ kind: "email", subject: "jordan@example.com", login: null }];

  function setup(opts: { status: CloudStatusInfo; preview?: unknown; accept?: Mock; detail?: Mock; login?: Mock }) {
    const w = window as unknown as Record<string, unknown>;
    const team = {
      previewInvite: vi.fn(async () => opts.preview ?? { ok: true, preview: PREVIEW }),
      acceptInvite:
        opts.accept ??
        vi.fn(async () => ({
          ok: true,
          value: { team: TEAM, membership: m(ME, "member", "Kai", "kai@example.com"), profile: { id: "p", name: "Nebula Labs", kind: "team" }, profileCreated: true },
        })),
      detail: opts.detail ?? vi.fn(async () => ({ ok: true, detail: { team: TEAM, members: [], seats: { used: 4, total: 5, expiresAt: null } } })),
    };
    w.team = team;
    w.cloud = {
      status: async () => opts.status,
      onStatusChanged: () => () => {},
      login: opts.login ?? vi.fn(async () => ({ state: "pending", apiBaseUrl: "x", provider: "email" })),
      cancel: vi.fn(async () => opts.status),
      logout: vi.fn(async () => ({ state: "logged-out", apiBaseUrl: "x", lastError: null })),
    };
    return team;
  }
  const out: CloudStatusInfo = { state: "logged-out", apiBaseUrl: "x", lastError: null };

  it("signed out: shows who invited, the team and the masked target from the public preview", async () => {
    const team = setup({ status: out });
    render(<InviteDialog token="ex_tok_7f3a9c2e1b4d5e6f" onClose={() => {}} />);
    await screen.findByText("Você foi convidado");
    expect(team.previewInvite).toHaveBeenCalledWith("ex_tok_7f3a9c2e1b4d5e6f");
    expect(part("signin-lead")?.textContent).toBe("Maya Chen convidou você para o time Nebula Labs.");
    expect(part("signin-info")?.textContent).toMatch(/k\*\*\*@example\.com/);
    expect(screen.getByText(/Não precisa criar conta/)).toBeTruthy();
  });

  it("a pasted whole link goes to the preview as given (main extracts the fragment)", async () => {
    const team = setup({ status: out });
    render(<InviteDialog token={LINK} onClose={() => {}} />);
    await screen.findByText("Você foi convidado");
    expect(team.previewInvite).toHaveBeenCalledWith(LINK);
  });

  it("signing in with the invited email starts the email login and shows the wait", async () => {
    const login = vi.fn(async () => ({ state: "pending", apiBaseUrl: "x", provider: "email" }));
    setup({ status: out, login });
    render(<InviteDialog token="ex_tok_7f3a9c2e1b4d5e6f" onClose={() => {}} />);
    const submit = (await screen.findByRole("button", { name: "Entrar e ver o convite" })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(part("signin-email")!, { target: { value: " kai@example.com " } });
    fireEvent.click(submit);
    await waitFor(() => expect(login).toHaveBeenCalledWith("email", "kai@example.com"));
  });

  it("signed in as the invited identity: accepts, then the joined screen shows the role and seats", async () => {
    const onAccepted = vi.fn();
    const onOpenTeam = vi.fn();
    const onClose = vi.fn();
    const team = setup({ status: cloudStatus(null, KAI) });
    render(<InviteDialog token="ex_tok_7f3a9c2e1b4d5e6f" onClose={onClose} onAccepted={onAccepted} onOpenTeam={onOpenTeam} />);
    await screen.findByText("Aceitar convite");
    expect(part("accept-identity")?.textContent).toMatch(/kai@example\.com/);
    expect(screen.getByText("Identidade confere com o convite. Pode entrar no time.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aceitar e entrar" }));
    await screen.findByText("Você entrou no time");
    expect(team.acceptInvite).toHaveBeenCalledWith("ex_tok_7f3a9c2e1b4d5e6f");
    expect(onAccepted).toHaveBeenCalledWith({ id: TEAM.id, name: TEAM.name });
    expect(part("joined-lead")?.textContent).toBe("Papel: membro. Assentos agora: 4 de 5.");
    fireEvent.click(screen.getByRole("button", { name: "Abrir board do time" }));
    expect(onOpenTeam).toHaveBeenCalledWith(TEAM.id);
    expect(onClose).toHaveBeenCalled();
  });

  it("signed in as another account: the wrong-identity state names both, and switching signs out", async () => {
    const team = setup({ status: cloudStatus(null, JORDAN) });
    render(<InviteDialog token="ex_tok_7f3a9c2e1b4d5e6f" onClose={() => {}} />);
    await screen.findByText("Não dá para aceitar");
    expect(part("wrong-identity")?.textContent).toMatch(/Você está como jordan@example\.com\. O convite é para k\*\*\*@example\.com/);
    expect(team.acceptInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Trocar de conta" }));
    await screen.findByText("Você foi convidado");
  });

  it("the server's own identity refusal lands on the same wrong-identity state", async () => {
    const accept = vi.fn(async () => ({ ok: false, reason: "identity-mismatch", error: "mismatch" }));
    setup({ status: cloudStatus(null, KAI), accept });
    render(<InviteDialog token="ex_tok_7f3a9c2e1b4d5e6f" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Aceitar e entrar" }));
    await screen.findByText("Não dá para aceitar");
  });

  it("another refusal (seats) stays on the accept screen with its reason", async () => {
    const accept = vi.fn(async () => ({ ok: false, reason: "seats-exceeded", error: "seats" }));
    setup({ status: cloudStatus(null, KAI), accept });
    render(<InviteDialog token="ex_tok_7f3a9c2e1b4d5e6f" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Aceitar e entrar" }));
    await screen.findByText("o time já usa todos os assentos do plano");
    expect(screen.getByText("Aceitar convite")).toBeTruthy();
  });

  it("an unknown, expired or used invite is one unavailable screen", async () => {
    setup({ status: out, preview: { ok: false, reason: "not-found", error: "x" } });
    const onClose = vi.fn();
    render(<InviteDialog token="ex_tok_7f3a9c2e1b4d5e6f" onClose={onClose} />);
    await screen.findByText("Convite indisponível");
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalled();
  });
});

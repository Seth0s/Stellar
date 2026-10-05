import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setLocale } from "../../src/shared/i18n";
import type { CloudStatusInfo } from "../../src/preload/index";
import { PlanNotice, PlanSeatsNotice } from "@renderer/PlanGate";
import { WorkHomePage } from "@renderer/WorkHomePage";
import { TeamPage } from "@renderer/TeamPage";

/**
 * The visible side of the plan gate: the upgrade call-to-action, the read-only
 * expiry band, the seats refusal, and the Free Work home — which explains what
 * Pro unlocks and never offers a sync that would be refused.
 */

const PLANS_URL = "https://example.test/planos";
const EXPIRED = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  setLocale("pt-BR");
});

describe("PlanNotice", () => {
  it("upgrade: names the plan, says what it unlocks and links to the plans page", () => {
    render(<PlanNotice access={{ kind: "upgrade", feature: "sync", requiredPlan: "pro" }} plansUrl={PLANS_URL} />);
    expect(screen.getByText(/Faça upgrade para o Pro/)).toBeTruthy();
    expect(screen.getByText(/parte do plano Pro/)).toBeTruthy();
    const cta = screen.getByRole("link", { name: /Fazer upgrade/ }) as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe(PLANS_URL);
  });

  it("upgrade for team names the Team plan", () => {
    render(<PlanNotice access={{ kind: "upgrade", feature: "team", requiredPlan: "team" }} plansUrl={PLANS_URL} />);
    expect(screen.getByText(/Faça upgrade para o Team/)).toBeTruthy();
    expect(screen.getByText(/parte do plano Team/)).toBeTruthy();
  });

  it("expired: states the expiry and the read-only window", () => {
    render(
      <PlanNotice
        access={{ kind: "expired", feature: "sync", state: "grace", expiresAt: EXPIRED, readOnlyUntil: "2026-01-31T00:00:00.000Z" }}
        plansUrl={PLANS_URL}
      />,
    );
    expect(screen.getByText("Seu plano venceu")).toBeTruthy();
    const band = screen.getByText(/só leitura até/);
    expect(band).toBeTruthy();
    expect(band.getAttribute("data-kind")).toBeNull();
    expect(document.querySelector('[data-kind="expired"]')).toBeTruthy();
  });
});

describe("PlanSeatsNotice", () => {
  it("names how many seats the team uses", () => {
    render(<PlanSeatsNotice seats={3} />);
    expect(screen.getByText("O time usa todos os 3 assentos.")).toBeTruthy();
  });
});

describe("WorkHomePage on Free", () => {
  function stubCloud(plan: CloudStatusInfo) {
    (window as unknown as { cloud: Record<string, unknown> }).cloud = {
      status: async () => plan,
      onStatusChanged: () => () => {},
      plansUrl: async () => PLANS_URL,
    };
    (window as unknown as { workhome: Record<string, unknown> }).workhome = {
      status: async () => ({
        loggedIn: true,
        profileId: "p1",
        enabledTools: ["claude"],
        toolRoots: {},
        workFolders: [],
        lastRevision: null,
        lastSyncAt: null,
        lastError: null,
      }),
      toolSummary: async () => ({ ok: true, tools: {} }),
    };
  }

  const freeStatus: CloudStatusInfo = {
    state: "logged-in",
    apiBaseUrl: "https://api.example.test",
    account: { displayName: "Lucas", identities: [] },
    plan: {
      accountPlan: "free",
      accountExpiresAt: null,
      rights: {
        sync: { granted: false, state: "none", plan: "pro", source: null, teamId: null, expiresAt: null },
        team: { granted: false, state: "none", plan: "team", source: null, teamId: null, expiresAt: null },
      },
    },
    expiresAtMs: Date.now() + 60000,
  };

  it("shows what Pro unlocks + upgrade, and the sync button is disabled", async () => {
    stubCloud(freeStatus);
    render(<WorkHomePage />);
    expect(await screen.findByText(/Faça upgrade para o Pro/)).toBeTruthy();
    const sync = (await screen.findByRole("button", { name: /Sincronizar agora/ })) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
  });
});

describe("TeamPage with an UNKNOWN plan (server sent no plan block)", () => {
  const ACC = "33333333-3333-4333-8333-333333333333";
  const TEAM = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Idy Platform", slug: "idy" };

  beforeEach(() => {
    (window as unknown as { cloud: Record<string, unknown> }).cloud = {
      status: async () => ({
        state: "logged-in",
        apiBaseUrl: "https://api.example.test",
        account: { displayName: "Ana", identities: [] },
        plan: null, // older backend: no plan block -> the plan is unknown
        expiresAtMs: Date.now() + 60000,
      }),
      onStatusChanged: () => () => {},
      plansUrl: async () => PLANS_URL,
    };
    (window as unknown as { team: Record<string, unknown> }).team = {
      overview: async () => ({
        ok: true,
        view: { accountId: ACC, displayName: "Ana", teams: [TEAM], profiles: [], identitySubjects: [] },
      }),
      detail: async () => ({
        ok: true,
        detail: { team: TEAM, members: [{ accountId: ACC, role: "owner", joinedAt: null, displayName: "Ana", avatarInitials: "AN", email: null }] },
      }),
      sprints: async () => ({ ok: true, sprints: [] }),
      listInvites: async () => ({ ok: true, invites: [] }),
      tasks: async () => ({ ok: true, list: { tasks: [], total: 0, limit: 50, offset: 0 } }),
    };
  });

  it("does not lock: the member sees the team and the board", async () => {
    render(<TeamPage boards={[]} />);
    await screen.findByText("Idy Platform");
    expect(screen.queryByText(/Faça upgrade para o Team/)).toBeNull();
    const boardTab = document.querySelector('[data-team-sub="board"]') as HTMLButtonElement | null;
    expect(boardTab).toBeTruthy();
    fireEvent.click(boardTab!);
    await waitFor(() => expect(document.querySelector('[data-column="sem_dono"]')).toBeTruthy());
  });
});

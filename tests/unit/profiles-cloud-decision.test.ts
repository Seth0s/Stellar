/**
 * profiles-cloud-decision.ts — the pure decision of the local-to-server link.
 * No fs, no network: just the "use / create / cannot" matrix.
 */
import { describe, expect, it } from "vitest";
import {
  decideCloudLink,
  normalizeCloudName,
  parseCloudProfileList,
  type CloudProfileRef,
  type LocalCloudLinkInput,
} from "../../src/main/profiles-cloud-decision";

const SERVER_PERSONAL = "11111111-1111-4111-8111-111111111111";
const SERVER_OTHER = "22222222-2222-4222-8222-222222222222";
const SERVER_TEAM = "33333333-3333-4333-8333-333333333333";
const LOCAL_TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function serverProfile(over: Partial<CloudProfileRef> = {}): CloudProfileRef {
  return { id: SERVER_PERSONAL, kind: "personal", name: "Pessoal", teamId: null, ...over };
}

function local(over: Partial<LocalCloudLinkInput> = {}): LocalCloudLinkInput {
  return { kind: "personal", name: "Pessoal", teamId: null, cloudProfileId: null, ...over };
}

describe("normalizeCloudName", () => {
  it("ignore caixa e espaço", () => {
    expect(normalizeCloudName("  Pessoal ")).toBe("pessoal");
  });
});

describe("parseCloudProfileList", () => {
  it("lê {profiles:[…]} e descarta id não-opaco", () => {
    const list = parseCloudProfileList({
      profiles: [
        { id: SERVER_PERSONAL, kind: "personal", name: "Pessoal", team_id: null },
        { id: "não-é-uuid", kind: "personal", name: "Lixo" },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(SERVER_PERSONAL);
  });

  it("aceita array cru e lê team_id", () => {
    const list = parseCloudProfileList([{ id: SERVER_TEAM, kind: "team", name: "Acme", team_id: LOCAL_TEAM }]);
    expect(list[0]).toEqual({ id: SERVER_TEAM, kind: "team", name: "Acme", teamId: LOCAL_TEAM });
  });
});

describe("decideCloudLink", () => {
  it("perfil pessoal sem vínculo casa por kind + nome normalizado", () => {
    const plan = decideCloudLink({
      local: local({ name: " pessoal " }),
      cloudProfiles: [serverProfile({ name: "Pessoal" })],
    });
    expect(plan).toEqual({ action: "use", cloudProfileId: SERVER_PERSONAL });
  });

  it("perfil pessoal sem par MANDA criar", () => {
    const plan = decideCloudLink({ local: local({ name: "Empresa" }), cloudProfiles: [] });
    expect(plan).toEqual({ action: "create", kind: "personal", name: "Empresa" });
  });

  it("não casa com perfil pessoal de nome diferente", () => {
    const plan = decideCloudLink({
      local: local({ name: "Empresa" }),
      cloudProfiles: [serverProfile({ name: "Pessoal" }), serverProfile({ id: SERVER_OTHER, name: "Outro" })],
    });
    expect(plan).toEqual({ action: "create", kind: "personal", name: "Empresa" });
  });

  it("perfil de time casa pelo team_id", () => {
    const plan = decideCloudLink({
      local: local({ kind: "team", name: "Acme", teamId: LOCAL_TEAM }),
      cloudProfiles: [serverProfile({ id: SERVER_TEAM, kind: "team", name: "Acme", teamId: LOCAL_TEAM })],
    });
    expect(plan).toEqual({ action: "use", cloudProfileId: SERVER_TEAM });
  });

  it("perfil de time sem par no servidor NÃO cria (o POST recusa team)", () => {
    const plan = decideCloudLink({
      local: local({ kind: "team", name: "Acme", teamId: LOCAL_TEAM }),
      cloudProfiles: [serverProfile()],
    });
    expect(plan).toEqual({ action: "none", reason: "team-not-on-server" });
  });

  it("vínculo já declarado MANDA, mesmo com um perfil de mesmo nome na conta", () => {
    const plan = decideCloudLink({
      local: local({ cloudProfileId: SERVER_OTHER }),
      cloudProfiles: [serverProfile()],
    });
    expect(plan).toEqual({ action: "use", cloudProfileId: SERVER_OTHER });
  });

  it("nome vazio na criação cai em 'Pessoal'", () => {
    const plan = decideCloudLink({ local: local({ name: "   " }), cloudProfiles: [] });
    expect(plan).toEqual({ action: "create", kind: "personal", name: "Pessoal" });
  });
});

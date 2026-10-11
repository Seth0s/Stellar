import { describe, expect, it } from "vitest";
import {
  canManageIntegrations,
  findByKind,
  githubDetail,
  isConnected,
  nextNotifyPatch,
  reactionEnabled,
  resolveGithubConfig,
  resolveSlackConfig,
  slackDetail,
  webhookActiveCount,
} from "../../src/renderer/src/integration-decisions";
import {
  canManageIntegrations as canManageMain,
  parseIntegration,
  parseIntegrationList,
  parseIntegrationOAuthDeepLink,
  slackStatusLine,
} from "../../src/main/integration-decision";

describe("integration-decisions (renderer)", () => {
  it("gates connect/edit by role", () => {
    expect(canManageIntegrations("owner")).toBe(true);
    expect(canManageIntegrations("admin")).toBe(true);
    expect(canManageIntegrations("member")).toBe(false);
    expect(canManageIntegrations(null)).toBe(false);
  });

  it("builds status lines and finds by kind", () => {
    const slack = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "slack",
      status: "connected",
      config: { workspace_name: "idy" },
      connectedBy: "a",
    };
    expect(isConnected(slack)).toBe(true);
    expect(slackDetail(slack, "Ana")).toBe("conectado · workspace idy · por Ana");
    expect(githubDetail({ ...slack, kind: "github", config: { repo: "Seth0s/demo" } })).toBe("conectado · org Seth0s");
    expect(findByKind([slack], "slack")?.kind).toBe("slack");
    expect(webhookActiveCount([{ status: "active" }, { status: "disabled" }])).toBe(1);
  });

  it("applies B9c defaults when config keys are absent", () => {
    expect(resolveSlackConfig({})).toEqual({
      slash_command: true,
      reaction: "ticket",
      mention_to_task: false,
      notify_channel: true,
      notify_review: true,
      notify_gate_failed: true,
      notify_done: false,
      dm_assignee: true,
      channel_id: "",
      channel_name: "",
    });
    expect(resolveGithubConfig({ repo: "Seth0s/demo", label: "stellar" })).toEqual({
      repo: "Seth0s/demo",
      label: "stellar",
      link_pr: true,
      close_on_done: false,
    });
    expect(resolveSlackConfig({ slash_command: false, reaction: "", notify_channel: false, notify_done: true })).toMatchObject({
      slash_command: false,
      reaction: "",
      notify_channel: false,
      notify_review: true,
      notify_done: true,
      mention_to_task: false,
    });
    expect(reactionEnabled(resolveSlackConfig({ reaction: "ticket" }))).toBe(true);
    expect(reactionEnabled(resolveSlackConfig({ reaction: "" }))).toBe(false);
  });

  it("patches notify children with exact B9c keys and re-enables master on child ON", () => {
    const on = resolveSlackConfig({ notify_channel: true });
    expect(nextNotifyPatch({ current: on, key: "notify_review", value: false })).toEqual({ notify_review: false });
    expect(nextNotifyPatch({ current: on, key: "notify_gate_failed", value: true })).toEqual({ notify_gate_failed: true });
    expect(nextNotifyPatch({ current: on, key: "notify_done", value: true })).toEqual({ notify_done: true });

    const off = resolveSlackConfig({ notify_channel: false, notify_review: true, notify_done: false });
    expect(nextNotifyPatch({ current: off, key: "notify_review", value: true })).toEqual({
      notify_review: true,
      notify_channel: true,
    });
    expect(nextNotifyPatch({ current: off, key: "notify_done", value: true })).toEqual({
      notify_done: true,
      notify_channel: true,
    });
    expect(nextNotifyPatch({ current: off, key: "notify_gate_failed", value: false })).toEqual({
      notify_gate_failed: false,
    });
  });
});

describe("integration-decision (main)", () => {
  it("parses integration list and oauth deep link", () => {
    expect(canManageMain("admin")).toBe(true);
    const list = parseIntegrationList({
      integrations: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "slack",
          status: "connected",
          config: { workspace_name: "idy" },
          connected_by: "22222222-2222-4222-8222-222222222222",
          created_at: "2026-10-05T00:00:00Z",
          updated_at: "2026-10-05T00:00:00Z",
        },
      ],
    });
    expect(list).toHaveLength(1);
    expect(parseIntegration({ kind: "nope" })).toBeNull();
    expect(slackStatusLine({ integ: list[0]!, connectedByName: "Ana" }).detail).toContain("idy");
    expect(parseIntegrationOAuthDeepLink("stellar://integrations/oauth?status=connected")).toEqual({
      kind: "integration-oauth",
      status: "connected",
    });
    expect(parseIntegrationOAuthDeepLink("stellar://invite?token=x")).toBeNull();
  });
});

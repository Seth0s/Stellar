import { describe, expect, it } from "vitest";
import { createHealthAlertTracker } from "../../src/main/health-alert-tracker";
import type { HealthAlert } from "../../src/main/card-health";

/**
 * "WARN ONCE" — the key is recipient + scope + level. A context level belongs to
 * one card; a quota level belongs to the provider's plan, so a second card
 * reaching the same conclusion adds nothing. It resets only on a trustworthy
 * cool reading, never on silence.
 */

const ctx: HealthAlert = { key: "context", message: "context 76%" };
const q80: HealthAlert = { key: "quota:80", message: "quota 81%" };

describe("health alert tracker", () => {
  it("the same card + level warns once, however many passes see it", () => {
    const t = createHealthAlertTracker();
    const pass = () => t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] });
    expect(pass()).toHaveLength(1);
    expect(pass()).toHaveLength(0);
    expect(pass()).toHaveLength(0);
  });

  it("a silent pass (no reading) does not re-arm: the same conclusion is not news again", () => {
    const t = createHealthAlertTracker();
    t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] });
    t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [], cool: [] });
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] })).toHaveLength(0);
  });

  it("a trustworthy cool reading re-arms it", () => {
    const t = createHealthAlertTracker();
    t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] });
    t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [], cool: ["context"] });
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] })).toHaveLength(1);
  });

  it("context is per card: another card at the same level warns for itself", () => {
    const t = createHealthAlertTracker();
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] })).toHaveLength(1);
    expect(t.track({ recipient: "orch", cardId: "c2", provider: "claude", alerts: [ctx], cool: [] })).toHaveLength(1);
  });

  it("quota is per provider plan: a second card of the same provider says nothing new", () => {
    const t = createHealthAlertTracker();
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "commandcode", alerts: [q80], cool: [] })).toHaveLength(1);
    expect(t.track({ recipient: "orch", cardId: "c2", provider: "commandcode", alerts: [q80], cool: [] })).toHaveLength(0);
    // A different provider's plan is a different conclusion.
    expect(t.track({ recipient: "orch", cardId: "c3", provider: "other", alerts: [q80], cool: [] })).toHaveLength(1);
  });

  it("a provider quota re-arms only when EVERY card that voted is cool", () => {
    const t = createHealthAlertTracker();
    t.track({ recipient: "orch", cardId: "c1", provider: "commandcode", alerts: [q80], cool: [] });
    t.track({ recipient: "orch", cardId: "c2", provider: "commandcode", alerts: [q80], cool: [] });
    t.track({ recipient: "orch", cardId: "c1", provider: "commandcode", alerts: [], cool: ["quota:80"] });
    // c2 still reads the plan as hot: not re-armed.
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "commandcode", alerts: [q80], cool: [] })).toHaveLength(0);
    t.track({ recipient: "orch", cardId: "c1", provider: "commandcode", alerts: [], cool: ["quota:80"] });
    t.track({ recipient: "orch", cardId: "c2", provider: "commandcode", alerts: [], cool: ["quota:80"] });
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "commandcode", alerts: [q80], cool: [] })).toHaveLength(1);
  });

  it("each orchestrator hears the conclusion once", () => {
    const t = createHealthAlertTracker();
    expect(t.track({ recipient: "orchA", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] })).toHaveLength(1);
    expect(t.track({ recipient: "orchB", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] })).toHaveLength(1);
  });

  it("a card that is gone frees its levels", () => {
    const t = createHealthAlertTracker();
    t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] });
    t.forgetCard("c1");
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx], cool: [] })).toHaveLength(1);
  });

  it("two alerts with one key in a single pass collapse to one", () => {
    const t = createHealthAlertTracker();
    expect(t.track({ recipient: "orch", cardId: "c1", provider: "claude", alerts: [ctx, ctx], cool: [] })).toHaveLength(1);
  });
});

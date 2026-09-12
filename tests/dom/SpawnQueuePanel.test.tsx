import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpawnQueuePanel } from "@renderer/SpawnQueuePanel";

describe("SpawnQueuePanel", () => {
  it("renders nothing while the queue is empty", () => {
    const { container } = render(
      <SpawnQueuePanel queue={[]} describeRequester={(id) => `card ${id}`} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists waiting spawns with position, provider and requester label", () => {
    render(
      <SpawnQueuePanel
        queue={[
          {
            id: "q1",
            requesterId: "12",
            provider: "claude",
            reason: "implementar filtro",
            requestedAt: 1,
          },
          {
            id: "q2",
            requesterId: "99",
            provider: "codex",
            requestedAt: 2,
          },
        ]}
        describeRequester={(id) => (id === "12" ? "Bash 2°" : `card ${id}`)}
      />,
    );

    expect(screen.getByText(/fila de spawn — 2 aguardando/)).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("de Bash 2°")).toBeTruthy();
    expect(screen.getByText("de card 99")).toBeTruthy();
    expect(screen.getByText("implementar filtro")).toBeTruthy();
  });
});

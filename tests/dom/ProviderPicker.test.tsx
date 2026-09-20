import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProviderPicker } from "@renderer/ProviderPicker";
import { buildProviderGroups } from "@renderer/provider-groups";
import { setLocale } from "../../src/shared/i18n";

/**
 * Relato do dono (2026-09-20): nativo e genérico apareciam na MESMA lista
 * indistinguível, e a lista trazia uma label "provider" de campo. O picker
 * agora só desenha os grupos que `buildProviderGroups` deriva da
 * classificação do MAIN — e não afirma grupo nenhum antes de o main
 * responder (`labelled: false`).
 */
const NATIVE = ["bash", "claude", "codex", "cursor", "antigravity", "opencode"];
const ORDERED = [...NATIVE, "cline", "commandcode"];
const AVAILABLE = ORDERED.filter((id) => id !== "bash").map((id) => ({
  id,
  label:
    id === "cline"
      ? "Cline"
      : id === "commandcode"
        ? "Command Code"
        : id[0].toUpperCase() + id.slice(1),
  installed: true,
  installCommand: null,
}));

function groups() {
  return buildProviderGroups({
    orderedIds: ORDERED,
    available: AVAILABLE,
    dynamicIds: ["cline", "commandcode"],
    skippedIds: [],
  });
}

beforeEach(() => {
  setLocale("pt-BR");
});

describe("ProviderPicker", () => {
  it("separa NATIVOS de GENÉRICOS quando a classificação do main já chegou", () => {
    render(<ProviderPicker groups={groups()} labelled value="bash" onChange={vi.fn()} />);

    expect(screen.getByText("NATIVOS")).toBeTruthy();
    expect(screen.getByText("GENÉRICOS")).toBeTruthy();
    expect(document.querySelector('[data-provider-group="native"]')?.textContent).toContain(
      "Claude",
    );
    expect(document.querySelector('[data-provider-group="generic"]')?.textContent).toContain(
      "Cline",
    );
    expect(document.querySelector('[data-provider-group="generic"]')?.textContent).toContain(
      "Command Code",
    );
  });

  it("não afirma grupo antes da primeira resposta do main", () => {
    render(<ProviderPicker groups={groups()} labelled={false} value="bash" onChange={vi.fn()} />);

    expect(screen.queryByText("NATIVOS")).toBeNull();
    expect(screen.queryByText("GENÉRICOS")).toBeNull();
    expect(document.querySelector('[data-provider-group="all"]')).toBeTruthy();
  });

  it("o rótulo do botão é o label declarado, não a string de UI nem o id cru", () => {
    render(<ProviderPicker groups={groups()} labelled value="cline" onChange={vi.fn()} />);

    const clineBtn = screen.getByTitle("Cline");
    expect(clineBtn.textContent).toBe("Cline");
    expect(clineBtn.className).toContain("active");
  });

  it("id que colide com um nativo aparece UMA vez (o nativo ganha)", () => {
    const shadowed = buildProviderGroups({
      orderedIds: ["bash", "claude"],
      available: AVAILABLE,
      dynamicIds: ["claude"],
      skippedIds: ["claude"],
    });
    render(<ProviderPicker groups={shadowed} labelled value="claude" onChange={vi.fn()} />);

    expect(screen.getAllByTitle("Claude")).toHaveLength(1);
    expect(document.querySelector('[data-provider-group="generic"]')).toBeNull();
  });

  it("clicar devolve o id do provider", () => {
    const onChange = vi.fn();
    render(<ProviderPicker groups={groups()} labelled value="bash" onChange={onChange} />);

    fireEvent.click(screen.getByTitle("Cline"));
    expect(onChange).toHaveBeenCalledWith("cline");
  });
});

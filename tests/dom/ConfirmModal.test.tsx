import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmModal } from "@renderer/ConfirmModal";

describe("ConfirmModal", () => {
  it("exposes dialog semantics and wires confirm/cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        title="Fechar terminal?"
        message="O processo ainda está rodando."
        confirmLabel="Fechar"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Fechar terminal?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("O processo ainda está rodando.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("closes on Escape via the shared modal hook", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        title="Descartar?"
        message="Alterações não salvas."
        confirmLabel="Descartar"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop is clicked", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmModal
        title="Sair?"
        message="Encerrar a sessão."
        confirmLabel="Sair"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );

    const backdrop = container.querySelector(".modal-backdrop");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

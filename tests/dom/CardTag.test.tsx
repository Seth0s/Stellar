import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CardTag } from "@renderer/CardTag";

describe("CardTag", () => {
  it("shows the label and enters rename on the pencil button", () => {
    const onRename = vi.fn();
    render(<CardTag label="Bash 1" onRename={onRename} />);

    expect(screen.getByText("Bash 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /renomeável/i }));
    const input = screen.getByDisplayValue("Bash 1");
    fireEvent.change(input, { target: { value: "orquestrador" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("orquestrador");
  });

  it("cancels rename on Escape without calling onRename", () => {
    const onRename = vi.fn();
    render(<CardTag label="Files" onRename={onRename} />);

    fireEvent.doubleClick(screen.getByText("Files"));
    const input = screen.getByDisplayValue("Files");
    fireEvent.change(input, { target: { value: "scratch" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Files")).toBeTruthy();
  });

  it("ignores blank rename commits", () => {
    const onRename = vi.fn();
    render(<CardTag label="sticky" onRename={onRename} />);

    fireEvent.click(screen.getByRole("button", { name: /renomeável/i }));
    const input = screen.getByDisplayValue("sticky");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
  });
});

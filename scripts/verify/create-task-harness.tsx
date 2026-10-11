/**
 * Isolated React mount of CreateTaskModal for visual smoke (real component).
 * Built by smoke-create-task-visual.mjs via vite; not part of the app bundle.
 */

import { createRoot } from "react-dom/client";
import { CreateTaskModal } from "../../src/renderer/src/CreateTaskModal";
import {
  emptyCreateTaskForm,
  prototypeConflictTasks,
  prototypeFilledSeed,
  type CreateTaskFormState,
  type CreateWhen,
} from "../../src/renderer/src/create-task-form-decisions";

declare global {
  interface Window {
    __setCreateTaskState?: (mode: "empty" | "filled" | "reactive") => void;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");

const root = createRoot(rootEl);

function render(mode: "empty" | "filled" | "reactive"): void {
  let seed: Partial<CreateTaskFormState> | null = null;
  let when: CreateWhen = "deps";
  if (mode === "filled" || mode === "reactive") {
    seed = prototypeFilledSeed();
    when = mode === "reactive" ? "now" : "deps";
    seed = { ...seed, when };
  } else {
    seed = emptyCreateTaskForm();
  }
  root.render(
    <CreateTaskModal
      open
      boardId="board-smoke"
      boardName="Board 64"
      sprintLabel="Sprint Ciclo 2"
      seed={seed}
      activeTasks={mode === "empty" ? [] : prototypeConflictTasks()}
      onClose={() => undefined}
      onCreated={() => undefined}
    />,
  );
}

window.__setCreateTaskState = render;
render((new URLSearchParams(location.search).get("mode") as "empty" | "filled" | "reactive") || "filled");

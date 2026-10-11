/**
 * Preload binder for full create-task. Merge into `tasks` in preload/index.ts:
 *   ...createTaskApi(ipcRenderer)
 */

import type { IpcRenderer } from "electron";
import { CREATE_TASK_FULL_CHANNEL, type CreateTaskFullInput, type CreateTaskFullResult } from "../main/create-task-ipc";

export function createTaskApi(ipcRenderer: IpcRenderer): {
  createFull: (input: CreateTaskFullInput) => Promise<CreateTaskFullResult>;
} {
  return {
    createFull: (input) => ipcRenderer.invoke(CREATE_TASK_FULL_CHANNEL, input),
  };
}

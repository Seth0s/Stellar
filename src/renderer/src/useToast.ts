import { useSyncExternalStore } from "react";

export type Toast = { id: number; msg: string };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Fire-and-forget toast, auto-dismissed after 2400ms — module-level state so any component can call it without prop-drilling a setter. */
export function toast(msg: string) {
  const id = nextId++;
  toasts = [...toasts, { id, msg }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 2400);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
  );
}

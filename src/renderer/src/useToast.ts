import { useSyncExternalStore } from "react";

export type ToastAction = { label: string; onClick: () => void };
export type Toast = { id: number; msg: string; action?: ToastAction };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Fire-and-forget toast, auto-dismissed after 2400ms — module-level state so any component can call it without prop-drilling a setter. An optional `action` turns the toast into a shortcut (one labelled button) instead of a dead message. */
export function toast(msg: string, action?: ToastAction) {
  const id = nextId++;
  toasts = [...toasts, action ? { id, msg, action } : { id, msg }];
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

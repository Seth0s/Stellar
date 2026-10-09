import { useEffect } from "react";

/** Marks a light card ready as soon as its real component is mounted. */
export function NotifyMountReady({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
}

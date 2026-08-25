import { useState } from "react";
import { Icon } from "./icons";

const DISMISS_KEY = "ac.hintDismissed";

export function Hint() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  if (dismissed) return null;
  return (
    <div className="hint">
      <span>arraste os cards · caneta e conector na régua · scroll pra zoom</span>
      <button
        title="Fechar dica"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

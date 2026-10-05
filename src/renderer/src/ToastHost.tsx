import { useToasts } from "./useToast";

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.msg}
          {t.action ? (
            <button type="button" className="toast-action" data-role="toast-action" onClick={t.action.onClick}>
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

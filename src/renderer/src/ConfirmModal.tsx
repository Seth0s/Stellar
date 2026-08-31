import { useOccludesChrome } from "./occlusion";

/** Generic yes/no confirmation, same modal chrome as AgentAskModal — kept
 * separate from it since that one is specifically the agent-navigation
 * consent gate (different copy, different actors), not a general-purpose
 * confirm. First real use: closing a terminal card with a live process
 * (see App.tsx's closeCard). */
export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  /** Red confirm button — for destructive actions. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useOccludesChrome();
  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onCancel} />
      <div className="modal" role="dialog" aria-labelledby="confirm-title">
        <h3 id="confirm-title">{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

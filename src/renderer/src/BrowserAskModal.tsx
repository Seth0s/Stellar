import { useOccludesChrome } from "./occlusion";

// Ported from CentralByte's BrowserAskModal.tsx: an agent never navigates on
// its own — it asks (via acbridge open), a human decides here.
export function BrowserAskModal({
  url,
  requesterLabel,
  onDeny,
  onAllow,
}: {
  url: string;
  requesterLabel: string;
  onDeny: () => void;
  onAllow: () => void;
}) {
  useOccludesChrome();
  return (
    <div className="modal-root">
      <div className="modal-backdrop" onClick={onDeny} />
      <div className="modal" role="dialog" aria-labelledby="browser-ask-title">
        <h3 id="browser-ask-title">Permissão do navegador</h3>
        <p>
          <strong>{requesterLabel}</strong> quer abrir <code>{url}</code>.
        </p>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onDeny}>
            Negar
          </button>
          <button type="button" className="primary" onClick={onAllow}>
            Permitir
          </button>
        </div>
      </div>
    </div>
  );
}

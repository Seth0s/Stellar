import { useEffect, useState } from "react";
import { useOccludesChrome } from "./occlusion";
import type { RemotePairing } from "../../preload/index";

const POLL_MS = 4000;

/** LAN-only mobile control (DESIGN-BACKLOG.md item 2, phase A) — QR +
 * fallback URL to pair a phone, connection count, and a manual revoke.
 * Same modal chrome as ConfirmModal/BrowserAskModal. */
export function RemotePairingModal({ onClose }: { onClose: () => void }) {
  useOccludesChrome();
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [connections, setConnections] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.remote.pairing().then((p) => {
      if (!cancelled) setPairing(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const poll = () => window.remote.connectionCount().then(setConnections);
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  async function revoke() {
    await window.remote.revoke();
    setPairing(await window.remote.pairing());
  }

  return (
    <div className="modal-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal remote-pairing-modal" role="dialog" aria-labelledby="remote-title">
        <h3 id="remote-title">Controle remoto (celular)</h3>
        {!pairing ? (
          <p>carregando…</p>
        ) : !pairing.url ? (
          <p>
            Nenhum endereço de rede local encontrado — conecte este PC a uma rede Wi-Fi/Ethernet pra parear um
            celular.
          </p>
        ) : (
          <>
            <p className="remote-pairing-hint">
              Escaneie com a câmera do celular (mesma rede Wi-Fi). Mostra terminais rodando agora — sem
              scrollback, só o que sair a partir da conexão.
            </p>
            {pairing.qrDataUrl && <img className="remote-pairing-qr" src={pairing.qrDataUrl} alt="QR de pareamento" />}
            <code className="remote-pairing-url">{pairing.url}</code>
            <p className="remote-pairing-status">
              {connections === 0 ? "nenhum dispositivo conectado" : `${connections} dispositivo(s) conectado(s)`}
            </p>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="danger" onClick={revoke} disabled={!pairing?.url}>
            Revogar acesso
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

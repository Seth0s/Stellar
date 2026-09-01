import { useEffect, useState } from "react";
import { useModal } from "./useModal";
import type { RemoteDevice, RemoteDevicePairing } from "../../preload/index";

const POLL_MS = 4000;

/** LAN-only mobile control (DESIGN-BACKLOG.md item 2) — QR + fallback URL
 * to pair a phone, per-device connection status, and per-device revoke
 * (item 2 revisited — was one shared token/one revoke-everything button;
 * each pairing now gets its own device id, so a stale/lost phone can be
 * dropped without booting every other one). Same modal chrome as
 * ConfirmModal/AgentAskModal.
 *
 * First open with no devices paired yet auto-pairs one right away (same
 * "see a QR immediately" feel the single-token version had) — every
 * pairing after that is an explicit click on "parear novo dispositivo".
 */
export function RemotePairingModal({ onClose }: { onClose: () => void }) {
  const { modalProps } = useModal({ onClose });
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null);
  const [pending, setPending] = useState<RemoteDevicePairing | null>(null);
  const [noNetwork, setNoNetwork] = useState(false);

  async function refreshDevices() {
    const list = await window.remote.devices();
    setDevices(list);
    return list;
  }

  async function pairNew() {
    const p = await window.remote.pairNewDevice();
    if (!p.url) {
      setNoNetwork(true);
      return;
    }
    setNoNetwork(false);
    setPending(p);
    await refreshDevices();
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await refreshDevices();
      if (!cancelled && list.length === 0) await pairNew();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(refreshDevices, POLL_MS);
    return () => clearInterval(id);
  }, []);

  async function revokeOne(id: string) {
    await window.remote.revokeDevice(id);
    if (pending?.id === id) setPending(null);
    await refreshDevices();
  }

  async function revokeAll() {
    await window.remote.revokeAll();
    setPending(null);
    await refreshDevices();
  }

  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal remote-pairing-modal" {...modalProps} aria-labelledby="remote-title">
        <h3 id="remote-title">Controle remoto (celular)</h3>
        {devices === null ? (
          <p>carregando…</p>
        ) : noNetwork && !pending ? (
          <p>
            Nenhum endereço de rede local encontrado — conecte este PC a uma rede Wi-Fi/Ethernet pra parear um
            celular.
          </p>
        ) : (
          <>
            {pending?.url && (
              <>
                <p className="remote-pairing-hint">
                  Escaneie com a câmera do celular (mesma rede Wi-Fi). Mostra terminais rodando agora — sem
                  scrollback, só o que sair a partir da conexão.
                </p>
                {pending.qrDataUrl && (
                  <img className="remote-pairing-qr" src={pending.qrDataUrl} alt="QR de pareamento" />
                )}
                <code className="remote-pairing-url">{pending.url}</code>
              </>
            )}
            {devices.length > 0 && (
              <div className="remote-device-list">
                <div className="remote-device-list-heading">DISPOSITIVOS PAREADOS</div>
                {devices.map((d) => (
                  <div key={d.id} className="remote-device-row">
                    <span className="remote-device-name">
                      {d.connections > 0 && <span className="remote-device-online" title="conectado agora" />}
                      {d.label}
                    </span>
                    <button type="button" className="remote-device-revoke" onClick={() => revokeOne(d.id)}>
                      revogar
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="remote-pair-new" onClick={pairNew}>
              + parear novo dispositivo
            </button>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="danger" onClick={revokeAll} disabled={!devices?.length}>
            Revogar tudo
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

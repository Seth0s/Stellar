import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import { useModal } from "./useModal";
import type { RemoteDevice, RemoteDevicePairing } from "../../preload/index";

const POLL_MS = 4000;

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
        <h3 id="remote-title">{t("remote.title")}</h3>
        {devices === null ? (
          <p>{t("common.loading")}</p>
        ) : noNetwork && !pending ? (
          <p>{t("remote.noLan")}</p>
        ) : (
          <>
            {pending?.url && (
              <>
                <p className="remote-pairing-hint">{t("remote.scanHint")}</p>
                {pending.qrDataUrl && <img className="remote-pairing-qr" src={pending.qrDataUrl} alt={t("remote.qrAlt")} />}
                <code className="remote-pairing-url">{pending.url}</code>
              </>
            )}
            {devices.length > 0 && (
              <div className="remote-device-list">
                <div className="remote-device-list-heading">{t("remote.devices")}</div>
                {devices.map((d) => (
                  <div key={d.id} className="remote-device-row">
                    <span className="remote-device-name">
                      {d.connections > 0 && <span className="remote-device-online" title={t("remote.online")} />}
                      {d.label}
                    </span>
                    <button type="button" className="remote-device-revoke" onClick={() => revokeOne(d.id)}>
                      {t("remote.revoke")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="remote-pair-new" onClick={pairNew}>
              {t("remote.pairNew")}
            </button>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="danger" onClick={revokeAll} disabled={!devices?.length}>
            {t("remote.revokeAll")}
          </button>
          <button type="button" className="primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

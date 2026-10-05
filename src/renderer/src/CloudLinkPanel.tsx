import { useCallback, useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import {
  getCloudDevices,
  getProfilesCloudLink,
  type CloudDeviceInfo,
  type CloudLinkView,
} from "./cloud-link";
import styles from "./CloudLinkPanel.module.css";

/**
 * Account panel: the local profile's link to a server profile (view, change,
 * create) and this account's devices with disconnect. Both IPCs arrive with
 * the server-side work; until the preload exposes them the panel says the
 * capability is absent rather than offering an empty control.
 */
export function CloudLinkPanel() {
  const link = getProfilesCloudLink();
  const devices = getCloudDevices();

  const [view, setView] = useState<CloudLinkView | null>(null);
  const [list, setList] = useState<CloudDeviceInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const refreshLink = useCallback(async () => {
    if (!link) return;
    try {
      const res = await link.cloudLink();
      if (res.ok) setView(res.view);
      else setError(res.error);
    } catch {
      setError(t("account.error.generic"));
    }
  }, [link]);

  const refreshDevices = useCallback(async () => {
    if (!devices) return;
    try {
      setList(await devices.list());
    } catch {
      setList(null);
    }
  }, [devices]);

  useEffect(() => {
    void refreshLink();
    void refreshDevices();
  }, [refreshLink, refreshDevices]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError(t("account.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <div className={styles.head}>
          <span className={styles.title}>{t("account.link.title")}</span>
          <span className={styles.sub}>{t("account.link.sub")}</span>
        </div>
        {!link ? (
          <span className={styles.missing}>{t("account.unavailable.link")}</span>
        ) : !view ? (
          <span className={styles.missing}>{t("common.loading")}</span>
        ) : (
          <>
            <div className={styles.row}>
              <select
                className={styles.select}
                value={view.cloudProfileId ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value === "" ? null : e.target.value;
                  void run(async () => {
                    const res = await link.setCloudLink(view.profileId, next);
                    if (res.ok) setView(res.view);
                    else setError(res.error);
                  });
                }}
              >
                <option value="">{t("account.link.none")}</option>
                {view.available.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.row}>
              <input
                className={styles.input}
                placeholder={t("account.link.newName")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={busy || newName.trim() === ""}
                onClick={() =>
                  void run(async () => {
                    const res = await link.createCloudProfile(newName.trim());
                    if (res.ok) {
                      setView(res.view);
                      setNewName("");
                    } else {
                      setError(res.error);
                    }
                  })
                }
              >
                {t("account.link.create")}
              </button>
            </div>
          </>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.head}>
          <span className={styles.title}>{t("account.devices.title")}</span>
          <span className={styles.sub}>{t("account.devices.sub")}</span>
        </div>
        {!devices ? (
          <span className={styles.missing}>{t("account.unavailable.devices")}</span>
        ) : list === null ? (
          <span className={styles.missing}>{t("common.loading")}</span>
        ) : list.length === 0 ? (
          <span className={styles.missing}>{t("account.devices.none")}</span>
        ) : (
          <ul className={styles.devices}>
            {list.map((d) => (
              <li key={d.id} className={styles.device}>
                <span className={styles.deviceText}>
                  <span className={styles.deviceLabel}>{d.label}</span>
                  {d.lastSeenAt ? <span className={styles.deviceMeta}>{d.lastSeenAt}</span> : null}
                </span>
                {d.current ? (
                  <span className={styles.current}>{t("account.devices.thisOne")}</span>
                ) : (
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const res = await devices.disconnect(d.id);
                        if (res.ok) await refreshDevices();
                        else setError(res.error);
                      })
                    }
                  >
                    {t("account.devices.disconnect")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}

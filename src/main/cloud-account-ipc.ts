/**
 * ACCOUNT — the IPC surface for the server-profile link and the devices (A8).
 *
 * Registers the handlers the account screen (U1) consumes, with the EXACT
 * shape `cloud-link.ts` in the renderer declares: `profiles:cloud-link`,
 * `profiles:set-cloud-link`, `profiles:create-cloud-profile`,
 * `cloud:devices-list` and `cloud:devices-disconnect`. The logic lives in
 * `profiles-cloud.ts`; here there is only the wiring and the device mapping.
 *
 * Everything requires a login: with no account, the reply states what is
 * missing instead of returning an empty or invented state.
 */

import { ipcMain } from "electron";
import { createCloudApi, type CloudApi } from "./cloud-api";
import {
  createAndLinkCloudProfile,
  readCloudLinkView,
  writeCloudLink,
  type CloudLinkViewResult,
} from "./profiles-cloud";

export type CloudAccountIpcDeps = {
  baseUserDataDir: () => string;
  activeProfileId: () => string | null;
  ensureToken: () => Promise<string | null>;
  apiBaseUrl: () => string;
  installId: () => string;
};

/** The shape `cloud-link.ts` in the renderer declares (`CloudDeviceInfo`). */
type CloudDeviceView = { id: string; label: string; current: boolean; lastSeenAt: string | null };

export function registerCloudAccountIpc(deps: CloudAccountIpcDeps): void {
  let api: CloudApi | null = null;
  function cloudApi(): CloudApi {
    return (api ??= createCloudApi({ baseUrl: deps.apiBaseUrl() }));
  }

  const NOT_LOGGED_IN = "não logado na conta Stellar";
  const NO_PROFILE = "sem perfil ativo";

  ipcMain.handle("profiles:cloud-link", async (): Promise<CloudLinkViewResult> => {
    const profileId = deps.activeProfileId();
    if (!profileId) return { ok: false, error: NO_PROFILE };
    const token = await deps.ensureToken();
    if (!token) return { ok: false, error: NOT_LOGGED_IN };
    return readCloudLinkView({ api: cloudApi(), token, baseUserDataDir: deps.baseUserDataDir(), localProfileId: profileId });
  });

  ipcMain.handle("profiles:set-cloud-link", async (_e, profileId: unknown, cloudProfileId: unknown): Promise<CloudLinkViewResult> => {
    if (typeof profileId !== "string") return { ok: false, error: "perfil inválido" };
    if (cloudProfileId !== null && typeof cloudProfileId !== "string") return { ok: false, error: "vínculo inválido" };
    const token = await deps.ensureToken();
    if (!token) return { ok: false, error: NOT_LOGGED_IN };
    const written = writeCloudLink({ baseUserDataDir: deps.baseUserDataDir(), localProfileId: profileId, cloudProfileId });
    if (!written.ok) return { ok: false, error: written.error };
    return readCloudLinkView({ api: cloudApi(), token, baseUserDataDir: deps.baseUserDataDir(), localProfileId: profileId });
  });

  ipcMain.handle("profiles:create-cloud-profile", async (_e, name: unknown): Promise<CloudLinkViewResult> => {
    const profileId = deps.activeProfileId();
    if (!profileId) return { ok: false, error: NO_PROFILE };
    if (typeof name !== "string" || name.trim() === "") return { ok: false, error: "informe um nome" };
    const token = await deps.ensureToken();
    if (!token) return { ok: false, error: NOT_LOGGED_IN };
    return createAndLinkCloudProfile({
      api: cloudApi(),
      token,
      baseUserDataDir: deps.baseUserDataDir(),
      localProfileId: profileId,
      name: name.trim(),
    });
  });

  ipcMain.handle("cloud:devices-list", async (): Promise<CloudDeviceView[]> => {
    const token = await deps.ensureToken();
    if (!token) return [];
    const res = await cloudApi().listDevices(token);
    if (!res.ok) return [];
    const installId = deps.installId();
    return res.value.map((d) => ({
      id: d.id,
      label: d.label !== "" ? d.label : d.installId,
      current: d.installId === installId,
      lastSeenAt: d.lastSeenAt,
    }));
  });

  ipcMain.handle("cloud:devices-disconnect", async (_e, id: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (typeof id !== "string" || id === "") return { ok: false, error: "máquina inválida" };
    const token = await deps.ensureToken();
    if (!token) return { ok: false, error: NOT_LOGGED_IN };
    const res = await cloudApi().deleteDevice(token, id);
    return res.ok ? { ok: true } : { ok: false, error: res.error.message };
  });
}

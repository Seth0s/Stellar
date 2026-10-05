/**
 * Account panel IPC that arrives with the server-side work (link a local
 * profile to a server profile, and list this account's devices). Until the
 * preload exposes them, the panel reads through these guarded accessors and
 * says the capability is absent instead of drawing a control that does
 * nothing.
 */
export type CloudProfileRef = { id: string; name: string; kind: string };

export type CloudLinkView = {
  profileId: string;
  cloudProfileId: string | null;
  available: CloudProfileRef[];
};

export type CloudLinkResult = { ok: true; view: CloudLinkView } | { ok: false; error: string };

export type ProfilesCloudLinkApi = {
  cloudLink: () => Promise<CloudLinkResult>;
  setCloudLink: (profileId: string, cloudProfileId: string | null) => Promise<CloudLinkResult>;
  createCloudProfile: (name: string) => Promise<CloudLinkResult>;
};

export type CloudDeviceInfo = {
  id: string;
  label: string;
  current: boolean;
  lastSeenAt: string | null;
};

export type CloudDevicesApi = {
  list: () => Promise<CloudDeviceInfo[]>;
  disconnect: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function getProfilesCloudLink(): ProfilesCloudLinkApi | null {
  const profiles = window.profiles as unknown as Partial<ProfilesCloudLinkApi>;
  return typeof profiles.cloudLink === "function" ? (profiles as ProfilesCloudLinkApi) : null;
}

export function getCloudDevices(): CloudDevicesApi | null {
  const cloud = window.cloud as unknown as { devices?: CloudDevicesApi };
  return cloud.devices && typeof cloud.devices.list === "function" ? cloud.devices : null;
}

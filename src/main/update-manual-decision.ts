/**
 * WHAT TO TELL SOMEONE WHOSE INSTALL CANNOT UPDATE ITSELF.
 *
 * An install that is neither an AppImage nor a package carrying `package-type`
 * cannot download and install on its own (see update-install-decision.ts). The
 * dialog then offers the release page and, when the package format can be
 * told, the exact command for the system's package manager.
 *
 * The format comes from `resources/package-type` when present; otherwise from
 * the distribution family in /etc/os-release (a Fedora-family system installs
 * rpm with dnf, a SUSE one with zypper, a Debian-family one deb with apt). When
 * neither says anything, there is no command — only the link. Never a guess.
 *
 * The file name follows the repo's electron-builder `artifactName`
 * (`${productName}-${version}-${arch}.${ext}`), where rpm spells x64 as
 * `x86_64` and deb spells it `amd64`.
 */
export type ManualInstall = {
  manager: "dnf" | "zypper" | "apt" | null;
  fileName: string | null;
  command: string | null;
};

const NONE: ManualInstall = { manager: null, fileName: null, command: null };

function osReleaseIds(osRelease: string | null): string[] {
  if (osRelease === null) return [];
  const ids: string[] = [];
  for (const key of ["ID", "ID_LIKE"]) {
    const m = new RegExp(`^${key}=("?)(.*?)\\1$`, "m").exec(osRelease);
    if (m?.[2]) ids.push(...m[2].toLowerCase().split(/\s+/));
  }
  return ids;
}

const RPM_FAMILY = ["fedora", "rhel", "centos", "rocky", "almalinux", "nobara", "ol"];
const SUSE_FAMILY = ["suse", "opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles", "sled"];
const DEB_FAMILY = ["debian", "ubuntu", "linuxmint", "pop", "elementary", "raspbian", "kali"];

const RPM_ARCH: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
const DEB_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

export function decideManualInstall(input: {
  platform: string;
  /** Node's `process.arch` (`x64`, `arm64`). */
  arch: string;
  version: string;
  /** Content of `resources/package-type`, or `null`. */
  packageType: string | null;
  /** Content of /etc/os-release, or `null`. */
  osRelease: string | null;
  productName?: string;
}): ManualInstall {
  if (input.platform !== "linux") return NONE;
  const product = input.productName ?? "Stellar";
  const ids = osReleaseIds(input.osRelease);
  const declared = input.packageType?.trim().toLowerCase() ?? null;

  const isSuse = ids.some((id) => SUSE_FAMILY.includes(id));
  let format: "rpm" | "deb" | null = declared === "rpm" || declared === "deb" ? declared : null;
  if (format === null) {
    if (isSuse || ids.some((id) => RPM_FAMILY.includes(id))) format = "rpm";
    else if (ids.some((id) => DEB_FAMILY.includes(id))) format = "deb";
  }
  if (format === null) return NONE;
  const manager: NonNullable<ManualInstall["manager"]> = format === "deb" ? "apt" : isSuse ? "zypper" : "dnf";

  const arch = (format === "rpm" ? RPM_ARCH : DEB_ARCH)[input.arch];
  if (arch === undefined) return NONE;
  const fileName = `${product}-${input.version}-${arch}.${format}`;
  return { manager, fileName, command: `sudo ${manager} install ./${fileName}` };
}

import { describe, it, expect } from "vitest";
import { decideManualInstall } from "../../src/main/update-manual-decision";

const FEDORA = 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=44\n';
const NOBARA = 'NAME="Nobara"\nID=nobara\nID_LIKE="rhel centos fedora"\n';
const SUSE = 'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n';
const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n';
const ARCH = 'NAME="Arch Linux"\nID=arch\n';

const base = { platform: "linux", arch: "x64", version: "0.9.0", packageType: null } as const;

describe("decideManualInstall", () => {
  it("builds the dnf command for a Fedora-family system", () => {
    const r = decideManualInstall({ ...base, osRelease: FEDORA });
    expect(r).toEqual({ manager: "dnf", fileName: "Stellar-0.9.0-x86_64.rpm", command: "sudo dnf install ./Stellar-0.9.0-x86_64.rpm" });
    expect(decideManualInstall({ ...base, osRelease: NOBARA }).manager).toBe("dnf");
  });

  it("uses zypper on SUSE", () => {
    expect(decideManualInstall({ ...base, osRelease: SUSE }).command).toBe("sudo zypper install ./Stellar-0.9.0-x86_64.rpm");
  });

  it("uses apt and the amd64 deb on a Debian family", () => {
    expect(decideManualInstall({ ...base, osRelease: UBUNTU })).toEqual({
      manager: "apt",
      fileName: "Stellar-0.9.0-amd64.deb",
      command: "sudo apt install ./Stellar-0.9.0-amd64.deb",
    });
  });

  it("trusts a declared package type over the distribution", () => {
    expect(decideManualInstall({ ...base, packageType: "deb", osRelease: FEDORA }).fileName).toBe("Stellar-0.9.0-amd64.deb");
    expect(decideManualInstall({ ...base, packageType: "rpm", osRelease: UBUNTU }).manager).toBe("dnf");
  });

  it("maps arm64 per format", () => {
    expect(decideManualInstall({ ...base, arch: "arm64", osRelease: FEDORA }).fileName).toBe("Stellar-0.9.0-aarch64.rpm");
    expect(decideManualInstall({ ...base, arch: "arm64", osRelease: UBUNTU }).fileName).toBe("Stellar-0.9.0-arm64.deb");
  });

  it("gives no command when the format cannot be told — only the link remains", () => {
    expect(decideManualInstall({ ...base, osRelease: ARCH }).command).toBeNull();
    expect(decideManualInstall({ ...base, osRelease: null }).command).toBeNull();
    expect(decideManualInstall({ ...base, arch: "ia32", osRelease: FEDORA }).command).toBeNull();
  });

  it("has nothing to say off Linux", () => {
    expect(decideManualInstall({ ...base, platform: "darwin", osRelease: FEDORA }).command).toBeNull();
  });
});

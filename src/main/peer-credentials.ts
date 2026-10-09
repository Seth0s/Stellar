/**
 * Kernel peer credentials for Unix-domain sockets.
 *
 * Linux: SO_PEERCRED. Darwin: LOCAL_PEERPID (+ process info via the addon).
 * Windows: AF_UNIX peer credentials are not available through Winsock the
 * same way. The honest path is a named pipe plus GetNamedPipeClientProcessId;
 * until that lands, this module returns null and callers MUST refuse
 * identity rather than accept a client-declared card id. Never invent a
 * Windows identity from env/argv.
 *
 * `socket._handle.fd` is a Node internal. When the fd is missing, return
 * null (refuse identity) — never fall back to a declared claim.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import { readLinuxProcessStat, type LinuxProcessStat } from "./process-identity";

type PeerCredentialsAddon = {
  getPeerCredentials(fd: number): { pid: number };
  getProcessInfo(pid: number): { pid: number; parentPid: number; startTime: bigint };
};
type InternalSocketHandle = { fd?: number };
type InternalSocket = Socket & { _handle?: InternalSocketHandle };

const require = createRequire(import.meta.url);
let addon: PeerCredentialsAddon | null | undefined;

function loadAddon(): PeerCredentialsAddon | null {
  if (addon !== undefined) return addon;
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, "bin", "stellar-peer-credentials.node") : "",
    join(process.cwd(), "resources", "bin", "stellar-peer-credentials.node"),
    resolve(__dirname, "../../resources/bin/stellar-peer-credentials.node"),
  ].filter(Boolean);
  const path = candidates.find(existsSync);
  if (!path) {
    addon = null;
    return addon;
  }
  try {
    addon = require(path) as PeerCredentialsAddon;
  } catch {
    addon = null;
  }
  return addon;
}

export function peerPidFromSocket(socket: Socket): number | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  const fd = (socket as InternalSocket)._handle?.fd;
  if (!Number.isSafeInteger(fd) || (fd ?? -1) < 0) return null;
  try {
    const result = loadAddon()?.getPeerCredentials(fd!);
    return result && Number.isSafeInteger(result.pid) && result.pid > 0 ? result.pid : null;
  } catch {
    return null;
  }
}

export function readProcessInfo(pid: number): LinuxProcessStat | null {
  if (process.platform === "linux") return readLinuxProcessStat(pid);
  if (process.platform !== "darwin") return null;
  try {
    const result = loadAddon()?.getProcessInfo(pid);
    if (
      !result ||
      !Number.isSafeInteger(result.pid) ||
      !Number.isSafeInteger(result.parentPid) ||
      typeof result.startTime !== "bigint"
    ) {
      return null;
    }
    return { pid: result.pid, parentPid: result.parentPid, startTime: result.startTime };
  } catch {
    return null;
  }
}

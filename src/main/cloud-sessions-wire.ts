/**
 * ACCOUNT SESSIONS — connects the service to the real machine: the SQLite
 * store, git, the file system, the CLI session stores and the account token.
 * `index.ts` calls this once; everything it needs comes in as arguments.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createCloudSessionsApi } from "./cloud-sessions-api";
import { registerCloudSessionsIpc } from "./cloud-sessions-ipc";
import { createSessionLinks } from "./cloud-sessions-links";
import type { CloudSessionsStore } from "./cloud-sessions";
import { getResumeTargetEvidence } from "./session-watch";
import { decideResumeValidity } from "./session-resume-validation";

export type CloudSessionsWireDeps = {
  store: CloudSessionsStore;
  userDataDir: () => string;
  apiBaseUrl: () => string;
  ensureToken: () => Promise<string | null>;
  installId: () => string;
};

/** The `origin` URL of the checkout at `root`, or null when there is none (or no git). */
function gitRemote(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "remote", "get-url", "origin"], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      const url = err ? "" : String(stdout).trim();
      resolve(url === "" ? null : url);
    });
  });
}

async function folderExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function wireCloudSessions(deps: CloudSessionsWireDeps) {
  return registerCloudSessionsIpc({
    api: createCloudSessionsApi({ baseUrl: deps.apiBaseUrl() }),
    links: createSessionLinks(deps.userDataDir()),
    store: deps.store,
    ensureToken: deps.ensureToken,
    installId: deps.installId,
    now: () => Date.now(),
    newId: () => randomUUID(),
    fallbackCwd: () => homedir(),
    gitRemote,
    folderExists,
    resumeExists: ({ provider, cwd, resumeId }) =>
      decideResumeValidity(getResumeTargetEvidence(provider, cwd, resumeId) ?? { exists: false, hasContent: false }).valid,
  });
}

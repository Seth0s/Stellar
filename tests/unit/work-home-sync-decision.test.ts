/**
 * work-home-sync-decision.ts + adaptadores de manifesto — merge de três vias,
 * conflito e conversão para a forma do backend (A3b, §5.2/§5.4). Puro.
 */
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  fromRemoteEntries,
  gitModeString,
  parseGitModeString,
  toRemoteEntries,
  type WorkHomeManifestEntry,
} from "../../src/main/work-home-manifest";
import { planPush, resolvePushConflicts } from "../../src/main/work-home-sync-decision";

const sha = (n: number) => String(n).padStart(64, "0");
const entry = (path: string, shaStr: string, tool: WorkHomeManifestEntry["tool"] = "claude"): WorkHomeManifestEntry => ({
  tool,
  path,
  sha256: shaStr,
  size: 1,
  mode: 0o644,
});
const man = (...entries: WorkHomeManifestEntry[]) => buildManifest(entries);

describe("adaptadores de manifesto (backend B6)", () => {
  it("modo git ↔ bits POSIX", () => {
    expect(gitModeString(0o644)).toBe("100644");
    expect(gitModeString(0o755)).toBe("100755");
    expect(parseGitModeString("100644")).toBe(0o644);
    expect(parseGitModeString("100755")).toBe(0o755);
    expect(parseGitModeString("lixo")).toBe(0o644);
  });

  it("round-trip com remoção (usa a entrada de base para o sha)", () => {
    const base = man(entry("{claude}/gone.md", sha(9)));
    const local = buildManifest([entry("{claude}/kept.md", sha(1))], ["{claude}/gone.md"]);
    const { entries, droppedRemovals } = toRemoteEntries(local, base);
    expect(droppedRemovals).toEqual([]);
    expect(entries.find((e) => e.path === "{claude}/gone.md")?.deleted).toBe(true);
    const back = fromRemoteEntries(entries);
    expect(back.entries.map((e) => e.path)).toEqual(["{claude}/kept.md"]);
    expect(back.removals).toEqual(["{claude}/gone.md"]);
  });

  it("remoção sem base é descartada (não inventa sha)", () => {
    const { entries, droppedRemovals } = toRemoteEntries(buildManifest([], ["{claude}/x"]), null);
    expect(entries).toEqual([]);
    expect(droppedRemovals).toEqual(["{claude}/x"]);
  });
});

describe("planPush — merge de três vias", () => {
  it("arquivo só local entra; arquivo só remoto é preservado", () => {
    const local = man(entry("{claude}/novo.md", sha(1)));
    const remote = man(entry("{claude}/outro.md", sha(2)));
    const plan = planPush(local, remote, null);
    expect(plan.conflicts).toEqual([]);
    expect(plan.manifest.entries.map((e) => e.path).sort()).toEqual(["{claude}/novo.md", "{claude}/outro.md"]);
  });

  it("só o local mudou → local vence; só o remoto mudou → remoto vence", () => {
    const base = man(entry("{claude}/a.md", sha(1)), entry("{claude}/b.md", sha(2)));
    const local = man(entry("{claude}/a.md", sha(3)), entry("{claude}/b.md", sha(2)));
    const remote = man(entry("{claude}/a.md", sha(1)), entry("{claude}/b.md", sha(4)));
    const plan = planPush(local, remote, base);
    expect(plan.conflicts).toEqual([]);
    const byPath = Object.fromEntries(plan.manifest.entries.map((e) => [e.path, e.sha256]));
    expect(byPath["{claude}/a.md"]).toBe(sha(3)); // local
    expect(byPath["{claude}/b.md"]).toBe(sha(4)); // remoto
  });

  it("os dois mudaram → CONFLITO (tentativa mantém local)", () => {
    const base = man(entry("{claude}/a.md", sha(1)));
    const local = man(entry("{claude}/a.md", sha(2)));
    const remote = man(entry("{claude}/a.md", sha(3)));
    const plan = planPush(local, remote, base);
    expect(plan.conflicts).toEqual([{ path: "{claude}/a.md", baseSha: sha(1), localSha: sha(2), remoteSha: sha(3) }]);
    expect(plan.manifest.entries[0].sha256).toBe(sha(2));
  });

  it("apagado local + remoto intacto → remoção; + remoto mudado → conflito", () => {
    const base = man(entry("{claude}/a.md", sha(1)), entry("{claude}/b.md", sha(2)));
    const local = buildManifest([]);
    const remoteIntact = man(entry("{claude}/a.md", sha(1)), entry("{claude}/b.md", sha(2)));
    const plan1 = planPush(local, remoteIntact, base);
    expect(plan1.conflicts).toEqual([]);
    expect(plan1.manifest.removals.sort()).toEqual(["{claude}/a.md", "{claude}/b.md"]);

    const remoteChanged = man(entry("{claude}/a.md", sha(1)), entry("{claude}/b.md", sha(9)));
    const plan2 = planPush(local, remoteChanged, base);
    expect(plan2.conflicts.map((c) => c.path)).toEqual(["{claude}/b.md"]);
  });
});

describe("resolvePushConflicts", () => {
  const base = man(entry("{claude}/a.md", sha(1)));
  const local = man(entry("{claude}/a.md", sha(2)));
  const remote = man(entry("{claude}/a.md", sha(3)));
  const plan = planPush(local, remote, base);

  it("remote troca pela versão remota; local mantém a local", () => {
    const chosenRemote = resolvePushConflicts({ manifest: plan.manifest, conflicts: plan.conflicts, remote, choices: { "{claude}/a.md": "remote" } });
    expect(chosenRemote.entries[0].sha256).toBe(sha(3));
    const chosenLocal = resolvePushConflicts({ manifest: plan.manifest, conflicts: plan.conflicts, remote, choices: { "{claude}/a.md": "local" } });
    expect(chosenLocal.entries[0].sha256).toBe(sha(2));
  });
});

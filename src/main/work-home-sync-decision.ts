/**
 * CASA DE TRABALHO — a DECISÃO do sync, sem I/O (A3b, BACKEND_V1.md §5.4).
 *
 * O empurrão ("push") manda o manifesto INTEIRO para o servidor, então o
 * problema é o merge de três vias por PATH entre o LOCAL (o que a máquina tem
 * agora), o REMOTO (a última revisão do servidor) e a BASE (a última revisão
 * sincronizada aqui):
 *
 *   base    local        remoto       resultado
 *   —       presente     ausente      entra (novo local)
 *   —       ausente      presente     mantém remoto (outro device criou)
 *   A       ==base       !=base       mantém REMOTO (só o remoto mudou)
 *   A       !=base       ==base       LOCAL vence (só o local mudou)
 *   A       !=base       !=base       CONFLITO (os dois mudaram)
 *   A       ausente      ==base       REMOÇÃO (apagamos local, remoto intacto)
 *   A       ausente      !=base       CONFLITO (apagamos, remoto mudou)
 *   A       ausente      ausente      REMOÇÃO (já sumiu dos dois)
 *
 * O `409` é o MESMO problema: o servidor devolve o manifesto atual e a gente
 * roda `planPush` de novo contra ele — os arquivos que só o remoto mudou entram
 * sozinhos; os que os dois mudaram viram CONFLITO para a UI escolher
 * (manter local / remoto / os dois). Revisões diferentes nunca conflitam.
 *
 * Puro: sem fs, sem rede. A casca com I/O é `work-home-sync.ts`.
 */

import {
  buildManifest,
  manifestByPath,
  type WorkHomeManifest,
  type WorkHomeManifestEntry,
} from "./work-home-manifest";

export type PushConflict = {
  path: string;
  baseSha: string | null;
  localSha: string;
  remoteSha: string;
};

export type PushPlan = {
  /** Manifesto a enviar, já com o remoto preservado onde ele venceu. Conflitos
   *  ficam com a versão LOCAL por padrão (o chamador resolve ou pergunta). */
  manifest: WorkHomeManifest;
  conflicts: PushConflict[];
  /** Shas dos arquivos (não-deleted) que o envio referencia — para o check/upload. */
  shas: string[];
};

/** Merge de três vias por path → o manifesto a enviar + os conflitos reais. */
export function planPush(
  local: WorkHomeManifest,
  remote: WorkHomeManifest | null,
  base: WorkHomeManifest | null,
): PushPlan {
  const localMap = manifestByPath(local);
  const remoteMap = manifestByPath(remote);
  const baseMap = manifestByPath(base);

  const entries: WorkHomeManifestEntry[] = [];
  const removals: string[] = [];
  const conflicts: PushConflict[] = [];

  const paths = new Set<string>([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()]);
  for (const path of paths) {
    const L = localMap.get(path);
    const R = remoteMap.get(path);
    const B = baseMap.get(path);

    if (L && R) {
      if (L.sha256 === R.sha256) {
        entries.push(L);
        continue;
      }
      const localChanged = !B || B.sha256 !== L.sha256;
      const remoteChanged = !B || B.sha256 !== R.sha256;
      if (localChanged && remoteChanged) {
        conflicts.push({ path, baseSha: B?.sha256 ?? null, localSha: L.sha256, remoteSha: R.sha256 });
        entries.push(L);
      } else if (localChanged) {
        entries.push(L);
      } else {
        entries.push(R);
      }
      continue;
    }

    if (L && !R) {
      entries.push(L);
      continue;
    }

    if (!L && R) {
      if (B && B.sha256 === R.sha256) {
        removals.push(path);
      } else if (B && B.sha256 !== R.sha256) {
        conflicts.push({ path, baseSha: B.sha256, localSha: "", remoteSha: R.sha256 });
      } else {
        entries.push(R);
      }
      continue;
    }

    // só na base: sumiu dos dois lados.
    if (B) removals.push(path);
  }

  const manifest = buildManifest(entries, removals);
  const shas = [...new Set(manifest.entries.map((entry) => entry.sha256))];
  return { manifest, conflicts, shas };
}

/**
 * Aplica as escolhas da UI sobre os conflitos do push. `remote` é o manifesto
 * remoto que gerou o conflito (para achar a versão remota). Escolha ausente
 * mantém a versão LOCAL (o default do `planPush`). `both` no push é resolvido
 * na CHEGADA (dois arquivos) — aqui vale como "manter local" no manifesto e a
 * UI trata o sufixo ao aplicar o remoto.
 */
export function resolvePushConflicts(input: {
  manifest: WorkHomeManifest;
  conflicts: readonly PushConflict[];
  remote: WorkHomeManifest | null;
  choices: Readonly<Record<string, "local" | "remote" | "both">>;
}): WorkHomeManifest {
  const remoteMap = manifestByPath(input.remote);
  const chosenRemote = new Set<string>();
  const chosenRemoval = new Set<string>();
  for (const conflict of input.conflicts) {
    const choice = input.choices[conflict.path];
    if (choice === "remote") {
      if (conflict.remoteSha === "") chosenRemoval.add(conflict.path);
      else chosenRemote.add(conflict.path);
    }
  }
  const entries: WorkHomeManifestEntry[] = [];
  for (const entry of input.manifest.entries) {
    if (chosenRemoval.has(entry.path)) continue;
    if (chosenRemote.has(entry.path)) {
      const r = remoteMap.get(entry.path);
      if (r) {
        entries.push(r);
        continue;
      }
    }
    entries.push(entry);
  }
  const removals = input.manifest.removals.filter((p) => !chosenRemote.has(p));
  for (const path of chosenRemoval) if (!removals.includes(path)) removals.push(path);
  return buildManifest(entries, removals);
}

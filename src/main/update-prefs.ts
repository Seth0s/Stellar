/**
 * "LEMBRAR MAIS TARDE" PERSISTIDO POR VERSÃO (task 5fb0c21b, item 5).
 *
 * O que existia: esconder o banner por 4h em MEMÓRIA — um restart do app
 * esquecia, e como a checagem só acontece no boot, a prática era o aviso voltar
 * toda vez que alguém abrisse o app de novo. O que passa a valer: a versão
 * adiada fica gravada, e o banner não reaparece para ELA; uma versão MAIS NOVA
 * avisa de novo (é string diferente, não um relógio).
 *
 * Um JSON por assunto na raiz do userData, mesma convenção de `locale.json` /
 * `local-identity.json`. Escrita ATÔMICA (tmp + rename) como as outras: um
 * arquivo de preferência truncado no meio de um save é pior que nenhum.
 *
 * "Pular esta versão" NÃO existe aqui, e é decisão do orquestrador (2026-09-22):
 * pular é uma promessa mais forte que adiar — quem pula deixa de ser avisado de
 * uma correção, e o pedido do dono era não perder o aviso.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPDATE_PREFS_FILENAME = "update-prefs.json";

export function updatePrefsPath(userDataDir: string): string {
  return join(userDataDir, UPDATE_PREFS_FILENAME);
}

export type UpdatePrefs = {
  /** A versão que o usuário adiou, ou `null`. Só UMA: a mais recente adiada. */
  remindLaterVersion: string | null;
};

/** Nunca lança: preferência ilegível é "nenhuma preferência", e o pior que
 *  acontece é o banner aparecer — nunca o app deixar de subir. */
export function readUpdatePrefs(userDataDir: string): UpdatePrefs {
  try {
    const raw: unknown = JSON.parse(readFileSync(updatePrefsPath(userDataDir), "utf8"));
    if (
      raw !== null &&
      typeof raw === "object" &&
      typeof (raw as { remindLaterVersion?: unknown }).remindLaterVersion === "string"
    ) {
      return { remindLaterVersion: (raw as { remindLaterVersion: string }).remindLaterVersion };
    }
  } catch {
    /* ausente ou ilegivel */
  }
  return { remindLaterVersion: null };
}

/** Gravação atômica; devolve o estado que ficou no disco. */
export function writeRemindLaterVersion(userDataDir: string, version: string | null): UpdatePrefs {
  const next: UpdatePrefs = { remindLaterVersion: version };
  const path = updatePrefsPath(userDataDir);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    /* preferência que não grava não pode derrubar nada */
  }
  return next;
}

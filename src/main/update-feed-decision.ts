/**
 * Existe um feed de atualização para este build consultar?
 *
 * UMA FONTE SÓ (task 5fb0c21b): o app NÃO redeclara owner/repo em TypeScript. A
 * declaração mora no `build.publish` do package.json, o electron-builder a
 * materializa em `resources/app-update.yml` dentro do pacote, e este módulo
 * pergunta se ESSE arquivo existe. Antes havia um literal TS
 * (`FEED_PUBLISH_CONFIG = undefined`) que podia divergir da build sem ninguém
 * notar — duas fontes para a mesma pergunta, o defeito que este repo corrigiu
 * várias vezes.
 *
 * O OVERRIDE (`STELLAR_UPDATE_FEED_URL`) existe para a PROVA: um feed local em
 * `http://127.0.0.1:PORT` permite exercitar o evento real `update-available`
 * num build EMPACOTADO e isolado, sem tocar no feed de produção e sem depender
 * de publicar release nenhuma. Ele é declarado como override na resposta para
 * que a UI (e quem lê um relato) saiba que aquele feed não é o de produção.
 *
 * HISTÓRIA QUE NÃO PODE VOLTAR (2026-09-15): o projeto saiu do GitHub e o feed
 * ficou ausente em silêncio — o app dizia "sem novidades" para sempre. A
 * ausência de feed é um ESTADO PRÓPRIO com motivo declarado, nunca um sucesso
 * vazio.
 */
export type UpdateFeedState =
  | { configured: true; source: "app-update.yml" | "override" }
  | { configured: false; reason: "no-feed"; message: string };

/** O nome do arquivo que o electron-builder escreve a partir do
 *  `build.publish`. É a ÚNICA fonte da identidade do feed dentro do app. */
export const UPDATE_FEED_FILENAME = "app-update.yml";

/** A variável de ambiente que aponta a checagem para outro feed. Existe para a
 *  verificação de verdade (build empacotado + feed local), nunca para uso
 *  normal — e a resposta diz que está ligada, para ninguém confundir. */
export const UPDATE_FEED_OVERRIDE_ENV = "STELLAR_UPDATE_FEED_URL";

export function decideUpdateFeed(input: {
  /** `resources/app-update.yml` existe no pacote em execução? */
  appUpdateYmlPresent: boolean;
  /** URL do override, ou `null`. */
  overrideUrl: string | null;
}): UpdateFeedState {
  if (input.overrideUrl !== null && input.overrideUrl.trim() !== "") {
    return { configured: true, source: "override" };
  }
  if (input.appUpdateYmlPresent) return { configured: true, source: "app-update.yml" };
  return {
    configured: false,
    reason: "no-feed",
    // Dito para quem usa o app, não para quem o escreveu.
    message: "Atualização automática desligada nesta build — baixe a versão nova manualmente.",
  };
}

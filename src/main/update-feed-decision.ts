/**
 * Existe um feed de atualização para este build consultar?
 *
 * Contexto (2026-09-15): o projeto saiu do GitHub para um GitLab próprio
 * (`gitlab.idyplatform.com`). O `electron-updater` lia o feed de
 * `latest*.yml` publicado numa GitHub Release, gerado por
 * `.github/workflows/release.yml` — os dois deixaram de existir no mesmo
 * dia. A distribuição passa a ser por uma VPS que ainda não está de pé.
 *
 * O PERIGO AQUI NÃO É FICAR SEM UPDATE, É FICAR SEM UPDATE EM SILÊNCIO.
 * Antes desta mudança havia um tratamento especial para HTTP 404 (o repo
 * de publish era privado) que devolvia `{checked:false}` — o mesmo
 * formato de "checou e não há novidade". Era correto para AQUELE caso e
 * vira mentira agora: sem feed nenhum, o app diria "sem novidades" para
 * sempre, e o usuário nunca saberia que precisa baixar na mão.
 *
 * Por isso a ausência de feed é um ESTADO PRÓPRIO, com motivo declarado,
 * e não um sucesso vazio. Quando a VPS existir, basta `publish` voltar ao
 * `package.json` — esta função passa a devolver `configured: true` sem
 * mais nada mudar.
 */
export type UpdateFeedState =
  | { configured: true }
  | { configured: false; reason: "no-feed"; message: string };

/**
 * @param publishConfig o bloco `build.publish` do package.json embutido no
 *   app (undefined/null quando não há publicação configurada).
 */
export function decideUpdateFeed(publishConfig: unknown): UpdateFeedState {
  const hasProvider =
    publishConfig != null &&
    (Array.isArray(publishConfig) ? publishConfig.length > 0 : typeof publishConfig === "object");
  if (hasProvider) return { configured: true };
  return {
    configured: false,
    reason: "no-feed",
    // Dito para quem usa o app, não para quem o escreveu: o que não vai
    // acontecer, e o que a pessoa deve fazer no lugar.
    message: "Atualização automática desligada nesta build — baixe a versão nova manualmente.",
  };
}

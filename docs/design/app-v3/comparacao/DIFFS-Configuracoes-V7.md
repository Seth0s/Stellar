# Diferenças restantes — Configurações V7 vs protótipo

Comparação visual: `docs/design/app-v3/comparacao/side-*.png` (protótipo | implementação), viewport 1440×900. Shell medido ≥940×700 (SPEC: 1280×820).

## Corrigido (não listar como gap)

- Shell: fora da classe global `.modal`; Emulation 1440×900; assert ≥940×700.
- Modo: faces **Junto / Orquestrado / Autônomo**; preset atual com borda + selo `atual` (smoke aplica `produtivo`); concurrency mostra valor efetivo (cap ou default 3); Campos do relatório à direita na mesma `.row`.
- Providers: Nativos + Genéricos; `+ Adicionar` primário azul (`#4a5fe0`, sem override de `.providers-settings-page button`); rodapé `~/.config/stellar/providers.json` como link mono (path real só em `title`).

## Gaps restantes (honestos)

1. **Providers — nomes/conjunto:** lista viva instalada/registrada ≠ mock fixo do HTML. Justificativa: dado vivo.
2. **Providers — texto da cota:** medição real; isolado → `sem cota` (ok). Justificativa: sem fabricar percentual.
3. **Providers — botão Padrões:** chrome presente; sem editor de defaults por CLI nativa.
4. **Atalhos:** aviso de conflito no topo; lista = `ShortcutsOverlay` (≠ rows do proto).
5. **Desempenho — controles:** UI de fps/scrollback; valores ainda fixos no código/env.
6. **Desempenho — “Agora”:** sessões em background, não CPU/GPU/RAM.
7. **Desempenho — “Detalhes por card”:** botão desabilitado.
8. **Gates — isolamento:** switch sempre ligado.
9. **Time — casa do time:** switch visual.
10. **Sobre — pasta de dados:** sem `shell.openPath` no `system` API.
11. **Conta:** dados reais cloud/workhome.
12. **Aparência — reduzir movimento:** select system/on/off.
13. **Busca (side-search-cota):** proto estático; impl filtra de verdade.

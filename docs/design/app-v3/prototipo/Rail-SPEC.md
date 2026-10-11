# Rail V3 — tabela de especificação (telas 9–10)

Fonte: `Rail.dc.html` + `RailPassos.dc.html` + `measurements.json` (proto).  
Implementação: `src/renderer/src/Rail.tsx` + `Rail.module.css` + tokens `--rail-*`.

## Layout shell

| Elemento | Texto | Fonte | Cores | Medidas | Layout | Estados |
|---|---|---|---|---|---|---|
| Shell aberto | — | Space Grotesk | bg `#0b0d12` | **440×H** | flex row | aberto |
| Shell recolhido | — | — | strip only | **56×H** | — | `collapsed` |
| Strip (nav) | — | — | bg `#0c0f15`, border-right `#1d2230` | **w 56**, pad `12 0`, gap `6` | column, center | sempre |
| Logo | (svg estrela) | — | bg `#1a1f33`, fill `#a9b8ff` | 32×32, radius 9, mb 8 | grid center | — |
| Botão strip | aria por ferramenta | — | fg `#a3aabb`; hover bg `#161a24` fg `#e8eaf0`; on bg `#1d2333` + inset `#3b4570` | 40×40, radius 10 | grid center | hover / `rbOn` |
| Divisor strip | — | — | `#1d2230` | 24×1, my 6 | — | — |
| Painel | — | — | bg `#0f1218`, border-right `#1d2230` | **w 384** | column | oculto se collapsed |
| Header painel | título + hint | título 16/600; hint 12 `#8d94a6` | border-bottom `#1d2230` | pad `16 18 12`, gap 6 | row title/hint | — |
| Step dots (agente) | `Passo N de 2 · …` | 12 `#8d94a6` | dot on `#7d8cff`, off `#2a2f3d` | dots 22×4 r2 | row | term1/term2 |
| Corpo painel | — | — | — | pad `14 14 18`, gap 14, scroll | column | — |
| Section label | `FERRAMENTAS` / `BOARD` / … | 11.5, tracking 0.06em, uppercase | `#8d94a6` | pad `0 12 6` | — | — |
| Item lista `.it` | nome + kbd | 14 | fg `#e8eaf0`; active bg `#1d2333`; hover `#161a24` | min-h 44, pad `0 12`, gap 12, radius 10 | flex | hover/active |
| Kbd | tecla | JetBrains Mono 11/500 | fg `#c9cede`, bg `#12151d`, border `#2f3546` (bottom 2) | min-w 20, h 20, pad `0 5`, r 5 | inline-grid | — |
| Tile | título + desc | 14–15/600; desc 12–12.5 `#a3aabb` | border `#232838`, bg `#0f1218`; hero `#121730`/`#2b3460` | pad 12, r 12, gap 6 | column / grid 2col gap 8 | hover |
| Field | — | 14; mono path 12.5 | border `#2a2f3d`, bg `#0c0f15` | min-h 40, pad `0 12`, r 9 | — | — |
| Btn / primary | — | 13.5; primary 600 | btn `#161a24`/`#2a2f3d`; primary `#4a5fe0` | min-h 40, pad `0 14`, r 9 | — | — |
| Back | `‹ …` | 13 | `#a9b8ff` | — | — | — |
| Tip rodapé | atalhos | 12.5 `#a3aabb` | bg `#12151d`, r 10 | pad `10 12` | — | tools only |

## Oito estados (painel)

| # | step | Título | Hint | Conteúdo |
|---|---|---|---|---|
| 1 | `collapsed` | — | — | só strip; painel off |
| 2 | `tools` | Barra lateral | aberta | FERRAMENTAS + BOARD + tip atalhos |
| 3 | `add` | Novo card | escolha o tipo | hero Agente/terminal + grid 2×3 |
| 4 | `terminal1` | Novo agente | — | quem roda + cotas; breadcrumb ‹ Novo card |
| 5 | `terminal2` | Novo agente | — | pasta/modelo/esforço/sessão/instruções; ‹ provider |
| 6 | `cards` | Achar card | Ctrl F | busca + lista com status vivo |
| 7 | `pen` | Caneta | P | 5 cores + 3 espessuras + tip Esc/Ctrl Z |
| 8 | `ai` | Ações de IA | — | Resumir o board · Organizar automaticamente |

## Canvas

| Item | Spec |
|---|---|
| Largura dock | 56 recolhida / 440 aberta (`--rail-dock-width`) |
| Board | `.board-viewport` à direita do dock; `viewportRef` aqui |
| fit/focus pad | pad simétrico (rail fora do board) |
| Topbar | offsets relativos ao board (72/12), não à janela |
| Coords | world cards inalterados; screen↔world via board-viewport |

## Dados (mock / app)

| UI | Fonte |
|---|---|
| Providers + cotas | `buildProviderGroups` + `providerUsage` / `decideProviderUsage` |
| Pen cores/espessura | `STROKE_COLORS` + presets existentes |
| Cards / status | props `cards` (+ live status quando houver) |
| Pasta / modelo / esforço / sessão | estado `new*` já no App |
| Create kinds | hero terminal + browser/files/changes/sticky/chat/media |

## i18n

Textos do protótipo (pt-BR) e pares en; chaves `rail.v3.*` / atualização das existentes com paridade.

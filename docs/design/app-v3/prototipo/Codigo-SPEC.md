# Código (tela 13) — specification extracted from the approved prototype

Source: `Codigo.dc.html`, read in full, including shared CSS classes, inline styles, and `<script type="text/x-dc">`. Preview: 1440×900. Script state: `side ∈ {files,search,git,agents,prob}`, `diff: boolean`. CardFrame chrome is owned by V2 — this card fills the body; do not edit `CardFrame.tsx` / `cards.css`.

Prototype hex → Stellar tokens (when equivalent). New chrome colors become tokens; language-identity hex stays per SYSTEM_DESIGN §5.4.

| Prototype | Token / note |
|---|---|
| `#0f1218` card surface | `--card-surface` |
| `#12151d` head | `--card-head-surface` |
| `#0c0f15` foot / rail | `--card-foot-surface` |
| `#1d2230` divider | `--card-divider` |
| `#e8eaf0` primary text | `--card-name` / near `--text` |
| `#8d94a6` muted | `--card-context` |
| `#c9cede` code body text | keep literal or map near `--text` |
| `#7d8cff` accent underline / pill dot | new or reuse foam/violet — pin as `--code-accent` if added |
| `#4a5fe0` badge blue | new `--code-badge` |
| `#b5453a` problems badge | near `--danger` |
| Folder cycle `#e8b04b` `#6fa8ff` `#b48cff` `#4fc3a1` | language/folder identity (exemption) |
| Agent dots `#f0883e` `#5b8cff` | card accent colors from live cards |

## Element specification

| Element | Exact text / content | Font | Color: text / bg / border | Size and layout | Radius, padding, gap, states, interaction |
|---|---|---|---|---|---|
| Preview canvas | — | Space Grotesk | body `#05060a`; board `#0b0d12` + radial dots `#1b2030` | 1440×900 | Dot grid 22×22 |
| Card shell | — | inherited | `#e8eaf0` / `#0f1218` / focus `#4a5690` | 1380×852 absolute; flex column; overflow hidden | radius 12; shadow `0 0 0 1px #4a5690, 0 14px 40px #000a` (CardFrame) |
| Header (CardFrame) | icon tile + name `Stellar` + path `~/Workplace/Projects/Stellar` + close | name 13.5px/600; path mono 12px `#8d94a6` | head `#12151d`; border-bottom `#1d2230` | height 42; flex; gap 10; pad `0 8px 0 12px` | icon tile 24×24 radius 7, bg `#1d2216`, glyph `#b9d68a` |
| Header go-to field | placeholder `Ir para arquivo…  Ctrl P` | 12.5px | text `#e8eaf0`; border `#2a2f3d`; bg `#0c0f15` | height 28; width 300; flex row gap 8; pad `0 10px` | radius 7; opens Ctrl+P palette |
| Header agents pill | `2 agentes mexendo aqui` | 11.5px | `#c3cbff` / `#1a2040`; dot `#7d8cff` 7×7 | inline-flex gap 6; pad `2px 8px` | radius 999 |
| Activity rail | 5 buttons: Arquivos, Buscar, Git, Agentes, Problemas | SVG 18×18 | idle `#8d94a6`; hover `#e8eaf0`/`#161a24`; on `#e8eaf0`/`#1d2333` | width 48; column; gap 4; pad `8px 0`; border-right `#1d2230`; bg `#0c0f15` | btn 40×40 radius 9 (`.ab` / `.abOn`) |
| Rail badge | counts `6`, `2`, `2` | 9.5px | `#fff` / `#4a5fe0` (problems `#b5453a`) | min-width 15; height 15; absolute right/top 4 | radius 8; pad `0 3px` |
| Side panel | title from state | title 11.5px uppercase letter-spacing `.06em` `#8d94a6` | bg `#0d1016`; border-right `#1d2230` | width 270; flex column | title row height 36; pad `0 12px` |
| Side titles | `Arquivos` · `Buscar e substituir` · `Mudanças por task` · `Agentes nesta pasta` · `Problemas` | as above | as above | exact copy | switch with rail |
| Tree row `.tr` | chevron + folder/file + optional agent dot + git M/A/D | 12.5px; mono for tree | `#c9cede`; hover `#161a24`; selected `#1a2040` | height 26; flex; gap 6; pad `0 10px`; indent +14px/level | pointer; nowrap |
| Folder icon | filled folder SVG | — | stroke/fill cycle by depth: L0 `#e8b04b`, L1 `#6fa8ff`, L2 `#b48cff`, L3 `#4fc3a1` (then repeat) | 16×14 | fill = stroke + `33` alpha |
| File language badge | `TS` `⚛` `#` `{}` `✓` `$` `▣` `M↓` … | mono 600 7.5px | per language (see icon table) | 16×16; radius 4 | flex none |
| Git letter | `M` `#f0b25c` · `A` `#8fdcc0` · `D` (delete red) | mono | as letters | end of row | from real git status |
| Agent activity dot | 7×7 circle | — | card accent (`#f0883e`, `#5b8cff`, …) | after name | only when a live agent owns the file |
| Tree legend | `Pastas: a cor muda a cada nível` · `Arquivos: ícone da linguagem` | 11px `#8d94a6` | border-top `#1d2230` | margin-top auto; pad `10px 12px`; wrap gap `8px 12px` | — |
| Search inputs | labels `Buscar no conteúdo` / `Substituir`; sample value `replay.scrollback` | mono 12px | border focus `#3b4570` / idle `#2a2f3d`; bg `#0c0f15` | height 30; radius 7; pad `0 8px`; gap 6 | — |
| Search meta | `3 resultados em 2 arquivos · Aa · .* · palavra` | 11.5px `#8d94a6` | — | — | — |
| Search hit | file + count; snippet with highlight bg `#3b4570` | mono; snippet `#a3aabb` | — | nested pad-left 22 | — |
| Git panel | `main · 6 alterados · ↑0 ↓0`; buttons `Ver diff de tudo` / `Por task` | mono 12px; btn 12px | `#c9cede`; btn border `#2a2f3d` bg `#161a24` | btn min-height 28; pad `0 10px`; radius 7; gap 6 | hover border `#3a4258` |
| Git groups | `#c5b6ae · IMPL · Claude` / `sem task`; files with `+N`/`−N` | mono | group `#8d94a6`; `+` `#3fb68b`; `−` `#e0846f` | indent 18 for files | attribution from app facts only |
| Agents panel | cards IMPL/REVISOR + territory note | 13px title; 12px body; mono 11.5px territory | border `#232838`; note `#8d94a6` | card radius 10; pad 10; gap 6/8 | note: `Arquivo no território de um agente rodando abre com um aviso antes de você editar.` |
| Problems side | `✕ …` `#f2a093` · `! …` `#f0b25c`; footer `do tsc, ao salvar` | mono / UI 12px | — | — | from tsc/linter on save |
| Editor tabs | filename + lang badge + agent/dirty dots | 12.5px; tabOn `#e8eaf0` | bar `#0d1016`; border `#1d2230`; tab border-right `#1d2230`; tabOn bg `#0b0d12` + inset `0 2px 0 #7d8cff` | height 36; pad `0 12px`; gap 8 | click selects; badge 14×14 radius 3 |
| Tab actions | `Diff com HEAD` / `Fechar diff`; `Dividir` | `.btn` | — | right cluster pad `0 8px` gap 6 | toggles side-by-side HEAD |
| Breadcrumbs | `src › renderer › src › useTerminal.ts ›` + symbol `replayInto` | 11.5px `#8d94a6`; symbol `#c9cede` | border-bottom `#161a24` | height 26; pad `0 14px`; gap 6 | — |
| Code lines | syntax `.k` `#c792ea` `.s` `#c3e88d` `.f` `#82aaff` `.c` `#636b85` `.t` `#ffcb6b` `.n` `#f78c6c` body `#c9cede` | JetBrains Mono 12.5px | editor bg `#0b0d12` | line height 21; num width 44 right pad 12 `#4f5670` | gutter strip 4×21 + margin-right 10 |
| Agent gutter | colored `#f0883e` (agent) / `#e5534b` (error) | — | — | gut column | tooltip on hover |
| Current line tint | bg `#1a1712` | — | — | — | — |
| Error line tint | bg `#2a1414`; wavy underline `#e5534b` | — | — | — | diagnostics |
| Gutter tooltip | `IMPL · Claude mudou 742–745 há 40 s`; `task #c5b6ae · …`; `Ver diff` / `Abrir o card` | 12px; strong name | bg `#12151d`; border `#343c55`; shadow `0 8px 24px #000a` | max-width 300; pad `8px 10px`; radius 9; gap 4 | buttons `.btn` |
| Diff pane | title `antes (HEAD)` | UI 11.5px `#8d94a6` | bg `#0c0e13`; border-left `#1d2230` | width 46% | removed lines red gut |
| Minimap | abstract bars | — | bars `#3a4258` / agent `#f0883e` / error `#e5534b` | width 70; opacity .55; border-left `#161a24` | decorative overview |
| Bottom panel | tabs `Problemas 2` · `Saída` · `Linha do tempo do arquivo` · `Mandar a seleção para um agente` | `.pt` 12px `#8d94a6`; `.ptOn` `#e8eaf0` + bottom `#7d8cff` | bg `#0d1016`; borders `#1d2230` | height 150; tab height 30; pad `0 8px` / body `8px 14px` | — |
| Status bar | `main` · `6 alterados` · `✕ 1  ! 1` · `Ln 744, Col 38` · `Espaços: 2` · `UTF-8` · `TypeScript` · `~2,1k tokens` · `salvo` | mono 11.5px `#8d94a6`; dirty `#f0b25c`; errors `#f2a093`; saved `#8fdcc0` | bg `#0c0f15`; border-top `#1d2230` | height 26; pad `0 12px`; gap 16 | CardFrame footer slot or inner bar |

## Language icon table (prototype samples)

| Kind | Badge text | Background | Foreground |
|---|---|---|---|
| TypeScript `.ts` | `TS` | `#3178c6` | `#fff` |
| TSX `.tsx` | `⚛` | `#0b2a3a` | `#61dafb` |
| CSS | `#` | `#5b3a8a` | `#e0c7ff` |
| JSON | `{}` | `#4a3d10` | `#f0c94b` |
| Markdown | `M↓` | `#2a2f3d` | `#c9cede` |
| Test `*.test.*` | `✓` | `#14301f` | `#7ee2a0` |
| Shell | `$` | `#14301f` | `#7ee2a0` |
| Image | `▣` | `#2b1d35` | `#d29bf0` |
| Go / Python / Rust / SQL | letter from language (G/Py/Rs/SQL) | linguist-aligned | contrast text |

## Interaction state machine

| State | Behavior |
|---|---|
| `side` | Rail sets panel; only one `sc-if` visible |
| `diff` | Toggles HEAD side-by-side; label `Diff com HEAD` ↔ `Fechar diff` |
| Ctrl+P | Focus go-to / open file palette |
| Territory conflict | Before human edit of a file in a running agent's territory → warning dialog |
| Save | Refresh problems from tsc/project linter |

## Data sources (app facts only — invent nothing)

| UI claim | Source |
|---|---|
| Git M/A/D + branch + counts | existing git status IPC |
| Agent dots / “N agentes mexendo” | live cards + task territory + captured task diffs |
| Line gutter colors + tooltip | per-task diff hunks ∩ card accent ∩ task id/title |
| Problems | diagnostics on save (tsc / project linter) |
| Tokens estimate | optional measured editor metric; omit if unknown |
| “salvo” | dirty flag / autosave |

## Responsive

Prototype is desktop-only 1440×900. On 768/375: keep rail icons; collapse side panel behind rail toggle; editor and bottom panel stack; status bar scrolls horizontally. CardFrame geometry unchanged (V2).

## Out of scope / owned elsewhere

- `CardFrame.tsx`, `cards.css` (V2 card `31254094`)
- Invented authorship when the app has no territory/diff evidence

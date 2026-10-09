# Cards V2 — specification extracted from the approved prototype

Source: `Cards.dc.html`, read in full, including its inline CSS and `<script type="text/x-dc">`. The HTML declares a 1440×900 preview. The script returns `{}` and adds no state or interaction; button/link behavior is not implemented in the prototype. Values below are the prototype's literal CSS and visible copy.

## Element specification

| Element | Text / content in prototype | Font | Color: text / background / border | Size and layout | Radius, spacing, states and interaction |
|---|---|---|---|---|---|
| Preview canvas | Rail collapsed; Board | Space Grotesk, system-ui, sans-serif | `#e8eaf0` / body `#05060a`, board `#0b0d12`, dot `#1b2030` | 1440×900; rail 56×900; board fills remainder; dot grid 22×22 with 1px dot | Body margin 0; board is relative; overflow hidden |
| Card shell | Type-specific card | Inherited Space Grotesk | `#e8eaf0` / `#0f1218` / `#232838` | Absolute positioned; flex column; overflow hidden | 12px radius; `0 10px 30px #0008` shadow |
| Focused card | Same content | Inherited | Focus border `#4a5690` | Same geometry | `0 0 0 1px #4a5690, 0 14px 40px #000a`; shown on terminal sample |
| Header | Type icon, name, context, spacer, state/task pills, actions | Inherited | Header background `#12151d`; divider `#1d2230` | Fixed 42px height, flex row, center aligned, 10px gap, padding `0 8px 0 12px`; no shrink | Bottom border 1px; never wraps in sample |
| Type icon tile | Provider/type glyph | Inherited SVG | Per-sample tile/glyph: terminal `#2a1d14` / `#f0a46b`; browser `#142039` / `#8fb4ff`; files `#1d2216` / `#b9d68a`; changes `#2a1a24` / `#e89bc4`; note `#3a3214` / `#f0d36b` | 24×24px; grid centered; glyph SVG 13×13px | 7px radius; flex none |
| Name | `IMPL · Claude`; `Admin Idy`; `Stellar`; `Mudanças`; `Feedbacks` | 13.5px, weight 600 | `#e8eaf0` | One line; overflow hidden, ellipsis | No explicit letter spacing or transform |
| Context | `Sonnet 5.5 · ~/Projects/Stellar`; `localhost:5173/configuracoes`; `src/renderer`; `Stellar · main`; `nota` | 12px, weight normal | `#8d94a6`; browser/files/changes use JetBrains Mono via `.mono` | One line; min-width 0; overflow hidden, ellipsis | Sits after name; no extra border or background |
| Flexible separator | Empty spacer | — | — | `flex: 1` | Separates context from state/task/actions |
| State pill | `trabalhando`; `agente: Sonnet Frontend`; `não commitado` | 11.5px, weight normal | Terminal `#c3cbff` / `#1a2040`; browser `#a3aabb` / `#161a24`; changes `#f0b25c` / `#22190d` | Inline flex; center aligned; 5px gap | 2px 8px padding; 999px radius; nowrap |
| Linked task pill | `#511abc` | JetBrains Mono, 11.5px | `#a9b8ff` / `#161a24` | Inline flex | Same pill shape; link has no underline |
| Header action | Accessible labels `Mais ações`, `Fechar card`, `Recarregar` | Inherited | `#8d94a6`; hover `#e8eaf0` / `#1d2230` | Fixed 28×28px; centered grid | 7px radius; transparent borderless background; pointer cursor; flex none |
| Terminal body sample | Read/Edit/Bash/output lines; `✓ 14 passed`; `Julienning… (12m 40s · ↓ 31.2k tokens)` | JetBrains Mono; 12.5px; line-height 1.65 | Main `#c9cede`; secondary `#8d94a6`; success `#3fb68b`; elapsed `#a3aabb`; body `#0b0d12` | Flex 1; padding 12px 14px; 8px top margin before elapsed row | Body is not part of shared chrome |
| Files body sample | Tree rows | JetBrains Mono; 12.5px; line-height 1.9 | `#c9cede`; modified `#f0b25c`; body inherits board/card surface | Flex 1; padding 10px 12px | Nested levels indent 14px each |
| Changes body sample | File rows and additions/deletions | JetBrains Mono; 12px | Divider `#1d2230`; additions `#3fb68b`; deletions `#e0846f` | Flex column; each row gap 10px; padding 8px 12px | Row divider 1px except final row |
| Note body sample | `Cards esquecem report → lembrete automático.` / `Arrastar mídia para o terminal.` / `Fila em duas linhas.` | Space Grotesk; 13px; line-height 1.55 | `#ece4c6` / `#17150c` | Flex 1; padding 12px 14px | Header `#1f1c10`; footer `#141209` |
| Footer | Per-kind activity/pulse | 11.5px, weight normal | `#8d94a6` / `#0c0f15`; top divider `#1d2230` | Fixed 28px height; flex row; center aligned; 12px gap; padding `0 12px`; nowrap; overflow hidden | Flex none |
| Terminal footer | `ativo há 2 s`; `contexto 34%`; `cota 77% semana`; `implementa #511abc` | 11.5px | Activity dot `#7d8cff`; other copy `#8d94a6` | Four pulse fields with flexible spacer before task role/id | Task role/ref aligned to end |
| Browser footer | `200`; `1340 × 837 · zoom 100%`; `console 0 erros`; `pausado fora da tela` | 11.5px | HTTP success `#8fdcc0`; other text `#8d94a6` | Four pulse fields with flexible spacer before pause state | HTTP text is green in the shown 200 state |
| Files footer | `main`; `12 alterados`; `2 cards nesta pasta` | 11.5px | Modified count `#f0b25c`; other text `#8d94a6` | Branch, count, flexible spacer, folder-card count | One line |
| Changes footer | `+340`; `−52`; `18 arquivos`; `de 2 tasks` | 11.5px | Additions `#3fb68b`; deletions `#e0846f`; other text `#8d94a6` | Counts, flexible spacer, distinct-task count | One line |
| Note footer | `editada há 2 min`; `3 viraram task` | 11.5px | `#8d94a6`; footer background `#141209` | Edited age, flexible spacer, converted-task count | One line |
| Live dot | Working/activity indicator | — | `#7d8cff` | 7×7px circle; state pills use 5px gap | `pulse` animation 1.6s ease-in-out, 0% shadow `0 0 0 0 #7d8cff88`, 70% `0 0 0 6px #7d8cff00`, 100% `0 0 0 0 #7d8cff00`; disabled under `prefers-reduced-motion: reduce` |
| Anatomy callout | `Mesma anatomia em todo card`; exact explanatory sentences in HTML | 13px, line-height 1.5; kicker 11.5px, letter-spacing `.06em`, uppercase | `#c9cede`; kicker `#8d94a6`; `#0b0d12e6` background; dashed `#343c55` border | Absolute right/bottom 24px; width 520px; flex column; gap 8px; padding 14px 16px | 12px radius; 1px dashed border |

## Card geometry in the source HTML

| Type | Position / size | Focus state in source |
|---|---|---|
| Terminal | left 40px, top 40px, 560×380px | Focused |
| Browser | left 640px, top 40px, 560×380px | Unfocused |
| Files | left 40px, top 460px, 300×380px | Unfocused |
| Changes | left 380px, top 460px, 420×300px | Unfocused |
| Note | left 840px, top 460px, 360×230px | Unfocused |

## Data contract and application mapping

| Card kind | Header context/status/task | Footer | Source and missing data |
|---|---|---|---|
| Terminal | Model + cwd; measured active turn; linked task ID opens task detail | PTY last-activity timestamp; card-health context only with a known window; quota only when parsed; linked role/ID | `TerminalCard`, `pty:health` backed by registry and `readCardHealth`; unknown fields omitted |
| Browser | Current URL; owner label when present | `did-navigate` HTTP response code; emulated dimensions or card viewport; read zoom; console errors; offscreen pause | `BrowserCard`; pass the actual `httpResponseCode` from `did-navigate`; no status until a navigation provides one |
| Files/code | Selected subfolder, else root | Git branch and changed-entry count; sibling cards with the same root | `FilesCard`; cards filtered by their actual `cwd`/`root` |
| Changes | Repository root + branch; uncommitted only when entries exist | Insertions/deletions and file count; distinct task count only if attribution exposes task IDs | `GitStatus` / `GitAttribution`; omit unsupported task count |
| Note | Note category | Last persisted card update time; converted-task count only if a persisted task relation exists | `CardRow.updated_at` via `StickyCardData.updatedAt`; checklist alone is not a task relation |
| Chat | Provider + model; responding only while streaming | cwd; elapsed/current-turn token counts already measured | `ChatCard` current state |
| Media image | Image type and natural resolution once loaded | Natural resolution + internal zoom | Asset image `naturalWidth`/`naturalHeight`; omit dimensions before load |
| Media PDF | PDF type and page count when known | Current page and total pages | Existing PDF viewer document-info callback |
| Task queue | Board; active sprint label only when present; live/snapshot state | Actual `TaskBoardItem.phase`, `blockedQuestion`, `requestedStatus`, and `updatedAt` pulse counts | Existing task board projection |

## Responsive rule derived from the source

The source declares no responsive breakpoint or mobile rearrangement. The card header/footer remain fixed at 42px/28px and one line; flexible context is the first content to ellipsize, while name, state/task chips, and 28px action targets stay intact. The board remains a panning canvas at 375px, 768px, and 1440px viewport widths; card geometry is unchanged. This preserves the prototype's layout without inventing a new mobile card design.

# Fila V3 + detalhe da task — spec from approved prototypes

Sources: `Fila.dc.html`, `Main.dc.html`, `Review.dc.html`, `Superseded.dc.html` (inline CSS + `style="…"`), notes in `canvas.json` (n1–n4), rules in `DADOS.md` §§3–6. Card chrome stays V2 (`CardFrame` 42/28). Values below are literal from the prototypes unless noted.

## Card Fila (tela 4) — 1440×860 preview body

| Element | Exact text / content | Font | Colors | Size / layout | Radius, gap, states |
|---|---|---|---|---|---|
| Card shell | Fila body (chrome via CardFrame) | Space Grotesk | text `#e8eaf0` / board `#0b0d12` / border `#1d2230` | flex column; overflow hidden | 14px radius in proto; app uses CardFrame 12px |
| Filter chips | `Tudo N` · `Precisa de você N` · `Com agente vivo N` | 13px | idle `#a3aabb` / border `#2a2f3d`; on `#e8eaf0` / bg `#1d2333` / border `#3b4570`; needs count `#f0b25c` | height 30px; pad `0 12px`; gap 6px | radius 8px; hover border `#3a4258` |
| Needs-you strip | Question / approval cards | 12px title; 13.5px body | question border `#5a3d17` bg `#1f170d` title `#f0b25c`; review border `#27305a` bg `#131829` title `#a9b8ff` | grid 3 cols; margin `12px 18px 0`; gap 10px; pad `10px 12px` | radius 12px; gap 8px inside |
| Columns row | Esperando · Pronta · Rodando · Revisão · Concluída + rails | — | — | flex; gap 12px; pad `12px 18px 16px`; overflow-x auto; **never wrap to 2 rows** | min-width 220–240px per column |
| Column header | title + count (+ `deps ou você` / `hoje N`) | 13.5px/600 title; 12.5px count; 11.5px hint | dots: waiting `#8d94a6`, ready `#c9cede`, running `#7d8cff`, review `#f0a43e`, done `#3fb68b`, fail `#e5534b`; count `#8d94a6` | flex; gap 8px; 8×8 square marker | — |
| Tile | `#id` + type (+ time/round); title; ONE status phrase; gates when present; live + bar when working | mono 12px id; 11.5px type; 14px title; 12.5px phrase | border `#1f2433` bg `#11141c`; hover `#343c55`/`#141823`; running border `#2b3460`; review `#4a3618` | pad 12px; gap 9px; flex column | radius 12px |
| Type chip | `pergunta` / purpose short | 11.5px | pergunta `#f0b25c`/`#2a1d10`; implementar `#c3cbff`/`#1d2333`; corrigir `#f2a093`/`#2c1a1a`; investigar `#8fdcc0`/`#14302a` | pad `2px 7px` | radius 6px |
| Live + bar | only with live working agent | — | `#7d8cff`; bar track `#1d2230` | live 8×8; bar height 3px; fill 40% width | pulse 1.6s; slide 1.4s; **none** under `prefers-reduced-motion` |
| Collapsed rail | Falhas / Substituídas + count | 13px vertical | border `#1d2230` bg `#0c0f15`; text `#a3aabb` | width 44px; pad `12px 0`; gap 10px | radius 12px |
| Done tile | compact `#id` + title + ✓ phrase | 13.5 / 12px | opacity 0.85; phrase `#8fdcc0` | pad `10px 12px`; gap 6px | — |
| Footer pulse | `N agentes trabalhando` · review · needs · updated | 12.5px | muted `#8d94a6`; needs `#f0b25c`; live `#7d8cff` | flex; gap 16px; pad `10px 18px` — **via CardFrame footer 28px** | — |

## Detalhe (telas 1–3) — dialog 1120×736 inside 1200×800

| Element | Content | Font | Colors | Layout |
|---|---|---|---|---|
| Dialog | modal | Space Grotesk | bg `#0f1218` border `#262b3a` | radius 16px; flex column |
| Top meta | `#id` · type pill · sprint pill · Ações · close | mono 13px id; 12px pills | id `#8d94a6`; type `#c3cbff`/`#1d2333`; sprint `#9fd3c2`/`#1a2430` | pad `18px 24px 14px`; gap 10px |
| Title | task title | 21px/600 | `#e8eaf0` | line-height 1.3 |
| Phase trail | Pronta → Rodando → Relatório → Revisão → Concluída | 12.5px | done `#3fb68b`; current blue `#7d8cff` or amber `#f0a43e` + ring; pending hollow `#3a4258` | flex; connector 28×1 |
| Agora band | state-dependent (DADOS §5) | 14.5/600 + 13px | blue `#141a2b`/`#27305a`; amber `#2a1d10`/`#5a3d17`; neutral `#161922`/`#2a2f3d` | margin `14px 24px 0`; pad `12px 14px`; radius 12px |
| Tabs | Resumo · Contrato · Relatórios · Mudanças · Trilha | 14px; height 40px | idle `#a3aabb`; on `#e8eaf0` + bottom `#7d8cff` 2px | margin `8px 24px 0` |
| Main + aside | tab body + fixed side | section kicker 12px uppercase tracking `.06em` `#8d94a6` | aside bg `#0c0f15` border-left `#1d2230` | aside width 300px |

## Data rules (DADOS.md — decided)

- Column ← phase + blockedQuestion/requestedStatus precedence; running+dead card → Pronta.
- Status phrase ← pure ordered rules; `requestedStatus` tile copy is "Pausada até você liberar" (prototype); never invent activity text.
- Agora ← DADOS §5 variants.
- Precisa de você ← blockedQuestion | requestedStatus | review wanted without reviewer.

## Responsive

Prototypes are desktop-only. Keep CardFrame one-line chrome; columns scroll horizontally (`overflow-x: auto`) so the queue never wraps to two rows at 375/768/1440.

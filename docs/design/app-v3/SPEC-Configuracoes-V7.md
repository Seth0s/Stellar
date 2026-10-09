# Tabela de especificação — Configurações (V7 / tela 14)

**Fonte:** `docs/design/app-v3/prototipo/Configuracoes.dc.html` (HTML + `<style>` + `DCLogic` inteiros).  
**Skill:** `ai/skills/implement-approved-prototype/SKILL.md`.  
**Task:** `4562dc2f-8008-4fb8-9b82-d202e2f127bf`.  
**Escopo:** modal Configurações completo (shell + 11 páginas). Não redesenhar o que o protótipo não mostra.

**Viewport do protótipo:** 1440×900 (canvas); dialog 1280×820.  
**Tipografia base:** `'Space Grotesk', system-ui, sans-serif`; mono: `'JetBrains Mono', monospace`.  
**Cor de texto padrão do canvas:** `#e8eaf0`. Fundo canvas: `#05060a`.

---

## 0. Paleta do protótipo → tokens Stellar

| Papel | Hex protótipo | Token / ação |
|---|---|---|
| Canvas / body bg | `#05060a` | próximo de `--v2-titlebar` `#090b0f`; usar literal se necessário |
| Dialog bg | `#0b0d12` | `--v2-bg` |
| Dialog border | `#262b3a` | próximo `--v2-line-card` `#252a3a` → usar `#262b3a` |
| Nav bg | `#0c0f15` | literal (entre `--v2-sidebar` e field) |
| Nav/header/sec border | `#1d2230` | literal |
| Sec bg | `#0f1218` | `--v2-field` |
| Text/btn/field border | `#2a2f3d` | `--v2-line-input` |
| Nav hover bg | `#161a24` | `--v2-nav-hover` |
| Nav active bg | `#1d2333` | literal (protótipo; não `--v2-nav-active`) |
| Texto | `#e8eaf0` | `--v2-text` |
| Texto muted / hint / `.sh` | `#8d94a6` | `--v2-text-5` |
| Nav idle | `#a3aabb` | `--v2-text-3` |
| Primary | `#4a5fe0` | `--v2-primary` |
| Link | `#a9b8ff` / hover `#d3dbff` | `--v2-link` / claro |
| Pill ok bg/fg | `#14302a` / `#8fdcc0` | literal (team/good vizinho) |
| Pill info bg/fg | `#1d2333` / `#c3cbff` | literal |
| Pill warn bg/fg | `#2a1d10` / `#f0b25c` | literal |
| Pill danger bg/fg | `#3a1c18` / `#f2a093` | literal |
| Switch off track | `#2a2f3d` | `--v2-line-input` |
| Switch off knob | `#8d94a6` | `--v2-text-5` |
| Switch on track | `#4a5fe0` | `--v2-primary` |
| Switch on knob | `#fff` | `--v2-bright` |
| Preset border | `#232838` | `--v2-line-mid` |
| Preset hover/atual border | `#3b4570` / `#5a6be0` | literais |
| Preset atual bg | `#121730` | literal |
| Conflict text | `#f0b25c` | literal |
| Field/preset/textarea bg | `#0c0f15` | = nav bg |
| Textarea text | `#d6dae6` | próximo `--v2-text-2b` |
| Kbd border | `#2f3546` | literal |
| Kbd bg | `#12151d` | `--v2-card` |
| Avatar conta bg/fg | `#1a2040` / `#c3cbff` | literal |
| Dot genérico | `#3a4258` / radius 2px | literal |
| Btn hover border | `#3a4258` | literal |

---

## 1. Shell — dialog

| Campo | Valor |
|---|---|
| Elemento | `section[role=dialog][aria-modal=true][aria-labelledby=cfg]` |
| Layout | `display:flex; overflow:hidden` |
| Size | `width:1280px; height:820px` (no app: `min(1280px, 96vw)` × `min(820px, 90vh)`) |
| Radius | `16px` |
| Background | `#0b0d12` |
| Border | `1px solid #262b3a` |
| Responsivo | &lt;768: dialog full-bleed (`width:100%; height:100%; border-radius:0`); nav vira drawer ou topo scrollável; ≥768: layout duas colunas |

---

## 2. Shell — nav lateral

| Campo | Valor |
|---|---|
| Elemento | `nav[aria-label="Seções"]` |
| Size | `width:260px; flex:none` |
| Border | `border-right:1px solid #1d2230` |
| Background | `#0c0f15` |
| Padding | `18px 12px` |
| Gap | `4px` |
| Overflow | `overflow-y:auto` |
| Layout | `flex-direction:column` |

### 2.1 Título `h1#cfg`

| Campo | Valor |
|---|---|
| Texto | `Configurações` |
| Margin | `0 10px 12px` |
| Font | `18px` / weight `600` / cor `#e8eaf0` |

### 2.2 Busca

| Campo | Valor |
|---|---|
| Container | `label` flex, `align-items:center`, `gap:8px`, `height:34px`, `padding:0 10px`, `margin:0 0 10px`, `border:1px solid #2a2f3d`, `border-radius:8px` |
| Ícone | SVG 13×13, stroke `#8d94a6`, stroke-width 1.5 (lupa) |
| Input | `aria-label` + `placeholder` = `Buscar configuração`; `font-size:13px`; `color:#e8eaf0`; `border:0; background:transparent; outline:none; flex:1` |
| Comportamento | filtra itens das duas seções por label/tokens; estado “busca ativa” deve aparecer nos screenshots |

### 2.3 Cabeçalhos de seção `.sh`

| Campo | Valor |
|---|---|
| Classe | `.sh`: `margin:0; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:#8d94a6` |
| Aplicativo | padding `6px 10px`; texto `Aplicativo` |
| Este board | padding `14px 10px 6px`; texto `Este board · {boardId|name}` (protótipo: `Este board · 64`) |

### 2.4 Item de nav `.nav` / `.navOn`

| Campo | Valor |
|---|---|
| Layout | flex, `align-items:center`, `gap:10px`, `width:100%`, `min-height:38px`, `padding:0 10px` |
| Chrome | `border:0; border-radius:9px; background:transparent` |
| Font | `13.5px`, `text-align:left`, `color:#a3aabb` |
| Hover | `background:#161a24; color:#e8eaf0` |
| Ativo `.navOn` | `background:#1d2333; color:#e8eaf0` |
| Badge `.new` | texto `novo`; `font-size:10.5px; padding:1px 6px; border-radius:5px; background:#14302a; color:#8fdcc0; margin-left:auto` |
| Ordem Aplicativo | Conta e planoᵃ, Providers, Atalhos, Chaves de API, Dispositivos, Aparênciaᵃ, Desempenhoᵃ, Sobre |
| Ordem Este board | Modo de trabalho, Regras e gatesᵃ, Timeᵃ |
| ᵃ isNew=true | badge `novo` |

### 2.5 JS — escopo do chip (header)

| Página em board? | Texto scope |
|---|---|
| Não | `vale para o app inteiro` |
| Sim | `vale só para o board {id}` (protótipo: `vale só para o board 64`) |

Subtitles (exatos do JS):

| id | title | subtitle |
|---|---|---|
| conta | Conta e plano | quem você é, o plano e a casa de trabalho |
| providers | Providers | os CLIs que rodam nos cards, com a cota de cada um |
| atalhos | Atalhos | ver e trocar teclas |
| chaves | Chaves de API | para chat e ações de IA |
| disp | Dispositivos | máquinas da conta e celular |
| aparencia | Aparência | idioma, texto e movimento |
| desempenho | Desempenho | o que o app faz para economizar e o consumo agora |
| sobre | Sobre | versão, atualização e documentos |
| modo | Modo de trabalho | preset e ajustes padrão das tasks |
| regras | Regras e gates | o que todo agente recebe e como os gates rodam |
| time | Time | ligação deste board com o time |

Default page no protótipo: `conta`.

---

## 3. Shell — main header

| Campo | Valor |
|---|---|
| Padding | `18px 24px 14px` |
| Border | `border-bottom:1px solid #1d2230` |
| Layout | flex, `align-items:center`, `gap:12px` |
| Título `h2` | `18px` / `600` / margin 0 |
| Subtitle | `.hint` sob o título, gap 2px na coluna |
| Scope | `.hint` à direita (após spacer flex:1) |
| Fechar | `.btn`, `width:34px`, `padding:0`, ícone X 12×12 stroke 1.6; `aria-label="Fechar"` |

### 3.1 Área de conteúdo

| Campo | Valor |
|---|---|
| Padding | `18px 24px 24px` |
| Gap | `14px` |
| Layout | column flex; `overflow-y:auto; flex:1; min-height:0` |

**Sem footer “Fechar” grande** no protótipo — só o X do header.

---

## 4. Primitivos reutilizados (todas as páginas)

### `.sec` (card de seção)

`border:1px solid #1d2230; border-radius:12px; background:#0f1218; padding:16px; display:flex; flex-direction:column; gap:12px`

### `.row`

`display:flex; align-items:center; gap:12px; min-height:40px`

### `.lbl`

`flex:1; display:flex; flex-direction:column; gap:2px; font-size:14px`  
Filho principal = label; `.hint` = descrição.

### `.hint`

`font-size:12.5px; color:#8d94a6`

### `.btn`

`min-height:34px; padding:0 12px; border-radius:8px; border:1px solid #2a2f3d; background:#161a24; color:#e8eaf0; font-size:13px; inline-flex; gap:6px; white-space:nowrap`  
Hover: `border-color:#3a4258`  
`.primary`: `background/border #4a5fe0; color:#fff; font-weight:600`

### `.field`

`min-height:36px; padding:0 10px; border-radius:8px; border:1px solid #2a2f3d; background:#0c0f15; color:#e8eaf0; font-size:13.5px`

### `.sw` (switch)

`width:38px; height:22px; border-radius:999px; border:0; position:relative; flex:none`  
Knob: `16×16`, `border-radius:50%`, `top:3px`  
Off: track `#2a2f3d`, knob `left:3px` `#8d94a6`, `aria-pressed=false`  
On: track `#4a5fe0`, knob `left:19px` `#fff`, `aria-pressed=true`

### `.pill`

`font-size:11.5px; padding:2px 8px; border-radius:999px; white-space:nowrap`

### `.preset`

`flex:1; border:1px solid #232838; border-radius:12px; padding:14px; flex-column; gap:6px; background:#0c0f15; cursor:pointer; text-align:left; color:#e8eaf0`  
Hover: `border-color:#3b4570`  
Selecionado/atual: `border-color:#5a6be0; background:#121730`

### `.kbd`

`inline-grid; place-items:center; min-width:20px; height:20px; padding:0 5px; border-radius:5px; border:1px solid #2f3546; border-bottom-width:2px; background:#12151d; font:500 11px JetBrains Mono; color:#e8eaf0`

### Links

`a { color:#a9b8ff; text-decoration:none }` hover `#d3dbff`

---

## 5. Página Conta e plano (`pConta`)

### Sec 1 — identidade

| Elemento | Spec |
|---|---|
| Avatar | 44×44, radius 12, bg `#1a2040`, fg `#c3cbff`, grid center, weight 600, iniciais |
| Nome | `.lbl` span (dado: displayName da conta) |
| Hint | email/identidades ligadas |
| Botão | `Sair` `.btn` |

### Sec 2 — Plano (`h3.sh` = `Plano`)

| Row | Spec |
|---|---|
| Plano | nome + pill `ativo` (`#14302a/#8fdcc0`); hint benefícios/renovação; CTA `Ver planos` (link `.btn`) |
| Origem time | nome do time + hint vagas; pill `origem: time` (`#1d2333/#c3cbff`) |

### Sec 3 — Casa de trabalho

| Row | Spec |
|---|---|
| Perfil ativo | label + hint skills/…/última sync; botões `Sincronizar agora`, `Abrir a casa` |

**Dados:** `cloud.status`, `workhome.status` / sync. Sem login: estado vazio honesto (não inventar “Lucas Sabino”).

---

## 6. Página Providers (`pProviders`)

### Sec Nativos

| Elemento | Spec |
|---|---|
| Header row | `h3.sh` “Nativos do app” flex:1 + hint “cota lida do próprio CLI” |
| Linha provider | dot 10×10 circle + `.lbl` (nome + hint MCP/modelo) + pill cota + `.btn` “Padrões” |
| Cores dot (ex.) | Claude `#f0883e`; Antigravity `#5b8cff`; Command Code `#e85d9b`; Codex `#8d94a6` |

### Sec Genéricos

| Elemento | Spec |
|---|---|
| Header | `h3.sh` “Genéricos (CLIs que você cadastrou)” + `.btn.primary` “+ Adicionar provider” |
| Linha | dot 10×10 **radius 2px** bg `#3a4258` + lbl mono hint + `Editar` |
| Rodapé | hint com link mono do `providers.json` |

**Dados:** ProvidersPage existente + ProviderUsageBadge (cota). Visual das rows deve seguir `.sec/.row/.lbl/.pill/.btn`, não o layout antigo se divergir.

---

## 7. Página Atalhos (`pAtalhos`)

| Elemento | Spec |
|---|---|
| Intro row | “Todos os atalhos, por lugar” + hint com `.kbd` `?` + link/btn “Abrir a lista” |
| Linhas exemplo | label + hint escopo + grupo de `.kbd` gap 3px + `Trocar` |
| Aviso conflito | row `color:#f0b25c; font-size:13px` — texto: *Ao trocar, a tecla é recusada se já estiver em uso no mesmo lugar, e o conflito aparece aqui.* |
| Restore | `Voltar todos ao padrão` `.btn` |

**Comportamento:** rebind com conflito no mesmo escopo (já existe em `evaluateRebindCandidate` / ShortcutsOverlay). Screenshot obrigatório do estado de conflito.  
Implementação pode embutir ShortcutsOverlay **dentro** de `.sec` com os primitivos acima (não chrome antigo do modal).

---

## 8. Página Chaves de API (`pChaves`)

| Elemento | Spec |
|---|---|
| `h3.sh` | `Chaves de API` |
| Hint | “Guardadas no chaveiro do sistema…” |
| Row com chave | nome + hint mono mascarado + `Trocar` + `Remover` |
| Row sem chave | hint “não configurada” + `Adicionar` |

**Dados:** SecretsSettingsModal / secrets IPC — restyle ao shell.

---

## 9. Página Dispositivos (`pDisp`)

### Sec Esta máquina

| Elemento | Spec |
|---|---|
| `h3.sh` | `Esta máquina` |
| Esta | label hostname + hint OS/data; pill `esta` ok |
| Outra | label + hint; `Desconectar` |

### Sec Celular

| Elemento | Spec |
|---|---|
| `h3.sh` | `Celular` |
| Row | “Parear um celular” + hint Pro; pill `em breve` info (`#1d2333/#c3cbff`) — **não** oferecer pareamento falso |

**Dados:** `cloud.devices` + RemotePairingModal content restyled; celular = “em breve”.

---

## 10. Página Aparência (`pAparencia`)

Uma `.sec` com 3 rows:

| Label | Controle | Spec |
|---|---|---|
| Idioma | `select.field` | hint “detectado do sistema…”; opções pt-BR / en (+ system se o app já tiver) |
| Tamanho do texto nos terminais | `select.field` | opções 13/14/15 px no protótipo |
| Reduzir movimento | `.sw` off por padrão | hint “desliga pulsos…” |

**Gap de dado:** preferência global de font-size do terminal e reduce-motion persistido podem não existir no main — se não der para implementar pequeno, controle visual conforme protótipo + persistência mínima (prefs) ou leitura com nota na lista de diferenças (não omitir o controle).

---

## 11. Página Desempenho (`pDesempenho`)

### Sec “O que o app faz para economizar”

| Label | Controle |
|---|---|
| Sessão viva em segundo plano | `.sw` on |
| Navegador sem uso | `select.field`: 4 fps / 8 fps / pausar |
| Histórico guardado por terminal | `select.field`: 2 MB / 5 MB / 512 KB |

### Sec “Agora”

| Label | Spec |
|---|---|
| Stellar | hint com % CPU/GPU/RAM (dado real se existir; senão métrica disponível: background sessions) + `Detalhes por card` |

**Gap:** fps/scrollback hoje via constantes/env — se write no main for grande, UI igual + persistência env/prefs pequena, ou read-only justificado na lista de diferenças **sem** remover o layout.

---

## 12. Página Sobre (`pSobre`)

Uma `.sec`:

| Row | Spec |
|---|---|
| Identidade | ícone 44×44 (mark Stellar) + `Stellar {version}` + hint mono `build …` + `.btn.primary` `Procurar atualização` |
| Relay | “Relay do MCP” + hint + pill `ativo` ok |
| Links | `Notas da versão` · `Termos` · `Privacidade` · `Abrir a pasta de dados` (estilo `a`) |

**Dados:** `system.getBuildIdentity`, `updater.check`, relay default on. Idioma **sai** desta página (foi para Aparência).

---

## 13. Página Modo de trabalho (`pModo`) = Maestro + Agentes

| Elemento | Spec |
|---|---|
| Intro | `.hint`: “Três jeitos de trabalhar. Escolher um mostra o que muda antes de aplicar.” |
| Presets row | flex `gap:12px`; 3 `.preset` (Junto / Orquestrado / Autônomo) — labels/hints do protótipo; atual com border `#5a6be0`, bg `#121730`, pill `atual` (`#27305a/#c3cbff`) |
| Sec ajustes | `h3.sh` “Os ajustes deste board” |
| Modo autônomo | `.sw` |
| Agentes ao mesmo tempo | `input.field` width 70px |
| Revisão por padrão | `select.field` |
| Commit por padrão | `select.field` |
| Campos do relatório | hint mono schema (read-only no protótipo) |

**Dados:** board presets + autonomous + concurrency_cap + defaults (já no app). Diff antes de aplicar (já existe) deve caber no layout.

---

## 14. Página Regras e gates (`pRegras`)

### Sec regras

| Elemento | Spec |
|---|---|
| Header | `h3.sh` flex:1 “Regras que todo agente deste board recebe” + hint “vão no começo de cada brief” |
| Textarea | `min-height:150px; padding:12px; border-radius:10px; border:1px solid #2a2f3d; background:#0c0f15; color:#d6dae6; font:13px/1.6 JetBrains Mono; resize:vertical` |

### Sec Gates

| Elemento | Spec |
|---|---|
| Isolamento | `.sw` on + hint cópia isolada |
| Tool paths | hint mono path + `.btn` `+ Pasta` |

### Sec Orquestrador

| Elemento | Spec |
|---|---|
| Select | `.field` com cards / `nenhum` |

**Dados:** board-context IPC (rules, gateToolPaths); `store.boards.setOrchestratorCard`. Isolamento: se não houver flag desligável, switch visual on + comportamento real dos gates (listar na lista de diferenças se não for toggle persistido).

---

## 15. Página Time (`pTime`)

Uma `.sec`, 2 rows:

| Label | Controle |
|---|---|
| Ligado ao time … | `Abrir o painel do time` `.btn` |
| Casa de trabalho do time | `.sw` on + hint |

**Dados:** team/cloud APIs existentes; sem time → estado vazio honesto.

---

## 16. Interações / estados a provar em screenshot

1. Cada uma das 11 páginas (default Conta).  
2. Busca ativa filtrando nav.  
3. Atalhos: conflito de tecla no mesmo escopo (`#f0b25c`).  
4. Preset selecionado com diff (Modo).  
5. Switch on/off (Aparência reduce motion off; outros on conforme protótipo).  
6. Lado a lado protótipo × implementação, **mesmo viewport** (1440×900 ou dialog 1280×820).  
7. Responsivo: 375, 768, 1440 (pelo menos shell + uma página).

---

## 17. O que NÃO fazer

- Não recriar página Segurança/cifra (cancelada).  
- Não adicionar footer “Fechar” se o protótipo só tem X.  
- Não manter nav antiga (Providers primeiro sem Conta; Maestro/Agentes separados) — a ordem do JS manda.  
- Não “aproximar” raios/gaps: 9 nav, 12 sec, 16 dialog, gaps 4/12/14 conforme tabela.

---

## 18. Fontes de dados (checklist)

| UI | Fonte |
|---|---|
| Conta | `window.cloud.status` |
| Plano | `status.plan` / rights |
| Casa | `window.workhome` |
| Providers + cota | providers page + `providerUsage` |
| Atalhos | shortcut-registry + shortcut-config |
| Chaves | `window.secrets` |
| Dispositivos | `cloud.devices` + remote |
| Aparência locale | `window.i18n` |
| Desempenho agora | `store.boardBackgroundStatus` (+ env caps) |
| Sobre | `system.getBuildIdentity`, `updater` |
| Modo | presets + board fields |
| Regras/gates | `store.boardContext` + orchestrator |
| Time | team APIs / shell navigation |

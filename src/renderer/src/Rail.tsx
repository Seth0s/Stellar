import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { Popover } from "./Popover";
import { PenPanel } from "./PenPanel";
import { ProviderPicker } from "./ProviderPicker";
import { CARD_ICON, RAIL_CREATE_ORDER, RAIL_CREATE_TITLE } from "./cards/registry";
import type { Tool } from "./card-types";
import { PROVIDER_EFFORT_VALUES } from "./card-types";

type RailCard = { id: string; kind: string; label: string | null };

const RAIL_COLLAPSED_KEY = "ac.railCollapsed";

/** Item 3 — collapsed rail becomes a mini-rail showing the active tool's
 * icon (RadialMenu.tsx/App.tsx already track `Tool` as this same union;
 * duplicated here rather than imported to keep this a plain, local
 * lookup — Rail.tsx already receives `tool` as a prop, no new plumbing). */
const TOOL_ICON: Record<Tool, IconName> = {
  pointer: "pointer",
  pen: "pen",
  connector: "link",
  select: "select",
  export: "exportCrop",
};

const CARD_DESCRIPTIONS: Record<string, string> = {
  terminal: "Shell local ou agente CLI autônomo",
  files: "Navegação na árvore do projeto e edição de código",
  changes: "Status do repositório git, branch e diffs",
  sticky: "Anotações rápidas, lembretes e notas",
  browser: "Navegador web embutido com snapshots",
  chat: "Assistente conversacional com ferramentas integradas",
  "remote-window": "Espelhamento e controle de janela externa",
  // DESIGN-BACKLOG.md §2.1 "Card `task`", Fase 2 peça 1.
  task: "Quadro de tasks — a fazer, em andamento, concluído, falhou",
};

export function Rail({
  tool,
  setTool,
  strokeColors,
  strokeColor,
  setStrokeColor,
  strokeWidth,
  setStrokeWidth,
  strokeStyle,
  setStrokeStyle,
  canGroup,
  canUngroup,
  onGroup,
  onUngroup,
  providers,
  newProvider,
  setNewProvider,
  newResumeId,
  setNewResumeId,
  newContinueLast,
  setNewContinueLast,
  newModel,
  setNewModel,
  newEffort,
  setNewEffort,
  newSystemPrompt,
  setNewSystemPrompt,
  onCreateTerminal,
  onCreate,
  aiBusy,
  summarizeDisabled,
  onReorganize,
  onSummarize,
  cards,
  kindIcon,
  kindLabel,
  onJumpToCard,
  onOpenSecretsSettings,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  strokeColors: readonly string[];
  strokeColor: string;
  setStrokeColor: (c: string) => void;
  strokeWidth: number;
  setStrokeWidth: (w: number) => void;
  strokeStyle: "solid" | "marker";
  setStrokeStyle: (s: "solid" | "marker") => void;
  canGroup: boolean;
  canUngroup: boolean;
  onGroup: () => void;
  onUngroup: () => void;
  providers: string[];
  newProvider: string;
  setNewProvider: (p: string) => void;
  newResumeId: string;
  setNewResumeId: (v: string) => void;
  newContinueLast: boolean;
  setNewContinueLast: (v: boolean) => void;
  newModel: string;
  setNewModel: (v: string) => void;
  newEffort: string;
  setNewEffort: (v: string) => void;
  newSystemPrompt: string;
  setNewSystemPrompt: (v: string) => void;
  onCreateTerminal: () => void;
  onCreate: (kind: (typeof RAIL_CREATE_ORDER)[number]) => void;
  aiBusy: boolean;
  summarizeDisabled: boolean;
  onReorganize: () => void;
  onSummarize: () => void;
  cards: RailCard[];
  kindIcon: Record<string, IconName>;
  kindLabel: Record<string, string>;
  onJumpToCard: (id: string) => void;
  onOpenSecretsSettings: () => void;
}) {
  const [openPopover, setOpenPopover] = useState<"cards" | "terminal-config" | "ai" | "find" | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1");
  const addCardBtnRef = useRef<HTMLButtonElement>(null);
  const aiBtnRef = useRef<HTMLButtonElement>(null);
  const findBtnRef = useRef<HTMLButtonElement>(null);
  const penBtnRef = useRef<HTMLButtonElement>(null);

  const showAgentFields = newProvider !== "bash";

  useEffect(() => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  function toggleTool(next: Tool) {
    setTool(tool === next ? "pointer" : next);
  }

  const isAddCardOpen = openPopover === "cards" || openPopover === "terminal-config";

  return (
    <div
      className={`rail-container${collapsed ? " is-collapsed" : ""}`}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <button
        className={`rail-toggle${collapsed ? " is-collapsed" : ""}`}
        title={collapsed ? "Mostrar barra lateral" : "Ocultar barra lateral"}
        aria-label={collapsed ? "Mostrar barra lateral" : "Ocultar barra lateral"}
        onClick={() => setCollapsed((c) => !c)}
      >
        <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={14} />
      </button>

      {/* Item 3 — collapsed rail used to just vanish (`.rail`'s own
         translateX+opacity below) leaving only the sliver `.rail-toggle`
         chevron, which also hid which tool was active. This crossfades in
         at the same spot the full `.rail` slides out of (both
         `position: absolute` inside `.rail-container`, so neither affects
         the container's box — no canvas layout jump), showing the active
         tool so the user isn't left guessing pointer vs. pen. A full
         click target on its own (comfortably bigger than the thin
         `.rail-toggle`), separate from the chevron above. */}
      <button
        className="rail-mini"
        title={`Ferramenta ativa: ${tool} — clique para mostrar a barra lateral`}
        aria-label="Mostrar barra lateral"
        onClick={() => setCollapsed(false)}
      >
        <Icon name={TOOL_ICON[tool]} size={18} />
      </button>

      <div className="rail" aria-label="Barra de ferramentas">
        {/* Grupo 1: Ferramentas de manipulação do canvas */}
        <button
          className={`rail-btn${tool === "pointer" ? " active" : ""}`}
          title="Ponteiro (V)"
          aria-label="Ponteiro (V)"
          onClick={() => setTool("pointer")}
        >
          <Icon name="pointer" />
        </button>
        <button
          ref={penBtnRef}
          className={`rail-btn${tool === "pen" ? " active" : ""}`}
          title="Caneta (P)"
          aria-label="Caneta (P)"
          onClick={() => toggleTool("pen")}
        >
          <Icon name="pen" />
        </button>
        <button
          className={`rail-btn${tool === "connector" ? " active" : ""}`}
          title="Conector (C)"
          aria-label="Conector (C)"
          onClick={() => toggleTool("connector")}
        >
          <Icon name="link" />
        </button>
        <button
          className={`rail-btn${tool === "select" ? " active" : ""}`}
          title="Selecionar (S)"
          aria-label="Selecionar (S)"
          onClick={() => toggleTool("select")}
        >
          <Icon name="select" />
        </button>
        <button
          className={`rail-btn${tool === "export" ? " active" : ""}`}
          title="Exportar recorte do canvas"
          aria-label="Exportar recorte do canvas"
          onClick={() => toggleTool("export")}
        >
          <Icon name="exportCrop" />
        </button>

        {tool === "select" && (canGroup || canUngroup) && (
          <>
            {canGroup && (
              <button className="rail-btn" title="Agrupar" aria-label="Agrupar cards selecionados" onClick={onGroup}>
                <Icon name="group" size={16} />
              </button>
            )}
            {canUngroup && (
              <button className="rail-btn" title="Desagrupar" aria-label="Desagrupar cards selecionados" onClick={onUngroup}>
                <Icon name="ungroup" size={16} />
              </button>
            )}
          </>
        )}

        <PenPanel
          anchorRef={penBtnRef}
          open={tool === "pen"}
          onClose={() => {}}
          colors={strokeColors}
          color={strokeColor}
          setColor={setStrokeColor}
          width={strokeWidth}
          setWidth={setStrokeWidth}
          style={strokeStyle}
          setStyle={setStrokeStyle}
        />

        <div className="rail-divider" />

        {/* Grupo 2: Botão único para Adicionar Cards / Ferramentas */}
        <button
          ref={addCardBtnRef}
          className={`rail-btn${isAddCardOpen ? " active" : ""}`}
          data-role="rail-add-card"
          title="Adicionar card"
          aria-label="Adicionar card"
          onClick={() => setOpenPopover((p) => (p === "cards" || p === "terminal-config" ? null : "cards"))}
        >
          <Icon name="plus" />
        </button>

        <div className="rail-divider" />

        {/* Grupo 3: Ações e utilitários do board */}
        <button
          ref={findBtnRef}
          className={`rail-btn${openPopover === "find" ? " active" : ""}`}
          title="Localizar card"
          aria-label="Localizar card"
          onClick={() => setOpenPopover((p) => (p === "find" ? null : "find"))}
        >
          <Icon name="findCard" />
        </button>
        <button
          ref={aiBtnRef}
          className={`rail-btn${openPopover === "ai" ? " active" : ""}`}
          title="Ações de IA"
          aria-label="Ações de IA"
          onClick={() => setOpenPopover((p) => (p === "ai" ? null : "ai"))}
        >
          <Icon name="sparkle" />
        </button>
        <button className="rail-btn" title="Configurações" aria-label="Configurações de chaves e segredos" onClick={onOpenSecretsSettings}>
          <Icon name="settings" />
        </button>

        {/* Popover agrupado: Adicionar Cards / Ferramentas */}
        <Popover
          anchorRef={addCardBtnRef}
          open={isAddCardOpen}
          onClose={() => setOpenPopover(null)}
        >
          {openPopover === "cards" && (
            <>
              <div className="board-list-heading">ADICIONAR AO CANVAS</div>
              <div className="board-list" style={{ maxHeight: "min(60vh, 380px)" }}>
                {/* Terminal */}
                <button
                  className="popover-row"
                  data-kind="terminal"
                  title="Novo terminal"
                  onClick={() => setOpenPopover("terminal-config")}
                >
                  <span className="popover-row-icon">
                    <Icon name="terminal" size={18} />
                  </span>
                  <span>
                    <span className="popover-row-title">Terminal</span>
                    <span className="popover-row-desc">{CARD_DESCRIPTIONS.terminal}</span>
                  </span>
                </button>

                {/* Cards adicionais ordenados */}
                {RAIL_CREATE_ORDER.map((kind) => {
                  const title =
                    kind === "files"
                      ? "Explorador de Arquivos"
                      : kind === "chat"
                      ? "Chatbox IA"
                      : kind === "browser"
                      ? "Navegador Web"
                      : kind === "changes"
                      ? "Git / Mudanças"
                      : kind === "sticky"
                      ? "Nota Adesiva"
                      : kind === "remote-window"
                      ? "Janela Externa"
                      : kind === "task"
                      ? "Fila"
                      : kind;
                  return (
                    <button
                      key={kind}
                      className="popover-row"
                      data-kind={kind}
                      title={RAIL_CREATE_TITLE[kind]}
                      onClick={() => {
                        onCreate(kind);
                        setOpenPopover(null);
                      }}
                    >
                      <span className="popover-row-icon">
                        <Icon name={CARD_ICON[kind]} size={18} />
                      </span>
                      <span>
                        <span className="popover-row-title">{title}</span>
                        <span className="popover-row-desc">{CARD_DESCRIPTIONS[kind]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {openPopover === "terminal-config" && (
            <>
              <div className="popover-header-with-back">
                <button
                  className="popover-back-btn"
                  onClick={() => setOpenPopover("cards")}
                  title="Voltar para lista de cards"
                >
                  <Icon name="back" size={14} />
                </button>
                <div className="board-list-heading" style={{ margin: 0 }}>
                  NOVO TERMINAL
                </div>
              </div>

              <div className="popover-field">
                <label>provider</label>
                <ProviderPicker providers={providers} value={newProvider} onChange={setNewProvider} />
              </div>

              {showAgentFields && (
                <>
                  <div className="popover-field">
                    <label>resume id (opcional)</label>
                    <input
                      className="resume-input"
                      value={newResumeId}
                      disabled={newContinueLast}
                      onChange={(e) => {
                        setNewResumeId(e.target.value);
                        if (e.target.value.trim()) setNewContinueLast(false);
                      }}
                    />
                  </div>
                  <label className="continue-last-label">
                    <input
                      type="checkbox"
                      checked={newContinueLast}
                      disabled={newResumeId.trim() !== ""}
                      onChange={(e) => setNewContinueLast(e.target.checked)}
                    />
                    continuar última
                  </label>
                  <div className="popover-field">
                    <label>model (opcional)</label>
                    <input className="resume-input" value={newModel} onChange={(e) => setNewModel(e.target.value)} />
                  </div>
                  {/* DESIGN-BACKLOG.md §2.1 "effort do card não é
                      persistido", 2026-09-10 — only offered for providers
                      that actually read `--effort` (PROVIDER_EFFORT_VALUES,
                      confirmed live per provider, not guessed). The select
                      only ever lists values that provider accepts, so this
                      popover structurally can't hand a value the app
                      already knows would be refused (message-bus.ts's
                      spawn_agent handler enforces the same antigravity
                      range for agent-driven spawns, which never go through
                      this UI). */}
                  {PROVIDER_EFFORT_VALUES[newProvider] && (
                    <div className="popover-field">
                      <label>effort (opcional)</label>
                      <select className="resume-input" value={newEffort} onChange={(e) => setNewEffort(e.target.value)}>
                        <option value="">(padrão do provider)</option>
                        {PROVIDER_EFFORT_VALUES[newProvider].map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {newProvider === "claude" && (
                    <div className="popover-field">
                      <label>system prompt (opcional)</label>
                      <input
                        className="resume-input"
                        value={newSystemPrompt}
                        onChange={(e) => setNewSystemPrompt(e.target.value)}
                      />
                    </div>
                  )}
                </>
              )}

              <div className="popover-actions">
                <button
                  className="primary"
                  onClick={() => {
                    onCreateTerminal();
                    setOpenPopover(null);
                  }}
                >
                  Criar terminal
                </button>
              </div>
            </>
          )}
        </Popover>

        {/* Popover: Localizar card */}
        <Popover anchorRef={findBtnRef} open={openPopover === "find"} onClose={() => setOpenPopover(null)}>
          <div className="board-list-heading">CARDS NESTA SESSÃO</div>
          {cards.length === 0 ? (
            <div className="popover-empty">nenhum card ainda</div>
          ) : (
            <div className="board-list">
              {cards.map((c) => (
                <button
                  key={c.id}
                  className="board-row-name find-card-row"
                  onClick={() => {
                    onJumpToCard(c.id);
                    setOpenPopover(null);
                  }}
                >
                  <span className="board-row-name-line">
                    <Icon name={kindIcon[c.kind] ?? "terminal"} size={14} />
                    {c.label ?? kindLabel[c.kind] ?? c.kind}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Popover>

        {/* Popover: Ações de IA */}
        <Popover anchorRef={aiBtnRef} open={openPopover === "ai"} onClose={() => setOpenPopover(null)}>
          <button
            className="popover-row"
            onClick={() => {
              onReorganize();
              setOpenPopover(null);
            }}
          >
            <span className="popover-row-icon">
              <Icon name="reorganize" size={18} />
            </span>
            <span>
              <span className="popover-row-title">Organizar automaticamente</span>
              <span className="popover-row-desc">Arruma os cards soltos numa grade limpa</span>
            </span>
          </button>
          <button
            className="popover-row"
            disabled={summarizeDisabled || aiBusy}
            onClick={() => {
              onSummarize();
              setOpenPopover(null);
            }}
          >
            <span className="popover-row-icon">
              <Icon name="sparkle" size={18} />
            </span>
            <span>
              <span className="popover-row-title">{aiBusy ? "Resumindo…" : "Resumir sessão numa nota"}</span>
              <span className="popover-row-desc">
                {summarizeDisabled ? "Escolha um provider de agente (não bash)" : "Cria uma nota com o estado do board"}
              </span>
            </span>
          </button>
        </Popover>
      </div>
    </div>
  );
}


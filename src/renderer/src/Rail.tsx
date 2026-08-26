import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { Popover } from "./Popover";
import { PenPanel } from "./PenPanel";
import { ProviderPicker } from "./ProviderPicker";

type Tool = "pointer" | "pen" | "connector" | "select";
type RailCard = { id: string; kind: string; label: string | null };

/** DESIGN-BACKLOG.md item 12, achado 1 — "<"/">" to hide/show the whole
 * rail, not just its individual buttons. Local + persisted (own concern,
 * nothing else reacts to it), same `localStorage` convention as the
 * board/root state elsewhere. */
const RAIL_COLLAPSED_KEY = "ac.railCollapsed";

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
  newSystemPrompt,
  setNewSystemPrompt,
  onCreateTerminal,
  onCreateFiles,
  onCreateChanges,
  onCreateSticky,
  onCreateBrowser,
  onCreateRemoteWindow,
  aiBusy,
  summarizeDisabled,
  onReorganize,
  onSummarize,
  cards,
  kindIcon,
  kindLabel,
  onJumpToCard,
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
  newSystemPrompt: string;
  setNewSystemPrompt: (v: string) => void;
  onCreateTerminal: () => void;
  onCreateFiles: () => void;
  onCreateChanges: () => void;
  onCreateSticky: () => void;
  onCreateBrowser: () => void;
  onCreateRemoteWindow: () => void;
  aiBusy: boolean;
  summarizeDisabled: boolean;
  onReorganize: () => void;
  onSummarize: () => void;
  /** Jump-to-card popover (DESIGN-BACKLOG.md item 7) — every card on the current board. */
  cards: RailCard[];
  kindIcon: Record<string, IconName>;
  kindLabel: Record<string, string>;
  onJumpToCard: (id: string) => void;
}) {
  const [openPopover, setOpenPopover] = useState<"terminal" | "ai" | "find" | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1");
  const terminalBtnRef = useRef<HTMLButtonElement>(null);
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

  if (collapsed) {
    return (
      <div className="rail rail-collapsed">
        <button className="rail-btn" title="Mostrar régua" onClick={() => setCollapsed(false)}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="rail">
      <button className="rail-btn" title="Ocultar régua" onClick={() => setCollapsed(true)}>
        <Icon name="chevronLeft" size={16} />
      </button>
      <div className="rail-group-gap" />
      <button
        className={`rail-btn${tool === "pointer" ? " active" : ""}`}
        title="Ponteiro"
        onClick={() => setTool("pointer")}
      >
        <Icon name="pointer" />
      </button>
      <button
        ref={penBtnRef}
        className={`rail-btn${tool === "pen" ? " active" : ""}`}
        title="Caneta"
        onClick={() => toggleTool("pen")}
      >
        <Icon name="pen" />
      </button>
      <button
        className={`rail-btn${tool === "connector" ? " active" : ""}`}
        title="Conector"
        onClick={() => toggleTool("connector")}
      >
        <Icon name="link" />
      </button>
      <button
        className={`rail-btn${tool === "select" ? " active" : ""}`}
        title="Selecionar"
        onClick={() => toggleTool("select")}
      >
        <Icon name="select" />
      </button>
      {tool === "select" && (canGroup || canUngroup) && (
        <>
          {canGroup && (
            <button className="rail-btn" title="Agrupar" onClick={onGroup}>
              <Icon name="group" size={16} />
            </button>
          )}
          {canUngroup && (
            <button className="rail-btn" title="Desagrupar" onClick={onUngroup}>
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

      <div className="rail-group-gap" />

      <button
        ref={terminalBtnRef}
        className="rail-btn"
        title="Novo terminal"
        onClick={() => setOpenPopover((p) => (p === "terminal" ? null : "terminal"))}
      >
        <Icon name="terminal" />
      </button>
      <button className="rail-btn" title="Nova pasta de arquivos" onClick={onCreateFiles}>
        <Icon name="files" />
      </button>
      <button className="rail-btn" title="Novo card de changes" onClick={onCreateChanges}>
        <Icon name="changes" />
      </button>
      <button className="rail-btn" title="Nova nota adesiva" onClick={onCreateSticky}>
        <Icon name="sticky" />
      </button>
      <button className="rail-btn" title="Novo navegador" onClick={onCreateBrowser}>
        <Icon name="browser" />
      </button>
      <button className="rail-btn" title="Controlar janela externa" onClick={onCreateRemoteWindow}>
        <Icon name="remoteWindow" />
      </button>

      <div className="rail-group-gap" />

      <button
        ref={findBtnRef}
        className="rail-btn"
        title="Localizar card"
        onClick={() => setOpenPopover((p) => (p === "find" ? null : "find"))}
      >
        <Icon name="findCard" />
      </button>
      <button
        ref={aiBtnRef}
        className="rail-btn"
        title="Ações de IA"
        onClick={() => setOpenPopover((p) => (p === "ai" ? null : "ai"))}
      >
        <Icon name="sparkle" />
      </button>

      <Popover anchorRef={terminalBtnRef} open={openPopover === "terminal"} onClose={() => setOpenPopover(null)}>
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
            criar
          </button>
        </div>
      </Popover>

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
  );
}

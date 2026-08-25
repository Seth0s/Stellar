import { useRef, useState } from "react";
import { Icon } from "./icons";
import { Popover } from "./Popover";
import { PenPanel } from "./PenPanel";

type Tool = "pointer" | "pen" | "connector" | "select";

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
  aiBusy,
  summarizeDisabled,
  onReorganize,
  onSummarize,
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
  aiBusy: boolean;
  summarizeDisabled: boolean;
  onReorganize: () => void;
  onSummarize: () => void;
}) {
  const [openPopover, setOpenPopover] = useState<"terminal" | "ai" | null>(null);
  const terminalBtnRef = useRef<HTMLButtonElement>(null);
  const aiBtnRef = useRef<HTMLButtonElement>(null);
  const penBtnRef = useRef<HTMLButtonElement>(null);
  const showAgentFields = newProvider !== "bash";

  function toggleTool(next: Tool) {
    setTool(tool === next ? "pointer" : next);
  }

  return (
    <div className="rail">
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

      <div className="rail-group-gap" />

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
          <select value={newProvider} onChange={(e) => setNewProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
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

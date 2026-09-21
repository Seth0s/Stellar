import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { Popover } from "./Popover";
import { PenPanel } from "./PenPanel";
import { ProviderPicker } from "./ProviderPicker";
import { buildProviderGroups } from "./provider-groups";
import { useAvailableAgentProviders } from "./useAgentAvailability";
import { useProviderClassification } from "./useProviderClassification";
import { CARD_ICON, RAIL_CREATE_ORDER, railCreateTitle } from "./cards/registry";
import type { Tool } from "./card-types";
import { t, type MessageKey } from "../../shared/i18n";

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

const RAIL_TITLE_KEYS: Record<(typeof RAIL_CREATE_ORDER)[number], MessageKey> = {
  files: "rail.title.files",
  changes: "rail.title.changes",
  sticky: "rail.title.sticky",
  browser: "rail.title.browser",
  chat: "rail.title.chat",
  "remote-window": "rail.title.remote-window",
  task: "rail.title.task",
};

const RAIL_DESC_KEYS: Record<(typeof RAIL_CREATE_ORDER)[number] | "terminal" | "media", MessageKey> = {
  terminal: "rail.desc.terminal",
  files: "rail.desc.files",
  changes: "rail.desc.changes",
  sticky: "rail.desc.sticky",
  browser: "rail.desc.browser",
  chat: "rail.desc.chat",
  "remote-window": "rail.desc.remote-window",
  task: "rail.desc.task",
  media: "rail.desc.media",
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
  onCreateMedia,
  aiBusy,
  summarizeDisabled,
  onReorganize,
  onSummarize,
  cards,
  kindIcon,
  kindLabel,
  onJumpToCard,
  onOpenSettings,
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
  /** Media is not in `RAIL_CREATE_ORDER` — opens the OS file dialog first
   * (same "needs input before birth" class as terminal's provider popover). */
  onCreateMedia: () => void;
  aiBusy: boolean;
  summarizeDisabled: boolean;
  onReorganize: () => void;
  onSummarize: () => void;
  cards: RailCard[];
  kindIcon: Record<string, IconName>;
  kindLabel: Record<string, string>;
  onJumpToCard: (id: string) => void;
  onOpenSettings: () => void;
}) {
  // Nativo × genérico: a classificação é do main (ver `useProviderClassification`),
  // e os rótulos/instalados vêm do mesmo canal de disponibilidade que já
  // alimenta `providers` (App.tsx's `useProviderOptions`). Nada é cravado aqui.
  const availableProviders = useAvailableAgentProviders();
  const providerClassification = useProviderClassification();
  const providerGroups = buildProviderGroups({
    orderedIds: providers,
    available: availableProviders,
    dynamicIds: providerClassification.dynamicIds,
    skippedIds: providerClassification.skippedIds,
  });

  const [openPopover, setOpenPopover] = useState<"cards" | "terminal-config" | "ai" | "find" | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1");
  const addCardBtnRef = useRef<HTMLButtonElement>(null);
  const aiBtnRef = useRef<HTMLButtonElement>(null);
  const findBtnRef = useRef<HTMLButtonElement>(null);
  const penBtnRef = useRef<HTMLButtonElement>(null);

  const showAgentFields = newProvider !== "bash";
  // Os valores de esforço DESTE provider, como o main os projetou da própria
  // declaração (`capacity.effort.values` → `AgentAvailability.effortValues`).
  // Vazio = ele não declara esforço, e o campo simplesmente não aparece —
  // nunca um select sem opções. A ORDEM vem da declaração e é a que se vê.
  const effortValues = availableProviders.find((p) => p.id === newProvider)?.effortValues ?? [];

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
        title={collapsed ? t("rail.show") : t("rail.hide")}
        aria-label={collapsed ? t("rail.show") : t("rail.hide")}
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
        title={t("rail.activeTool", { tool })}
        aria-label={t("rail.show")}
        onClick={() => setCollapsed(false)}
      >
        <Icon name={TOOL_ICON[tool]} size={18} />
      </button>

      <div className="rail" aria-label={t("rail.toolbar")}>
        {/* Grupo 1: Ferramentas de manipulação do canvas */}
        <button
          className={`rail-btn${tool === "pointer" ? " active" : ""}`}
          title={t("rail.pointer")}
          aria-label={t("rail.pointer")}
          onClick={() => setTool("pointer")}
        >
          <Icon name="pointer" />
        </button>
        <button
          ref={penBtnRef}
          className={`rail-btn${tool === "pen" ? " active" : ""}`}
          title={t("rail.pen")}
          aria-label={t("rail.pen")}
          onClick={() => toggleTool("pen")}
        >
          <Icon name="pen" />
        </button>
        <button
          className={`rail-btn${tool === "connector" ? " active" : ""}`}
          title={t("rail.connector")}
          aria-label={t("rail.connector")}
          onClick={() => toggleTool("connector")}
        >
          <Icon name="link" />
        </button>
        <button
          className={`rail-btn${tool === "select" ? " active" : ""}`}
          title={t("rail.select")}
          aria-label={t("rail.select")}
          onClick={() => toggleTool("select")}
        >
          <Icon name="select" />
        </button>
        <button
          className={`rail-btn${tool === "export" ? " active" : ""}`}
          title={t("rail.export")}
          aria-label={t("rail.export")}
          onClick={() => toggleTool("export")}
        >
          <Icon name="exportCrop" />
        </button>

        {tool === "select" && (canGroup || canUngroup) && (
          <>
            {canGroup && (
              <button className="rail-btn" title={t("rail.group")} aria-label={t("rail.groupAria")} onClick={onGroup}>
                <Icon name="group" size={16} />
              </button>
            )}
            {canUngroup && (
              <button className="rail-btn" title={t("rail.ungroup")} aria-label={t("rail.ungroupAria")} onClick={onUngroup}>
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
          title={t("rail.addCard")}
          aria-label={t("rail.addCard")}
          onClick={() => setOpenPopover((p) => (p === "cards" || p === "terminal-config" ? null : "cards"))}
        >
          <Icon name="plus" />
        </button>

        <div className="rail-divider" />

        {/* Grupo 3: Ações e utilitários do board */}
        <button
          ref={findBtnRef}
          className={`rail-btn${openPopover === "find" ? " active" : ""}`}
          title={t("rail.findCard")}
          aria-label={t("rail.findCard")}
          onClick={() => setOpenPopover((p) => (p === "find" ? null : "find"))}
        >
          <Icon name="findCard" />
        </button>
        <button
          ref={aiBtnRef}
          className={`rail-btn${openPopover === "ai" ? " active" : ""}`}
          title={t("rail.aiActions")}
          aria-label={t("rail.aiActions")}
          onClick={() => setOpenPopover((p) => (p === "ai" ? null : "ai"))}
        >
          <Icon name="sparkle" />
        </button>
        <button className="rail-btn" title={t("rail.settings")} aria-label={t("rail.settingsAria")} onClick={onOpenSettings}>
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
              <div className="board-list-heading">{t("rail.addToCanvas")}</div>
              <div className="board-list" style={{ maxHeight: "min(60vh, 380px)" }}>
                {/* Terminal */}
                <button
                  className="popover-row"
                  data-kind="terminal"
                  title={t("rail.newTerminal")}
                  onClick={() => setOpenPopover("terminal-config")}
                >
                  <span className="popover-row-icon">
                    <Icon name="terminal" size={18} />
                  </span>
                  <span>
                    <span className="popover-row-title">{t("rail.title.terminal")}</span>
                    <span className="popover-row-desc">{t("rail.desc.terminal")}</span>
                  </span>
                </button>

                {/* Cards adicionais ordenados */}
                {RAIL_CREATE_ORDER.map((kind) => (
                  <button
                    key={kind}
                    className="popover-row"
                    data-kind={kind}
                    title={railCreateTitle(kind)}
                    onClick={() => {
                      onCreate(kind);
                      setOpenPopover(null);
                    }}
                  >
                    <span className="popover-row-icon">
                      <Icon name={CARD_ICON[kind]} size={18} />
                    </span>
                    <span>
                      <span className="popover-row-title">{t(RAIL_TITLE_KEYS[kind])}</span>
                      <span className="popover-row-desc">{t(RAIL_DESC_KEYS[kind])}</span>
                    </span>
                  </button>
                ))}

                {/* Media — not in RAIL_CREATE_ORDER (one-click would birth an
                    empty shell). Same class as terminal: gather input first
                    (OS file dialog), then create. */}
                <button
                  className="popover-row"
                  data-kind="media"
                  title={t("rail.title.media")}
                  onClick={() => {
                    onCreateMedia();
                    setOpenPopover(null);
                  }}
                >
                  <span className="popover-row-icon">
                    <Icon name={CARD_ICON.media} size={18} />
                  </span>
                  <span>
                    <span className="popover-row-title">{t("rail.title.media")}</span>
                    <span className="popover-row-desc">{t(RAIL_DESC_KEYS.media)}</span>
                  </span>
                </button>
              </div>
            </>
          )}

          {openPopover === "terminal-config" && (
            <>
              <div className="popover-header-with-back">
                <button
                  className="popover-back-btn"
                  onClick={() => setOpenPopover("cards")}
                  title={t("rail.backToCards")}
                >
                  <Icon name="back" size={14} />
                </button>
                <div className="board-list-heading" style={{ margin: 0 }}>
                  {t("rail.newTerminalHeading")}
                </div>
              </div>

              {/* Sem label de campo (2026-09-20, relato do dono: "pode remover
                  a label (provider)"). Os dois títulos de grupo já dizem o que
                  a lista é, e a label só repetia o nome do conceito. */}
              <div className="popover-field">
                <ProviderPicker
                  groups={providerGroups}
                  labelled={providerClassification.ready}
                  value={newProvider}
                  onChange={setNewProvider}
                />
              </div>

              {showAgentFields && (
                <>
                  <div className="popover-field">
                    <label>{t("rail.label.resumeId")}</label>
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
                    {t("rail.label.continueLast")}
                  </label>
                  <div className="popover-field">
                    <label>{t("rail.label.model")}</label>
                    <input className="resume-input" value={newModel} onChange={(e) => setNewModel(e.target.value)} />
                  </div>
                  {/* DESIGN-BACKLOG.md §2.1 "effort do card não é
                      persistido", 2026-09-10 — só é oferecido para quem
                      DECLARA esforço. Os valores vêm da projeção do canal de
                      disponibilidade (task 07b05f43): antes desta task eram
                      um mapa copiado aqui no renderer, que só conhecia
                      claude e antigravity — cline e commandcode declaram as
                      suas e não apareciam. O select só lista valores que o
                      provider aceita, então este popover estruturalmente não
                      entrega um valor que o app já sabe que seria recusado
                      (message-bus.ts's spawn_agent handler aplica a MESMA
                      faixa declarada para spawns vindos de agente, que não
                      passam por esta UI). */}
                  {effortValues.length > 0 && (
                    <div className="popover-field">
                      <label>{t("rail.label.effort")}</label>
                      <select className="resume-input" value={newEffort} onChange={(e) => setNewEffort(e.target.value)}>
                        <option value="">{t("rail.providerDefault")}</option>
                        {effortValues.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {newProvider === "claude" && (
                    <div className="popover-field">
                      <label>{t("rail.label.systemPrompt")}</label>
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
                  {t("rail.createTerminalBtn")}
                </button>
              </div>
            </>
          )}
        </Popover>

        {/* Popover: Localizar card */}
        <Popover anchorRef={findBtnRef} open={openPopover === "find"} onClose={() => setOpenPopover(null)}>
          <div className="board-list-heading">{t("rail.cardsInSession")}</div>
          {cards.length === 0 ? (
            <div className="popover-empty">{t("rail.noCardsYet")}</div>
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
              <span className="popover-row-title">{t("rail.autoArrange")}</span>
              <span className="popover-row-desc">{t("rail.autoArrangeDesc")}</span>
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
              <span className="popover-row-title">{aiBusy ? t("rail.summarizing") : t("rail.summarize")}</span>
              <span className="popover-row-desc">
                {summarizeDisabled ? t("rail.summarizeNeedProvider") : t("rail.summarizeDesc")}
              </span>
            </span>
          </button>
        </Popover>
      </div>
    </div>
  );
}

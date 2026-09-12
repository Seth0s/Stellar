import { Fragment, useEffect, useRef, useState } from "react";
import {
  groupShortcutsForOverlay,
  formatCombo,
  describeComboAliases,
  SHORTCUT_REGISTRY,
  type ShortcutCombo,
  type ShortcutOverrides,
} from "./shortcut-registry";
import { getEffectiveCombo, rebindBlockedReason, evaluateRebindCandidate, needsConfirmation, type RebindEvaluation } from "./shortcut-config";
import { t } from "../../shared/i18n";

/**
 * Shortcuts page — generated from `shortcut-registry.ts`
 * (`groupShortcutsForOverlay`). This IS the settings-modal "Atalhos"
 * page, not a copy: `?` opens SettingsModal already on this page.
 *
 * Fase B — the overlay used to be a hand-written list that drifted from
 * the real bindings (it documented a Ctrl+C that doesn't exist). The
 * registry is the only source for both dispatch and this screen.
 *
 * Fase C — view vs configure is a second MODE of this same list, not a
 * second component. Duplicating the list is the pattern that produced
 * `.thin-scroll` and `lastDirectiveFrom`.
 *
 * i18n — chrome via `t()`. Locale override used to live in this footer;
 * it belongs on the Application → General page (app-wide, not a shortcut).
 *
 * Escape-while-recording: SettingsModal's `useModal` owns Escape. We
 * register a close interceptor so Escape cancels the recording instead
 * of closing the whole settings modal — same contract as when this was
 * its own overlay (review round 2, achado 1).
 */
const MODIFIER_ONLY_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock"]);

interface PendingConfirm {
  id: string;
  combo: ShortcutCombo;
  evaluation: RebindEvaluation;
}

export function ShortcutsOverlay({
  shortcutOverrides,
  onRebind,
  onRestoreDefault,
  onRestoreAll,
  closeInterceptorRef,
}: {
  shortcutOverrides: ShortcutOverrides;
  onRebind: (id: string, combo: ShortcutCombo) => void;
  onRestoreDefault: (id: string) => void;
  onRestoreAll: () => void;
  closeInterceptorRef?: React.MutableRefObject<(() => boolean) | null>;
}) {
  const [mode, setMode] = useState<"view" | "configure">("view");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const recordingButtonRef = useRef<HTMLButtonElement>(null);

  const recordingIdRef = useRef<string | null>(null);
  recordingIdRef.current = recordingId;

  useEffect(() => {
    if (!closeInterceptorRef) return;
    closeInterceptorRef.current = () => {
      if (!recordingIdRef.current) return false;
      setRecordingId(null);
      setRecordingError(null);
      setPendingConfirm(null);
      return true;
    };
    return () => {
      closeInterceptorRef.current = null;
    };
  }, [closeInterceptorRef]);

  useEffect(() => {
    if (recordingId) recordingButtonRef.current?.focus();
  }, [recordingId]);

  const groups = groupShortcutsForOverlay();
  const defsById = new Map(SHORTCUT_REGISTRY.map((d) => [d.id, d] as const));
  const configGroups = groups
    .map((g) => ({ group: g.group, defs: g.rows.map((r) => defsById.get(r.id)!).filter((d) => d.combo !== undefined) }))
    .filter((g) => g.defs.length > 0);

  function startRecording(id: string) {
    setRecordingId(id);
    setRecordingError(null);
    setPendingConfirm(null);
  }

  function cancelRecording() {
    setRecordingId(null);
    setRecordingError(null);
    setPendingConfirm(null);
  }

  function handleRecordingKeyDown(id: string, e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Tab") {
      cancelRecording();
      return;
    }
    if (MODIFIER_ONLY_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const candidate: ShortcutCombo = { key: e.key, ctrlOrCmd: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey };
    const evaluation = evaluateRebindCandidate(id, candidate, shortcutOverrides);
    if (evaluation.forbidden) {
      setRecordingError(t("shortcuts.recordingError.reserved"));
      return;
    }
    if (needsConfirmation(evaluation)) {
      setPendingConfirm({ id, combo: candidate, evaluation });
      setRecordingError(null);
    } else {
      onRebind(id, candidate);
      setRecordingId(null);
    }
  }

  function confirmPending() {
    if (!pendingConfirm) return;
    onRebind(pendingConfirm.id, pendingConfirm.combo);
    setPendingConfirm(null);
    setRecordingId(null);
  }

  return (
    <div className={mode === "configure" ? "shortcuts-page shortcuts-page--config" : "shortcuts-page"}>
      {mode === "view" ? (
        <div className="shortcuts-grid">
          {groups.map(({ group, rows }) => (
            <div className="shortcuts-group" key={group}>
              <div className="shortcuts-group-label">{t(group)}</div>
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <div className="shortcuts-row">
                    <kbd>{row.display}</kbd> {row.description}
                  </div>
                  {row.aliasNote && <div className="shortcuts-row-alias">{row.aliasNote}</div>}
                </Fragment>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="shortcut-config-list">
          {configGroups.map(({ group, defs }) => (
            <div className="shortcuts-group" key={group}>
              <div className="shortcuts-group-label">{t(group)}</div>
              {defs.map((def) => {
                const effective = getEffectiveCombo(def, shortcutOverrides)!;
                const blocked = rebindBlockedReason(def);
                const hasOverride = def.id in shortcutOverrides;
                const isRecording = recordingId === def.id;
                const isConfirming = pendingConfirm?.id === def.id;
                return (
                  <div className="shortcut-config-row" key={def.id}>
                    <div className="shortcut-config-row-main">
                      <kbd>{formatCombo(effective)}</kbd>
                      <span className="shortcut-config-desc">{t(def.description)}</span>
                      {hasOverride && <span className="shortcut-config-badge">{t("shortcuts.customized")}</span>}
                    </div>
                    {describeComboAliases(effective) && (
                      <div className="shortcuts-row-alias">{describeComboAliases(effective)}</div>
                    )}
                    {blocked ? (
                      <div className="shortcut-config-blocked">{blocked}</div>
                    ) : isConfirming && pendingConfirm ? (
                      <>
                        {pendingConfirm.evaluation.conflict && (
                          <div className="shortcut-config-message" role="status">
                            {t("shortcuts.conflict", {
                              description: t(pendingConfirm.evaluation.conflict.description),
                              group: t(pendingConfirm.evaluation.conflict.group),
                            })}
                          </div>
                        )}
                        {pendingConfirm.evaluation.osReservedLabel && (
                          <div className="shortcut-config-message" role="status">
                            {t("shortcuts.osReserved", { label: pendingConfirm.evaluation.osReservedLabel })}
                          </div>
                        )}
                        <div className="shortcut-config-confirm-actions">
                          <button type="button" className="primary" onClick={confirmPending}>
                            {t("shortcuts.confirm.rebind")}
                          </button>
                          <button type="button" onClick={cancelRecording}>
                            {t("confirm.cancel")}
                          </button>
                        </div>
                      </>
                    ) : isRecording ? (
                      <>
                        <button
                          type="button"
                          ref={recordingButtonRef}
                          className="shortcut-config-recording"
                          onKeyDown={(e) => handleRecordingKeyDown(def.id, e)}
                        >
                          {t("shortcuts.recording")}
                        </button>
                        {recordingError && (
                          <div className="shortcut-config-message shortcut-config-message--error" role="alert">
                            {recordingError}
                          </div>
                        )}
                        <div className="shortcut-config-actions">
                          <button type="button" onClick={cancelRecording}>
                            {t("confirm.cancel")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="shortcut-config-actions">
                        <button type="button" onClick={() => startRecording(def.id)}>
                          {t("shortcuts.confirm.rebind")}
                        </button>
                        {hasOverride && (
                          <button type="button" onClick={() => onRestoreDefault(def.id)}>
                            {t("shortcuts.restoreDefault")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions settings-page-actions">
        {mode === "configure" && (
          <button type="button" className="ghost" onClick={onRestoreAll}>
            {t("shortcuts.restoreAll")}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => setMode(mode === "view" ? "configure" : "view")}>
          {mode === "view" ? t("shortcuts.mode.configure") : t("shortcuts.mode.view")}
        </button>
      </div>
    </div>
  );
}

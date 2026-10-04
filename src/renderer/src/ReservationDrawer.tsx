import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../shared/i18n";
import { reservationStateFromPhase, TASK_HOVER_EVENT, type TaskPhase, type ReservationDisplayState } from "./task-board-model";
import styles from "./ReservationDrawer.module.css";

/**
 * A GAVETA (task 377a6029) — a fila PRÓPRIA de tasks RESERVADAS deste card,
 * presa à borda lateral. Um card reserva tasks (`link_task_card mode:"reserve"`
 * ou `update_task cardId`) e elas começam sozinhas quando as deps fecham e o
 * card está livre. Aqui o humano VÊ a fila, reordena, começa uma agora ou solta.
 *
 * Estados (cor + texto): esperando deps / pronta / entregando / rodando /
 * aguardando revisão. Estado vazio explica o que a gaveta é.
 */

type Dep = { id: string; status: string | null };
type Item = { taskId: string; title: string | null; status: string | null; phase?: TaskPhase | null; deps: Dep[] };

const STATE_KEY: Record<ReservationDisplayState, string> = {
  "waiting-deps": "reservation.state.waiting",
  delivering: "reservation.state.delivering",
  running: "reservation.state.running",
  review: "reservation.state.review",
  ready: "reservation.state.ready",
};

const STATE_CLASS: Record<ReservationDisplayState, string> = {
  "waiting-deps": styles.waitingDeps,
  delivering: styles.delivering,
  running: styles.running,
  review: styles.review,
  ready: styles.ready,
};

/**
 * Estado exibido (task 6266d3e7). A `phase` derivada no main é a fonte —
 * `running` mostra "rodando" e `awaiting_review` mostra "aguardando revisão".
 * Sem `phase` (resposta antiga, campo ausente), cai numa leitura local mínima
 * (deps + status), que é a ausência honesta: nunca inventa uma execução que o
 * main não afirmou.
 */
function stateOf(item: Item): ReservationDisplayState {
  if (item.phase !== undefined && item.phase !== null) return reservationStateFromPhase(item.phase);
  if (item.deps.some((d) => d.status !== "done")) return "waiting-deps";
  if (item.status === "running") return "delivering";
  return "ready";
}

export function ReservationDrawer(props: {
  cardId: string;
  /** Notifica o board para desenhar o conector tracejado gaveta→task. */
  onHoverTask?: (taskId: string | null) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  // HOVER gaveta→task (task 6266d3e7): além de avisar via `onHoverTask`, a
  // gaveta emite um CustomEvent no window (o outro canal possível entre dois
  // cards) e desenha um conector TRACEJADO do item até a task na Fila. Sem a
  // task na Fila (`querySelector` vazio) não há conector — ausência honesta,
  // nunca uma linha para um alvo inventado.
  const [hover, setHover] = useState<{ from: DOMRect; to: DOMRect } | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const emitHover = useCallback(
    (taskId: string | null) => {
      props.onHoverTask?.(taskId);
      window.dispatchEvent(new CustomEvent(TASK_HOVER_EVENT, { detail: { taskId } }));
    },
    [props],
  );

  const enterItem = useCallback(
    (taskId: string, el: HTMLElement) => {
      emitHover(taskId);
      const target = document.querySelector(`[data-task-item-id="${CSS.escape(taskId)}"]`);
      if (!target) {
        setHover(null);
        return;
      }
      setHover({ from: el.getBoundingClientRect(), to: target.getBoundingClientRect() });
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    },
    [emitHover],
  );

  const leaveItem = useCallback(() => {
    emitHover(null);
    setHover(null);
  }, [emitHover]);
  // DEFEITO MEDIDO (2026-10-04): a gaveta lia `window.stellar.tasks`, que NÃO
  // EXISTE — o preload expõe `window.tasks` (contextBridge). A lista vinha
  // SEMPRE vazia. Corrigido para a API real.
  const tasksApi = (
    window as unknown as {
      tasks?: {
        listReservations?: (id: string) => Promise<{ ok: boolean; reservations?: Item[] }>;
        reorderReservations?: (id: string, ids: string[]) => Promise<unknown>;
        startReservation?: (taskId: string, cardId: string) => Promise<unknown>;
        releaseReservation?: (taskId: string, cardId: string) => Promise<unknown>;
      };
    }
  ).tasks;

  const refresh = useCallback(async () => {
    const res = await tasksApi?.listReservations?.(props.cardId);
    if (res?.ok) setItems(res.reservations ?? []);
    else setItems([]);
  }, [props.cardId, tasksApi]);

  // BUSCA no mount (contador da aba) e, com a gaveta ABERTA, refaz ao abrir e
  // a cada push de task — sem isto a lista congelava no primeiro fetch (um
  // card que reservou DEPOIS de a gaveta montar nunca aparecia).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const off = window.tasks?.onChanged?.(() => {
      void refresh();
    });
    return () => {
      off?.();
    };
  }, [open, refresh]);

  async function reorder(from: number, to: number) {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setItems(next);
    await tasksApi?.reorderReservations?.(props.cardId, next.map((i) => i.taskId));
  }

  async function startNow(item: Item) {
    if (item.deps.some((d) => d.status !== "done") && !window.confirm(t("reservation.confirmPendingDeps"))) return;
    await tasksApi?.startReservation?.(item.taskId, props.cardId);
    await refresh();
  }

  async function release(item: Item) {
    await tasksApi?.releaseReservation?.(item.taskId, props.cardId);
    await refresh();
  }

  return (
    <>
    <div className={styles.reservationDrawer} data-part="reservation-drawer">
      <button
        type="button"
        data-part="reservation-tab"
        className={`${styles.tab}${open ? ` ${styles.tabOpen}` : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={t("reservation.title")}
      >
        {t("reservation.tab", { count: items.length })}
      </button>
      {open && (
        <div className={styles.panel}>
          <div className={styles.head}>{t("reservation.title")}</div>
          {items.length === 0 ? (
            <div className={styles.empty}>{t("reservation.empty")}</div>
          ) : (
            <ul className={styles.list}>
              {items.map((item, index) => {
                const state = stateOf(item);
                return (
                  <li
                    key={item.taskId}
                    data-part="reservation-item"
                    data-task-id={item.taskId}
                    data-phase={item.phase ?? ""}
                    className={styles.item}
                    draggable
                    onDragStart={() => setDragFrom(index)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragFrom !== null && dragFrom !== index) void reorder(dragFrom, index);
                      setDragFrom(null);
                    }}
                    onMouseEnter={(e) => enterItem(item.taskId, e.currentTarget)}
                    onMouseLeave={leaveItem}
                  >
                    <div className={styles.itemHead}>
                      <span className={styles.itemTitle}>{item.title ?? item.taskId}</span>
                      <span className={`${styles.state} ${STATE_CLASS[state]}`}>{t(STATE_KEY[state] as Parameters<typeof t>[0])}</span>
                    </div>
                    {state === "waiting-deps" && (
                      <div className={styles.deps}>
                        {t("reservation.depsOn", { deps: item.deps.filter((d) => d.status !== "done").map((d) => d.id).join(", ") })}
                      </div>
                    )}
                    <div className={styles.actions}>
                      <button type="button" onClick={() => void startNow(item)}>
                        {t("reservation.action.startNow")}
                      </button>
                      <button type="button" onClick={() => void release(item)}>
                        {t("reservation.action.release")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
    {hover &&
      createPortal(
        <svg
          className={styles.hoverConnector}
          width={viewport.w}
          height={viewport.h}
          aria-hidden="true"
          data-part="reservation-connector"
        >
          <line
            className={styles.hoverConnectorLine}
            x1={hover.from.right}
            y1={hover.from.top + hover.from.height / 2}
            x2={hover.to.left}
            y2={hover.to.top + hover.to.height / 2}
          />
          <circle className={styles.hoverConnectorDot} cx={hover.to.left} cy={hover.to.top + hover.to.height / 2} r={3} />
        </svg>,
        document.body,
      )}
    </>
  );
}

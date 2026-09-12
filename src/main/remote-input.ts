import * as dbus from "dbus-next";
import { t } from "../shared/i18n";
import { randomBytes } from "node:crypto";

// evdev button codes (linux/input-event-codes.h) — what
// NotifyPointerButton expects, not DOM's 0/1/2.
const BTN_LEFT = 0x110;
const BTN_MIDDLE = 0x112;
const BTN_RIGHT = 0x111;
const DOM_BUTTON_TO_EVDEV: Record<number, number> = { 0: BTN_LEFT, 1: BTN_MIDDLE, 2: BTN_RIGHT };

const DEVICE_TYPE = { keyboard: 1, pointer: 2 };

export type EnsureResult = { granted: true } | { granted: false; error: string };

/**
 * Human-driven control of an external OS window (DESIGN-BACKLOG.md item 3,
 * phase 1 — relative pointer motion, not click-exact-pixel; that needs a
 * PipeWire video consumer to correlate a click with an absolute screen
 * position, which nothing here does yet — the `moveRelative`/`button`/
 * `keysym` shape is deliberately narrow so an absolute-mode addition later
 * doesn't have to touch this session's lifecycle, just add new methods to
 * it) via GNOME's `org.freedesktop.portal.RemoteDesktop`. One session for
 * the whole app, not one per card — the portal has no notion of "control
 * just this window", the grant is "let this app inject input devices" for
 * the whole desktop session, so asking for it once and sharing it is both
 * correct and avoids a consent dialog per card.
 *
 * `Start()` below is the one call that shows a real GNOME dialog — cannot
 * be driven headlessly (native OS UI, outside anything CDP reaches), so
 * this can only be verified up through `SelectDevices` without a human
 * physically clicking Allow.
 */
export function createRemoteInputSession() {
  let bus: dbus.MessageBus | null = null;
  let remoteDesktopIface: dbus.ClientInterface | null = null;
  let sessionHandle: string | null = null;
  let starting: Promise<EnsureResult> | null = null;

  function randToken(prefix: string): string {
    return prefix + randomBytes(4).toString("hex");
  }

  function predictHandle(b: dbus.MessageBus, token: string): string {
    // Undocumented but stable convention every portal implementation
    // follows: the request object path is derived from the caller's own
    // bus name and the handle_token it supplied — predictable BEFORE the
    // method call returns. Registering the signal match on this predicted
    // path before making the call (not after awaiting its return) avoids
    // a real race confirmed while testing this outside the app: the
    // Response signal can fire before a match registered only afterward
    // would catch it.
    // Real runtime property (confirmed live, see /tmp/portal_test/test2.js)
    // that dbus-next's own .d.ts doesn't declare on MessageBus.
    const sender = ((b as unknown as { name?: string }).name ?? "").slice(1).replace(/\./g, "_");
    return `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
  }

  async function awaitResponse(b: dbus.MessageBus, handle: string): Promise<Record<string, dbus.Variant>> {
    await b.call(
      new dbus.Message({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [`type='signal',interface='org.freedesktop.portal.Request',path='${handle}'`],
      }),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        b.removeListener("message", onMsg);
        reject(new Error("timed out waiting for a portal response"));
      }, 30_000);
      function onMsg(msg: dbus.Message) {
        if (
          msg.type === dbus.MessageType.SIGNAL &&
          msg.interface === "org.freedesktop.portal.Request" &&
          msg.member === "Response" &&
          msg.path === handle
        ) {
          clearTimeout(timer);
          b.removeListener("message", onMsg);
          const [code, results] = msg.body as [number, Record<string, dbus.Variant>];
          if (code !== 0)
            reject(new Error(code === 1 ? t("error.portalCancelled") : t("error.portalRefused", { code })));
          else resolve(results);
        }
      }
      b.on("message", onMsg);
    });
  }

  async function ensureStarted(): Promise<EnsureResult> {
    if (starting) return starting;
    starting = (async (): Promise<EnsureResult> => {
      try {
        bus = dbus.sessionBus();
        const portalObj = await bus.getProxyObject(
          "org.freedesktop.portal.Desktop",
          "/org/freedesktop/portal/desktop",
        );
        remoteDesktopIface = portalObj.getInterface("org.freedesktop.portal.RemoteDesktop");

        const createToken = randToken("t");
        const createHandle = predictHandle(bus, createToken);
        const createPromise = awaitResponse(bus, createHandle);
        await remoteDesktopIface.CreateSession({
          handle_token: new dbus.Variant("s", createToken),
          session_handle_token: new dbus.Variant("s", randToken("s")),
        });
        const createResult = await createPromise;
        sessionHandle = (createResult.session_handle as dbus.Variant).value as string;

        const selToken = randToken("t");
        const selHandle = predictHandle(bus, selToken);
        const selPromise = awaitResponse(bus, selHandle);
        await remoteDesktopIface.SelectDevices(sessionHandle, {
          handle_token: new dbus.Variant("s", selToken),
          types: new dbus.Variant("u", DEVICE_TYPE.keyboard | DEVICE_TYPE.pointer),
        });
        await selPromise;

        // The one call that shows GNOME's real consent dialog.
        const startToken = randToken("t");
        const startHandle = predictHandle(bus, startToken);
        const startPromise = awaitResponse(bus, startHandle);
        await remoteDesktopIface.Start(sessionHandle, "", { handle_token: new dbus.Variant("s", startToken) });
        await startPromise;

        return { granted: true };
      } catch (err) {
        sessionHandle = null;
        remoteDesktopIface = null;
        return { granted: false, error: err instanceof Error ? err.message : String(err) };
      }
    })();
    return starting;
  }

  async function notify(method: string, ...args: unknown[]) {
    if (!remoteDesktopIface || !sessionHandle) return;
    // Fire-and-forget on purpose: these fire on every pointermove during a
    // drag — awaiting/surfacing errors per-call would either add latency
    // felt as input lag or spam the caller for a transient hiccup that
    // doesn't matter for the next frame anyway.
    void (remoteDesktopIface as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[method](
      sessionHandle,
      {},
      ...args,
    ).catch(() => {});
  }

  return {
    ensureStarted,
    moveRelative: (dx: number, dy: number) => notify("NotifyPointerMotion", dx, dy),
    button: (domButton: number, pressed: boolean) =>
      notify("NotifyPointerButton", DOM_BUTTON_TO_EVDEV[domButton] ?? BTN_LEFT, pressed ? 1 : 0),
    scroll: (dx: number, dy: number) => notify("NotifyPointerAxis", dx, dy),
    keysym: (keysym: number, pressed: boolean) => notify("NotifyKeyboardKeysym", keysym, pressed ? 1 : 0),
  };
}

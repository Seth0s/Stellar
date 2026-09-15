#!/usr/bin/env python3
"""Tira UM screenshot da tela inteira via portal XDG (org.freedesktop.portal.Screenshot,
não-interativo) e salva no caminho passado como argv[1].

Por que portal: `org.gnome.Shell.Screenshot` retorna AccessDenied para processos comuns
nesta sessão (Fedora/GNOME, Wayland). O portal exige a permissão "screenshot" no
PermissionStore — concedida uma vez com:

  gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore \
    --object-path /org/freedesktop/impl/portal/PermissionStore \
    --method org.freedesktop.impl.portal.PermissionStore.SetPermission \
    screenshot screenshot "" "['yes']"

O portal salva em ~/Imagens/Screenshot.png (nome fixo dele); este script copia para o
destino pedido e remove o original para não sujar a pasta do usuário.
"""
import os
import shutil
import sys
import urllib.parse

import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib


def main() -> int:
    out = sys.argv[1]
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    proxy = bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
    iface = dbus.Interface(proxy, "org.freedesktop.portal.Screenshot")
    loop = GLib.MainLoop()
    res = {}

    def on_resp(response, results):
        res["r"] = int(response)
        res["uri"] = str(results.get("uri", ""))
        loop.quit()

    handle = iface.Screenshot("", {"interactive": dbus.Boolean(False)})
    bus.add_signal_receiver(
        on_resp,
        signal_name="Response",
        dbus_interface="org.freedesktop.portal.Request",
        path=str(handle),
    )
    GLib.timeout_add_seconds(20, loop.quit)
    loop.run()

    if res.get("r") != 0 or not res.get("uri"):
        print(f"PORTAL_FAIL {res}", file=sys.stderr)
        return 2

    src = urllib.parse.unquote(urllib.parse.urlparse(res["uri"]).path)
    shutil.copyfile(src, out)
    home = os.path.expanduser("~/")
    if os.path.realpath(src).startswith(os.path.realpath(home)):
        os.unlink(src)  # não deixar lixo em ~/Imagens
    print(f"OK {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

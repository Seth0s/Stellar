#!/bin/sh
# DESIGN-BACKLOG.md item 18 addendum — the rpm/deb postinstall scripts
# electron-builder/fpm generate call update-desktop-database but never
# refresh the icon theme cache, so a freshly installed package can sit
# there showing the desktop environment's generic fallback icon even
# though the right file is on disk at the right path (confirmed live —
# see AGENTS.md). Best-effort only: neither command existing is fatal.
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi
if command -v xdg-icon-resource >/dev/null 2>&1; then
  xdg-icon-resource forceupdate --theme hicolor >/dev/null 2>&1 || true
fi
# electron-builder/fpm can ship the .desktop as 0600 root-only (seen in
# stellar-0.8.4 rpm), which makes the launcher invisible to every
# non-root user's app menu. Force world-readable, then refresh the index.
for f in /usr/share/applications/stellar.desktop; do
  [ -f "$f" ] && chmod 644 "$f" || true
done
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
exit 0

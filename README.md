# Stellar

A multi-agent spatial canvas for orchestrating Claude/Codex/Cursor/bash
sessions — real terminals (Electron + xterm.js + node-pty), an embedded
browser, a file explorer, sticky notes and connectors, all as cards you
pan/zoom/drag/resize freely on an infinite canvas, grouped into sessions
and projects.

## Highlights

- **Sessions grouped by project** — a Home screen (dates, "recente"
  badge, jump back in) instead of dropping straight into a board.
- **Real terminals**, multiple providers (Claude, Codex, Cursor, bash),
  resumable/continuable, spawned from a linear rail or a radial
  right-click/press-hold menu (which also switches tools).
- **File explorer** with per-type icons, inline rename/delete/create,
  markdown preview.
- **Mobile remote control** — pair a phone over the LAN (QR code,
  per-device tokens/revocation) and control your terminals from it.
- **In-app updater** — silent check on boot, install only on an explicit
  click, "lembrar depois", changelog, a pending-update indicator.

## Getting started

```bash
npm install
npm run dev
```

## Building a package

```bash
npm run package:linux   # .rpm + .deb
npm run package:mac     # .dmg + .zip
npm run package:win     # NSIS installer + portable
```

A `v*` tag pushed to this repo triggers `.github/workflows/release.yml`,
which builds and publishes all of the above to a GitHub Release. See
[`docs/packaging.md`](docs/packaging.md) for the full checklist and
what's verified vs. not yet.

## Verifying a change

```bash
npm run verify   # tsc + build + the full CDP/Electron smoke suite
```

## More context

- [`AGENTS.md`](AGENTS.md) — architecture, decisions, and a running log
  of what's been built/fixed and how it was verified.
- [`DESIGN-BACKLOG.md`](DESIGN-BACKLOG.md) — the product backlog, one
  numbered item per feature/fix, each closed only once verified live.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Free to use, modify, and
redistribute, with attribution and the license notice kept intact.

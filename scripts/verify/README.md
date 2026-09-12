# scripts/verify/

Not a test framework — a reusable harness for the empirical verification
this project already requires of every change (see `AGENTS.md`: "nunca
assumir 'deve funcionar' sem rodar"). Each `smoke-*.mjs` here launches a
real, isolated `electron out/main/index.js` instance (its own
`--user-data-dir`/`--remote-debugging-port`, never the user's own `npm run
dev` session) and drives it over the Chrome DevTools Protocol.

## Run

```bash
npm run verify:ci       # tsc, vitest, check:tokens, build — what CI runs
npm run verify          # verify:ci, then every smoke-*.mjs (needs a display)
npm run verify:smoke    # smoke only; requires `out/` already built
npm run check:tokens    # SYSTEM_DESIGN §1: var() vs tokens.css (no Electron)
node scripts/verify/smoke-boot.mjs               # just one
```

CI (`.github/workflows/ci.yml`) runs `verify:ci` only. Smoke needs a
real Electron window and is **declared** as local-only until someone
demonstrates a scripted boot on xvfb — a permanently-red xvfb job
trained everyone to ignore red.

Requires `npm run build` (or `electron-vite build`) to have produced
`out/` first before any `smoke-*.mjs` — `npm run verify` does that.

## Why not Playwright

This machine has no system Chrome/Chromium for Playwright to launch, and
the actual point is exercising the real packaged app (GPU disabled,
software rendering) rather than a stock browser — so this drives CDP
directly instead. `cdp-client.mjs` is the shared boilerplate (launch,
connect, `evalJs`, synthetic click, a tiny `check()`/`finish()` pair);
every smoke script imports from it rather than reinventing it.

## Adding a smoke script

Copy the shape of an existing one: `startApp` → `connectPage` →
`check(...)` calls → `stopApp` in a `finally`. Pick a CDP port not already
used by another script in this directory (each one runs standalone, but
they'd collide if run concurrently on the same port). Keep it to the
handful of things that would be embarrassing to silently break — this is
not meant to become a full coverage suite, just a faster rerun of the
verification this project already does by hand for every change.

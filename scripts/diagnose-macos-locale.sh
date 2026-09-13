#!/bin/bash
# Stellar — macOS locale / mojibake diagnostic (task ec68fd31).
# Paste this whole file into a bash card, or: bash scripts/diagnose-macos-locale.sh
#
# Why a file AND stdout: if the card already shows n√£o, the on-screen
# glyphs cannot be trusted. The file is the ground truth of what the
# shell wrote. Send BOTH the file and the answers in the MANUAL block.
#
# Run twice:
#   1. Inside a Stellar bash card, with the .app opened from Finder/Dock
#      (not from Terminal.app). That is the suspected environment.
#   2. Inside Terminal.app, same user, same machine — control sample.
#
# Then do the four MANUAL steps printed at the end. One reply with
# both files + the filled template is enough to confirm or kill the
# LANG hypothesis and to declare copy/paste innocent or guilty.

set -u
hex_dump() {
  if command -v xxd >/dev/null 2>&1; then
    xxd -p | tr -d '\n'
    echo
  elif command -v od >/dev/null 2>&1; then
    od -An -tx1 | tr -d ' \n'
    echo
  else
    python3 -c "import sys; print(sys.stdin.buffer.read().hex())"
  fi
}
OUT="${STELLAR_LOCALE_OUT:-/tmp/stellar-locale-diag.txt}"
{
  echo "===== STELLAR MACOS LOCALE DIAGNOSTIC ====="
  echo "run_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "uname=$(uname -a)"
  if command -v sw_vers >/dev/null 2>&1; then sw_vers; fi
  echo "shell=$0 SHELL=${SHELL-} bash=${BASH_VERSION-}"
  echo "how_opened=FILL_FINDER_OR_TERMINAL"
  echo

  echo "----- A. locale(1) -----"
  locale || true
  echo "charmap=$(locale charmap 2>/dev/null || echo FAIL)"
  echo

  echo "----- B. card/process env (LANG/LC_*) -----"
  # Empty block = ABSENT. That is a real result, not a missing step.
  if env | grep -E '^(LANG|LC_|LANGUAGE)=' | sort; then
    :
  else
    echo "ABSENT"
  fi
  echo

  echo "----- C. walk to Electron/Stellar parent env -----"
  pid=$$
  found=""
  while [ "$pid" != 1 ] && [ -n "$pid" ]; do
    comm=$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')
    echo "pid=$pid comm=${comm:-?}"
    low=$(printf '%s' "$comm" | tr '[:upper:]' '[:lower:]')
    case "$low" in
      *stellar*|*electron*|*agent-canvas*) found=$pid ;;
    esac
    next=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    [ "$next" = "$pid" ] && break
    pid=$next
  done
  if [ -n "$found" ]; then
    echo "app_pid=$found"
    # ps eww is one long line; split on spaces so LANG= is grep-able.
    #
    # CUIDADO MEDIDO (2026-09-13): em Linux este probe devolveu SÓ a linha
    # de comando, sem env nenhum, e a versão anterior imprimia
    # "APP_ENV_LOCALE=ABSENT" — indistinguível de uma ausência real, e
    # ausência real é justamente o que confirmaria a hipótese. Em macOS a
    # restrição é mais forte ainda (env de outro processo normalmente não
    # é legível). Então: PATH existe em QUALQUER env real. Sem PATH na
    # saída, o probe não leu nada e isso é UNREADABLE, não ABSENT.
    app_env=$(ps eww -p "$found" 2>/dev/null | tr ' ' '\n')
    if printf '%s' "$app_env" | grep -q '^PATH='; then
      if printf '%s' "$app_env" | grep -E '^(LANG|LC_|LANGUAGE)='; then
        :
      else
        echo "APP_ENV_LOCALE=ABSENT   # env lido de verdade (PATH presente) e sem locale"
      fi
    else
      echo "APP_ENV_LOCALE=UNREADABLE   # ps nao devolveu env; NAO conta como ausencia"
      echo "APP_ENV_NOTE=use a secao B: o card e filho do app, o env dele JA e o env herdado"
    fi
  else
    echo "app_pid=NOT_FOUND"
  fi
  echo

  echo "----- D. UTF-8 locales installed (locale -a) -----"
  if command -v locale >/dev/null 2>&1; then
    # Só a contagem e uma amostra: a listagem inteira passa de 300 linhas e
    # afoga o resto do arquivo. Quem responde a pergunta são os has_* abaixo.
    utf8_count=$(locale -a 2>/dev/null | grep -i -c -E 'utf-8|utf8' || true)
    echo "utf8_locale_count=${utf8_count:-0}"
    [ "${utf8_count:-0}" = "0" ] && echo "NO_UTF8_LOCALE"
    locale -a 2>/dev/null | grep -i -E 'utf-8|utf8' | head -8
    echo "has_en_US_UTF8=$(locale -a 2>/dev/null | grep -ci -E '^en_US\.(UTF-8|utf8)$' || true)"
    echo "has_pt_BR_UTF8=$(locale -a 2>/dev/null | grep -ci -E '^pt_BR\.(UTF-8|utf8)$' || true)"
    echo "has_C_UTF8=$(locale -a 2>/dev/null | grep -ci -E '^C\.(UTF-8|utf8)$' || true)"
    echo "has_UTF8_bare=$(locale -a 2>/dev/null | grep -ci -E '^UTF-8$' || true)"
  else
    echo "locale_cmd=MISSING"
  fi
  echo

  echo "----- E. raw UTF-8 bytes, no libc locale -----"
  echo "expect_hex=c3a3   (U+00E3 LATIN SMALL LETTER A WITH TILDE)"
  echo "mojibake_hex=e2889ac2a3   (U+221A SQUARE ROOT + U+00A3 POUND = MacRoman of c3 a3)"
  printf 'glyph_raw='
  printf '\xc3\xa3'
  printf '\n'
  printf '\xc3\xa3' | hex_dump
  echo "LOOK_AT_GLYPH_ABOVE=FILL_a_tilde_OR_root_pound_OR_other"
  echo

  echo "----- F. locale-aware printers -----"
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import locale, sys
print("python", sys.version.split()[0])
print("pref", locale.getpreferredencoding(False))
print("stdout", sys.stdout.encoding)
print("fsenc", sys.getfilesystemencoding())
s = "não"
print("print_nao", s)
sys.stdout.flush()
sys.stdout.buffer.write(b"print_nao_utf8_hex=" + s.encode("utf-8").hex().encode() + b"\n")
PY
  else
    echo "python3=MISSING"
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'console.log("node_stdout", process.stdout.encoding || "default"); console.log("node_nao", "não");'
  else
    echo "node=MISSING"
  fi
  echo

  echo "----- G. login-shell LANG (same class of query as user-env.ts) -----"
  # Inherits THIS process env. If Electron has no LANG and zprofile never
  # exports one, this stays empty — Terminal.app injects LANG itself and
  # that injection does NOT run here.
  login="${SHELL:-/bin/zsh}"
  echo "login_shell=$login"
  "$login" -ilc 'printf "login_LANG=%s\nlogin_LC_ALL=%s\nlogin_LC_CTYPE=%s\nlogin_charmap=%s\n" "${LANG-}" "${LC_ALL-}" "${LC_CTYPE-}" "$(locale charmap 2>/dev/null || echo FAIL)"' 2>/dev/null || echo "login_query=FAIL"
  echo

  echo "----- H. launchd LANG (host, not the card) -----"
  if command -v launchctl >/dev/null 2>&1; then
    echo "launchctl_LANG=$(launchctl getenv LANG 2>/dev/null || echo UNSET)"
    echo "launchctl_LC_ALL=$(launchctl getenv LC_ALL 2>/dev/null || echo UNSET)"
    echo "launchctl_LC_CTYPE=$(launchctl getenv LC_CTYPE 2>/dev/null || echo UNSET)"
  fi
  echo

  echo "----- MANUAL (fill and send back; do not skip) -----"
  cat <<'MANUAL'
how_opened=FINDER_or_TERMINAL_or_DEV_FROM_TERMINAL

# After printf in section E, the single glyph on the "glyph_raw=" line was:
E_glyph=a_tilde | root_pound | replacement | other:

# Copy that ONE glyph (select it in the Stellar card, Cmd+C). Then in
# Terminal.app OUTSIDE Stellar run:  pbpaste | xxd -p
# Paste the hex here. c3a3 = clipboard has ã. e2889ac2a3 = clipboard has √£.
COPY_hex=

# In TextEdit or Notes type: não
# Copy it there (not from Stellar). In Terminal.app: pbpaste | xxd -p
# Expect 6ec3a36f (n + ã + o) or just c3a3 if only the tilde was copied. Then paste into
# a Stellar bash card at a fresh prompt after this command:
#   python3 -c "import sys; print(sys.stdin.buffer.read().hex())"
# and press Ctrl+D when done. Paste the printed hex here.
PASTE_into_card_hex=

# Type não at a Stellar bash prompt (keyboard, not paste) and Enter.
# What appeared as you typed, and after Enter?
TYPED_looked_like=

# Same four answers from the Terminal.app CONTROL run of this script:
CTRL_E_glyph=
CTRL_COPY_hex=
CTRL_how_opened=Terminal.app
MANUAL
} | tee "$OUT"

echo
echo "Wrote $OUT — attach this file. If the card shows mojibake, the file is still the source of truth."
echo "Also run the same script once in Terminal.app and attach that file too."

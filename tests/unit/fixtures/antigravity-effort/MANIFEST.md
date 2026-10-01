# `agy --effort` — medição RUNTIME (task 1c4f3b50)

Binário: `agy` v1.2.14. Capturado em 2026-10-01 na máquina do dono.
Cada `.json` é o **stdout literal** do comando abaixo; o exit code e a 1ª linha de stderr vêm nesta tabela.

Prompt: `Think carefully, then answer: how many distinct permutations of the letters in BANANA are there? Reply with just the number.`

| caso | comando | exit | stderr (1ª linha) |
|---|---|---|---|
| default-low | `agy --effort low` | 0 | — |
| default-medium | `agy --effort medium` | 1 | error: invalid model selection (--model "" --effort "medium"): gemini-3.1-pro has no "medium" effort (available: low, high) |
| default-high | `agy --effort high` | 0 | — |
| default-max | `agy --effort max` | 1 | error: invalid model selection (--model "" --effort "max"): gemini-3.1-pro has no "max" effort (available: low, high) |
| invalid-bogus | `agy --effort bogus` | 1 | error: invalid model selection (--model "" --effort "bogus"): invalid --effort "bogus" (valid: low, medium, high, max) |
| flash-medium-effort-medium | `agy --model gemini-3.8-flash-medium --effort medium` | 0 | — |
| flash-medium-effort-max | `agy --model gemini-3.8-flash-medium --effort max` | 1 | error: invalid model selection (--model "gemini-3.8-flash-medium" --effort "max"): --model gemini-3.8-flash-medium conflicts with --effort=max |
| flash-low-effort-max | `agy --model gemini-3.8-flash-low --effort max` | 1 | error: invalid model selection (--model "gemini-3.8-flash-low" --effort "max"): --model gemini-3.8-flash-low conflicts with --effort=max |

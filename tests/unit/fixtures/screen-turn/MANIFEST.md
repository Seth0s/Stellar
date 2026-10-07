# Screen turn-state samples (ANSI-stripped, as `read_card` / `getCardRecentOutput` return them)

| file | provider | state | source |
|---|---|---|---|
| commandcode-working.txt | commandcode | working | tui-submit-started/commandcode-working.txt (live card, spinner `esc to interrupt • 6m 18s • ↓ 141.7k`) |
| commandcode-ended.txt | commandcode | ended | tui-submit-started/commandcode-idle.txt (live card, `✻ Worked for 9m 51s`) |
| commandcode-prompt-open.txt | commandcode | prompt open, no turn yet | read_card of live card 98576220, 2026-10-07 (boot screen, composer empty) |
| antigravity-idle.txt | antigravity | idle footer | read_card of live card 98576188, 2026-10-07 (agy 1.3.1) |
| antigravity-working.txt | antigravity | working | read_card of live card 98576289, 2026-10-07 (footer `esc to cancel`, spinner `⣯  Running command...`) |

NOT measured, on purpose (no sample, no declaration — absence is the honest answer):
- codex: its `Worked for …` end marker is declared in `turnEnd` already, but no working-state sample exists and the CLI would not start on this machine (missing @openai/codex-linux-x64).
- cursor: no end-of-turn sample in the repo; the board is out of quota on cursor/codex (owner, 2026-10-07).
Antigravity has no completed-turn "Worked for" line; its idle footer swapping with the busy footer is the marker.

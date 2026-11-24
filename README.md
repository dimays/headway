# Headway

A live progress pane for Claude Code. Headway sits beside the chat and shows
where your work stands — the session's plan, each step, the subagents working
on those steps, and your other sessions — as progress bars that move when
scope moves. No more asking a session "where are we at?"

```
THIS SESSION
headway                                    3/7  52%
████████████████▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
● On track ⓘ                ~9–24 min left · rough ⓘ
Plan grew from 5 to 7 steps · 1 change, last 4m ago ⓘ

STEPS
▸ ✓ Read the API docs                              3m
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▾ ● Build the pane                          ~3m left
    ━━━━━━━━━━━━━━━━━━━━━━━━┅┅┅┅┅┅────────────────
    2/4 parts · Drawing the bars
      ✓ Layout
      ● Bars
      ○ Buttons
      ○ Tests
      ◐ Survey render props           Explore · 2m
       +0s  Read · register.tsx                 0s
      +41s  Edit · register.tsx                 1s
     +4m2s  Bash · claude plugin test          12s
      [ Add context ]
▸ ○ Test it                                      ~3m
    ──────────────────────────────────────────────

BACKGROUND TASKS                             1 running
▸ ◐ Build the release                              6m
    ✓ 412 modules transformed

OTHER SESSIONS
▸ scope-creep                              7/10  70%
  ██████████████████████████████████░░░░░░░░░░░░░░
  Slower than usual · ~6–11 min left · Fix the login redirect
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install headway --marketplace dimays/headway
```

From a shell:

```bash
claude plugin install headway --marketplace dimays/headway
```

In the Claude desktop app: click **+** next to the prompt box → **Plugins** →
**Add marketplace** with `dimays/headway`, then **Add plugin**.

The pane opens on its own in each new session. `/headway` reopens it;
`/headway clear` resets the current session's board.

## What it shows

- **Nested progress.** The session's bar, then a bar per step, each with its
  own ETA. Open a step (▸) for its parts, the subagents and background tasks
  working on it, and its order of operations: every tool call in sequence,
  with how long each took.
- **ETAs that learn.** Estimates come from how long this session's finished
  steps actually took, shown as a range (`~9–24 min`) marked *rough* until
  three steps have finished. A step the session reports on uses its own
  estimate.
- **Measured vs. estimated.** The solid part of a bar is real progress:
  finished steps, or what the session reported. The pale part is a guess
  from elapsed time. Hover over a bar or any ⓘ for what it means.
- **Health in plain words.** *On track*, *Slower than usual* (twice the
  typical step), *Quiet* (no tool call for 3 minutes), *Needs you* (a
  permission prompt or question is waiting), *Paused* (turn over, steps
  left), *Failed*.
- **Background tasks.** Background shell commands, monitors and workflows
  get rows of their own, even outside any plan, with their latest output
  line and a warning when they go quiet.
- **Your other sessions,** each with its bar, health, ETA and current step.

## Steering from the pane

Open a row (▸) for its actions. Headway shows at most two, and only the ones
that fit what the row is doing:

| Row | When | Actions |
| --- | --- | --- |
| Step in progress | On track | Add context |
| | Quiet (no tool call for 3 min) | Status check · Add context |
| | Slower than usual | Wrap up · Add context |
| | Needs you | none: answer in the chat |
| Step not started | | Do next · Skip |
| Subagent | Working | Add context |
| | Quiet or slow | Status check · Stop |
| Background task | Running | Stop |
| | Failed or stopped | Retry |
| Another session | | Add context, plus Status check when it is quiet, slow or stale |

A note reaches a working session **before its next action**: Headway
attaches it to the next tool result, so the model can change course
mid-turn. When the session isn't working, the note arrives as a new message.
Other sessions get it as a message between sessions. The pane shows whether
each note is waiting, sent, or refused.

## How it works

Headway never asks the model for status. It watches what sessions already
do: their task lists (`update_plan` in the desktop app, `TodoWrite` in the
CLI), every tool call, subagent starts, and background tasks. It also gives
the model one cheap tool, `report_progress`, for the parts of a step, a rough
percent, minutes left and blockers, plus one line of system prompt asking it
to report when that helps.

Sessions share summaries through Headway's store (a JSON file under your
Claude config directory). Nothing leaves your machine.

## Limits

- Only sessions started after Headway is installed appear, and it can't
  see work from before it started.
- A plugin's stop is subject to your permission rules. If they refuse it,
  Headway asks the session to stop the task instead, and says so.
- Tooltips (ⓘ) need a pointer, so they show on desktop and in the IDE, not
  in the terminal.

## Developing

```bash
claude plugin validate .
claude plugin test .
```

Run them with a Claude Code build at least as new as the one the mod targets
(2.1.321); older builds refuse the hooks module. To run it from this folder
while you edit:

```bash
claude --plugin-dir .
```

## License

MIT
